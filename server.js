/**
 * PCI Backend — server.js
 *
 * Endpoints:
 *   POST /api/register           — saves registrant + optional voter card image/PDF
 *   POST /api/check-image-clarity — runs server-side clarity check on an uploaded image
 *
 * Storage:
 *   Local development → data/registrations.json and data/uploads/
 *   Vercel             → Neon Postgres and private Vercel Blob
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const crypto  = require('crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { neon } = require('@neondatabase/serverless');
const { del, get, put } = require('@vercel/blob');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const MAX_UPLOAD_BYTES = IS_VERCEL ? 4 * 1024 * 1024 : 10 * 1024 * 1024;

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
}

// ─── Multer (file upload) ─────────────────────────────────────────────────────
// Vercel uploads are buffered in memory before being sent to private Blob storage.

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const allowedExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = allowedExt.includes(ext) ? ext : '.bin';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cb(null, `${id}-votercard${safeExt}`);
  }
});

function fileFilter(_req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                   'image/heic', 'image/heif', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only images (jpg, png, gif, webp, heic) and PDF files are accepted.'));
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
app.use(cors());

// Static files (HTML, images, CSS, JS) — served from project root
app.use('/data', (_req, res) => res.sendStatus(404));
app.use(express.static(__dirname));

// ─── Helpers ──────────────────────────────────────────────────────────────────
let sqlClient;
let schemaReady;

function getDatabase() {
  if (!process.env.DATABASE_URL) {
    const error = new Error('Registration database is not configured. Add DATABASE_URL in Vercel project settings.');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

async function ensureDatabaseSchema() {
  if (!schemaReady) {
    schemaReady = getDatabase()`
      CREATE TABLE IF NOT EXISTS pci_registrations (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      )
    `.catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function readRegistrations() {
  if (IS_VERCEL) {
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
  if (IS_VERCEL) {
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
  if (IS_VERCEL) {
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
  if (IS_VERCEL) {
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
// Accepts multipart/form-data (because of optional file).
// Fields: name, phone, lga, ward, address, reference, hasVoterCard
// File  : voterCardFile (required — scan or upload)

app.post('/api/register', upload.single('voterCardFile'), async (req, res) => {
  const { name, phone, lga, ward, address, reference, hasVoterCard } = req.body || {};
  let fileInfo = null;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!name || !phone) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Full name and phone number are required.'
    });
  }

  if (!isValidPhone(phone)) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid phone number.'
    });
  }

  const cleanReference = sanitise(reference);
  if (cleanReference && !/^[A-Za-z0-9 -]{1,40}$/.test(cleanReference)) {
    await discardRequestUpload(req.file);
    return res.status(400).json({
      success: false,
      message: 'Reference can contain letters, numbers, spaces, and hyphens only.'
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
    if (req.file && IS_VERCEL) {
      if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
        const error = new Error('Private Vercel Blob storage is not configured for uploads.');
        error.code = 'STORAGE_NOT_CONFIGURED';
        throw error;
      }

      const allowedExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.pdf'];
      const originalExt = path.extname(req.file.originalname).toLowerCase();
      const extension = allowedExt.includes(originalExt) ? originalExt : '.bin';
      const blob = await put(`${recordId}-votercard${extension}`, req.file.buffer, {
        access: 'private',
        contentType: req.file.mimetype,
        addRandomSuffix: true
      });

      fileInfo = {
        filename: blob.pathname,
        pathname: blob.pathname,
        storage: 'vercel-blob',
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
      lga: sanitise(lga),
      ward: sanitise(ward),
      address: sanitise(address),
      reference: cleanReference,
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
    if (fileInfo && fileInfo.storage === 'vercel-blob') {
      try {
        await removeUploadedFile(fileInfo);
      } catch (cleanupError) {
        console.error('[BLOB CLEANUP ERROR]', cleanupError);
      }
    }
    return sendStorageError(res, error);
  }
});

// ─── POST /api/check-image-clarity ───────────────────────────────────────────
// Accepts a single image file in memory, checks basic file-level signals:
//   - File size (too small = likely corrupt or blank)
//   - JPEG/PNG header entropy (rough proxy for image content)
// For full pixel-level analysis the client already runs a Canvas Laplacian check.
// This endpoint acts as a server-side safety net.

const uploadTmp = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter
});

app.post('/api/check-image-clarity', uploadTmp.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image provided.' });
  }

  // PDFs — always accept, skip pixel analysis
  if (req.file.mimetype === 'application/pdf') {
    return res.json({ success: true, clear: true, score: 100,
      message: 'PDF accepted.' });
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
      data: IS_VERCEL ? records : [...records].reverse()
    });
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

    if (IS_VERCEL) {
      if (!fileInfo.pathname) {
        return res.status(404).json({ success: false, message: 'File not found.' });
      }
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
      ? `File is too large. Maximum size is ${IS_VERCEL ? '4 MB on Vercel' : '10 MB'}.`
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
