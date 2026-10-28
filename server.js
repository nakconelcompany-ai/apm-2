/**
 * PCI Backend — server.js
 *
 * Endpoints:
 *   POST /api/register           — saves registrant + required voter card image
 *   POST /api/check-image-clarity — runs server-side clarity check on an uploaded image
 *
 * Storage:
 *   Local development → Neon Postgres when DATABASE_URL is set, otherwise JSON; uploads use disk
 *   Vercel             → Neon Postgres and private Neon Object Storage
 */

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const crypto  = require('crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { neon } = require('@neondatabase/serverless');
const { del, get } = require('@vercel/blob');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const USE_NEON_DATABASE = IS_VERCEL || Boolean(process.env.DATABASE_URL);
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

// ─── Directories ──────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOAD_DIR  = path.join(DATA_DIR, 'uploads');
const DATA_FILE   = path.join(DATA_DIR, 'registrations.json');

if (!IS_VERCEL) {
  [DATA_DIR, UPLOAD_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), 'utf8');
  }

  const registrations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  let removedLegacyDob = false;
  const cleanedRegistrations = registrations.map(record => {
    if (!Object.prototype.hasOwnProperty.call(record, 'dob')) return record;
    removedLegacyDob = true;
    const { dob, ...cleanRecord } = record;
    return cleanRecord;
  });
  if (removedLegacyDob) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cleanedRegistrations, null, 2), 'utf8');
  }
}

// ─── Multer (file upload) ─────────────────────────────────────────────────────
// Vercel uploads are buffered in memory before being sent to private object storage.

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const allowedExt = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = allowedExt.includes(ext) ? ext : '.bin';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cb(null, `${id}-votercard${safeExt}`);
  }
});

function fileFilter(_req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Upload a JPG, PNG, or WebP image of your voter card. PDF files are converted to images before upload.'));
  }
}

const upload = multer({
  storage: IS_VERCEL ? multer.memoryStorage() : diskStorage,
  fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});

// Static files (HTML, images, CSS, JS) — served from project root
app.use('/data', (_req, res) => res.sendStatus(404));
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor')));
app.use(express.static(__dirname));

// ─── Helpers ──────────────────────────────────────────────────────────────────
let sqlClient;
let schemaReady;
let objectStorageClient;

function getObjectStorage() {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION, NEON_STORAGE_BUCKET } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_ENDPOINT_URL_S3 || !AWS_REGION || !NEON_STORAGE_BUCKET) {
    const error = new Error('Neon Object Storage is not configured. Set its endpoint, credentials, region, and bucket.');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  if (!objectStorageClient) {
    objectStorageClient = new S3Client({
      region: AWS_REGION,
      endpoint: AWS_ENDPOINT_URL_S3,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY
      },
      forcePathStyle: true
    });
  }
  return { client: objectStorageClient, bucket: NEON_STORAGE_BUCKET };
}

function getDatabase() {
  if (!process.env.DATABASE_URL) {
    const error = new Error('Registration database is not configured. Add DATABASE_URL in Vercel project settings.');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function getAccountEncryptionKey() {
  const key = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) {
    const error = new Error('Secure account storage is not configured. Set ACCOUNT_ENCRYPTION_KEY in the deployment environment.');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  return Buffer.from(key, 'hex');
}

function encryptAccountNumber(accountNumber) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getAccountEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex')
  };
}

function decryptAccountNumber(encrypted) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getAccountEncryptionKey(),
    Buffer.from(encrypted.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

async function ensureDatabaseSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getDatabase();
      await sql`
        CREATE TABLE IF NOT EXISTS pci_registrations (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL,
          data JSONB NOT NULL
        )
      `;
      await sql`
        UPDATE pci_registrations
        SET data = data - 'dob'
        WHERE data ? 'dob'
      `;
    })().catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function readRegistrations() {
  if (USE_NEON_DATABASE) {
    await ensureDatabaseSchema();
    const sql = getDatabase();
    const rows = await sql`
      SELECT data FROM pci_registrations ORDER BY created_at DESC
    `;
    return rows.map(row => row.data);
  }

  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function saveRegistration(record) {
  if (USE_NEON_DATABASE) {
    await ensureDatabaseSchema();
    const sql = getDatabase();
    const rows = await sql`
      INSERT INTO pci_registrations (id, phone, created_at, data)
      VALUES (${record.id}, ${record.phone}, ${record.createdAt}, ${JSON.stringify(record)}::jsonb)
      ON CONFLICT (phone) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }

  const records = await readRegistrations();
  if (records.some(existing => existing.phone === record.phone)) return false;
  records.push(record);
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
  return true;
}

async function deleteRegistration(id) {
  if (USE_NEON_DATABASE) {
    await ensureDatabaseSchema();
    const sql = getDatabase();
    const rows = await sql`
      DELETE FROM pci_registrations WHERE id = ${id} RETURNING data
    `;
    return rows[0]?.data || null;
  }

  const records = await readRegistrations();
  const index = records.findIndex(record => record.id === id);
  if (index === -1) return null;
  const [record] = records.splice(index, 1);
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
  return record;
}

async function findRegistration(id) {
  if (USE_NEON_DATABASE) {
    await ensureDatabaseSchema();
    const sql = getDatabase();
    const rows = await sql`
      SELECT data FROM pci_registrations WHERE id = ${id} LIMIT 1
    `;
    return rows[0]?.data || null;
  }

  const records = await readRegistrations();
  return records.find(record => record.id === id) || null;
}

function getStorageErrorStatus(error) {
  return error.code === 'STORAGE_NOT_CONFIGURED' ? 503 : 500;
}

function sendStorageError(res, error) {
  if (res.headersSent) {
    console.error('[STORAGE STREAM ERROR]', error);
    res.destroy(error);
    return;
  }
  if (getStorageErrorStatus(error) === 503) {
    return res.status(503).json({ success: false, message: error.message });
  }
  console.error('[STORAGE ERROR]', error);
  return res.status(500).json({ success: false, message: 'Storage operation failed. Please try again.' });
}

async function removeUploadedFile(fileInfo) {
  if (!fileInfo) return;
  if (fileInfo.storage === 'neon-object-storage' && fileInfo.key) {
    const { client, bucket } = getObjectStorage();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fileInfo.key }));
    return;
  }
  if (fileInfo.storage === 'vercel-blob' && fileInfo.pathname) {
    await del(fileInfo.pathname, { access: 'private' });
    return;
  }
  if (fileInfo.filename) {
    const filePath = path.join(UPLOAD_DIR, path.basename(fileInfo.filename));
    if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
  }
}

async function discardRequestUpload(file) {
  if (file && file.path && fs.existsSync(file.path)) {
    try {
      await fs.promises.unlink(file.path);
    } catch (error) {
      console.error('[UPLOAD CLEANUP ERROR]', error);
    }
  }
}

function sanitise(str) {
  return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}

function isValidPhone(phone) {
  return /^[0-9+\s\-]{7,15}$/.test(phone.trim());
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function getImageMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function isValidVoterCardImage(file, buffer = file && file.buffer) {
  return Boolean(file && buffer && file.size <= MAX_UPLOAD_BYTES &&
    getImageMimeType(buffer) === file.mimetype);
}

function adminAuth(req, res, next) {
  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedUsername || !expectedPassword) {
    return res.status(503).json({
      success: false,
      message: 'Admin access is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in the deployment environment.'
    });
  }

  const providedUsername = req.get('x-admin-username') || '';
  const authorization = req.get('authorization') || '';
  const providedPassword = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const usernameMatches = constantTimeEqual(expectedUsername, providedUsername);
  const passwordMatches = constantTimeEqual(expectedPassword, providedPassword);

  if (!usernameMatches || !passwordMatches) {
    return res.status(401).json({ success: false, message: 'Invalid admin username or password.' });
  }

  next();
}

function constantTimeEqual(expected, provided) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

// ─── POST /api/register ───────────────────────────────────────────────────────
// Accepts multipart/form-data with a required, size-limited voter card image.
// Fields: name, phone, email, accountNumber, accountName, bankName, ward, unit, lga, hasVoterCard
// File  : voterCardFile (required — scan or upload)

app.post('/api/register', upload.single('voterCardFile'), async (req, res) => {
  const { name, phone, email, accountNumber, accountName, bankName, ward, unit, lga, hasVoterCard } = req.body || {};
  let fileInfo = null;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!name || !phone || !email || !accountNumber || !accountName || !bankName || !lga) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Please complete all required registration details.'
    });
  }

  if (!isValidPhone(phone)) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid phone number.'
    });
  }

  const cleanEmail = sanitise(email).toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid email address.'
    });
  }

  const cleanAccountNumber = String(accountNumber).trim();
  if (!/^\d{10}$/.test(cleanAccountNumber)) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid 10-digit account number.'
    });
  }

  if (sanitise(hasVoterCard).toLowerCase() !== 'yes' || !req.file) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: "Please scan or upload your voter's card."
    });
  }

  const cleanPhone = sanitise(phone);
  const recordId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  try {
    const imageBuffer = req.file.buffer || await fs.promises.readFile(req.file.path);
    if (!isValidVoterCardImage(req.file, imageBuffer)) {
      await discardRequestUpload(req.file);
      return res.status(400).json({
        success: false,
        message: 'The uploaded file is not a supported voter-card image. Please upload a valid JPG, PNG, or WebP image no larger than 3 MB.'
      });
    }
    const encryptedAccountNumber = encryptAccountNumber(cleanAccountNumber);

    if (IS_VERCEL) {
      const { client, bucket } = getObjectStorage();

      const allowedExt = ['.jpg', '.jpeg', '.png', '.webp'];
      const originalExt = path.extname(req.file.originalname).toLowerCase();
      const extension = allowedExt.includes(originalExt) ? originalExt : '.bin';
      const key = `${recordId}/votercard${extension}`;
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ContentDisposition: 'attachment'
      }));

      fileInfo = {
        filename: key,
        key,
        storage: 'neon-object-storage',
        originalName: path.basename(req.file.originalname),
        mimetype: req.file.mimetype,
        size: req.file.size
      };
    } else if (req.file) {
      fileInfo = {
        filename: req.file.filename,
        originalName: path.basename(req.file.originalname),
        mimetype: req.file.mimetype,
        size: req.file.size
      };
    }

    const record = {
      id: recordId,
      name: sanitise(name),
      phone: cleanPhone,
      email: cleanEmail,
      accountNumberEncrypted: encryptedAccountNumber,
      accountNumberLast4: cleanAccountNumber.slice(-4),
      accountName: sanitise(accountName),
      bankName: sanitise(bankName),
      ward: sanitise(ward),
      unit: sanitise(unit),
      lga: sanitise(lga),
      hasVoterCard: sanitise(hasVoterCard).toLowerCase(),
      voterCardFile: fileInfo,
      createdAt: new Date().toISOString()
    };

    if (!await saveRegistration(record)) {
      await removeUploadedFile(fileInfo);
      await discardRequestUpload(req.file);
      return res.status(409).json({
        success: false,
        message: 'This phone number is already registered.'
      });
    }

    const fileDescription = fileInfo
      ? ` | card uploaded (${(fileInfo.size / 1024).toFixed(0)} KB)`
      : ' | no card uploaded';

    console.log(`[REGISTER] ${record.id}${fileDescription} | ${record.createdAt}`);

    return res.status(201).json({
      success: true,
      message: 'Registration successful.',
      id: record.id
    });
  } catch (error) {
    await discardRequestUpload(req.file);
    if (fileInfo && (fileInfo.storage === 'neon-object-storage' || fileInfo.storage === 'vercel-blob')) {
      try {
        await removeUploadedFile(fileInfo);
      } catch (cleanupError) {
        console.error('[UPLOAD CLEANUP ERROR]', cleanupError);
      }
    }
    return sendStorageError(res, error);
  }
});

// ─── POST /api/check-image-clarity ───────────────────────────────────────────
// Accepts a single image file in memory and checks basic file-level signals.

const uploadTmp = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter
});

app.post('/api/check-image-clarity', uploadTmp.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image provided.' });
  }

  if (!isValidVoterCardImage(req.file)) {
    return res.status(400).json({
      success: false,
      clear: false,
      message: 'The uploaded file is not a supported JPG, PNG, or WebP image.'
    });
  }

  const buf  = req.file.buffer;
  const size = buf.length;

  // Gate 1: suspiciously small file → likely blank or corrupt
  if (size < 5000) {
    return res.json({ success: true, clear: false, score: 0,
      message: "Image file is too small to be a readable voter's card. Please upload a proper photo." });
  }

  // Gate 2: sample byte entropy of the image body.
  // A real photo has high entropy; a blank/solid-colour image is very low.
  // We sample the middle 4 KB of the file for speed.
  const start  = Math.floor(buf.length / 2);
  const sample = buf.slice(start, start + 4096);
  const freq   = new Array(256).fill(0);
  for (let i = 0; i < sample.length; i++) freq[sample[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const p = freq[i] / sample.length;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  // Natural photos have entropy ~7–8 bits; solid colours are <3
  const ENTROPY_THRESHOLD = 4.5;

  if (entropy < ENTROPY_THRESHOLD) {
    return res.json({ success: true, clear: false, score: Math.round(entropy * 10),
      message: "The image appears to be blank or very low quality. Please upload a clear photo of your voter's card." });
  }

  return res.json({ success: true, clear: true, score: Math.round(entropy * 10),
    message: 'Image looks good.' });
});

// ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/api/admin/auth-mode', (_req, res) => {
  res.json({
    configured: Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD)
  });
});

app.use('/api/admin', adminAuth);

// GET /api/admin/registrations — fetch all records sorted newest first
app.get('/api/admin/registrations', async (_req, res) => {
  try {
    const records = await readRegistrations();
    return res.json({
      success: true,
      total: records.length,
      data: (USE_NEON_DATABASE ? records : [...records].reverse()).map(({ accountNumberEncrypted, dob, ...record }) => record)
    });
  } catch (error) {
    return sendStorageError(res, error);
  }
});

app.get('/api/admin/registrations/:id', async (req, res) => {
  try {
    const record = await findRegistration(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: 'Record not found.' });
    const accountNumber = record.accountNumberEncrypted
      ? decryptAccountNumber(record.accountNumberEncrypted)
      : '';
    const { accountNumberEncrypted, dob, ...details } = record;
    return res.json({ success: true, data: { ...details, accountNumber } });
  } catch (error) {
    return sendStorageError(res, error);
  }
});

// DELETE /api/admin/registrations/:id — delete a registration record + its file
app.delete('/api/admin/registrations/:id', async (req, res) => {
  try {
    const deletedRecord = await deleteRegistration(req.params.id);
    if (!deletedRecord) {
      return res.status(404).json({ success: false, message: 'Record not found.' });
    }

    await removeUploadedFile(deletedRecord.voterCardFile);
    console.log(`[DELETE] Registration ${req.params.id} removed by admin.`);

    return res.json({
      success: true,
      message: `Registration for ${deletedRecord.name} deleted successfully.`
    });
  } catch (error) {
    return sendStorageError(res, error);
  }
});

app.get('/api/admin/registrations/:id/file', async (req, res) => {
  try {
    const record = await findRegistration(req.params.id);
    const fileInfo = record && record.voterCardFile;
    if (!fileInfo) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', fileInfo.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileInfo.originalName || 'voter-card')}`);

    if (fileInfo.storage === 'neon-object-storage' && fileInfo.key) {
      const { client, bucket } = getObjectStorage();
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fileInfo.key }));
      if (!object.Body) {
        return res.status(404).json({ success: false, message: 'File not found.' });
      }
      res.setHeader('Content-Type', object.ContentType || fileInfo.mimetype || 'application/octet-stream');
      return await pipeline(object.Body, res);
    }

    if (IS_VERCEL && fileInfo.storage === 'vercel-blob' && fileInfo.pathname) {
      const blob = await get(fileInfo.pathname, { access: 'private' });
      if (!blob || blob.statusCode !== 200) {
        return res.status(404).json({ success: false, message: 'File not found.' });
      }
      res.setHeader('Content-Type', blob.blob.contentType || fileInfo.mimetype || 'application/octet-stream');
      return await pipeline(Readable.fromWeb(blob.stream), res);
    }

    if (!fileInfo.filename || path.basename(fileInfo.filename) !== fileInfo.filename) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }
    return res.sendFile(path.join(UPLOAD_DIR, fileInfo.filename));
  } catch (error) {
    return sendStorageError(res, error);
  }
});

// ─── Multer error handler ─────────────────────────────────────────────────────
// Catches file-too-large, wrong mime type, etc. and returns a clean JSON error.
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum size is 3 MB.'
      : `Upload error: ${err.message}`;
    return res.status(400).json({ success: false, message: msg });
  }
  if (err && err.message) {
    return res.status(400).json({ success: false, message: err.message });
  }
  console.error('[REQUEST ERROR]', err);
  if (res.headersSent) return res.destroy(err);
  return res.status(500).json({ success: false, message: 'An unexpected server error occurred.' });
});

// ─── Admin Page Direct Route ──────────────────────────────────────────────────
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─── Fallback ────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🟢  PCI server running → http://localhost:${PORT}`);
    console.log(`   Admin Dashboard   → http://localhost:${PORT}/admin`);
    console.log(`   Uploads saved to   → ${IS_VERCEL ? 'private Vercel Blob' : UPLOAD_DIR}\n`);
  });
}

module.exports = app;
