/**
 * PCI Backend — server.js
 *
 * Endpoints:
 *   POST /api/register           — saves registrant + optional voter card image/PDF
 *   POST /api/check-image-clarity — runs server-side clarity check on an uploaded image
 *
 * Storage:
 *   Text data  → data/registrations.json
 *   Uploaded files → data/uploads/<id>-votercard.<ext>
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Directories ──────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOAD_DIR  = path.join(DATA_DIR, 'uploads');
const DATA_FILE   = path.join(DATA_DIR, 'registrations.json');

[DATA_DIR, UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), 'utf8');
}

// ─── Multer (file upload) ─────────────────────────────────────────────────────
// We store to disk so files survive server restarts.
// Filename = <timestamp-id>-votercard.<ext>  (no spaces, no path traversal)

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Sanitise original extension: only allow image or pdf
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
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10 MB max
    files: 1
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());

// Static files (HTML, images, CSS, JS) — served from project root
app.use(express.static(__dirname));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readRegistrations() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function writeRegistrations(records) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
}

function sanitise(str) {
  return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}

function isValidPhone(phone) {
  return /^[0-9+\s\-]{7,15}$/.test(phone.trim());
}

// ─── POST /api/register ───────────────────────────────────────────────────────
// Accepts multipart/form-data (because of optional file).
// Fields: name, dob, phone, lga, ward, address, hasVoterCard
// File  : voterCardFile (optional — only present when hasVoterCard === 'yes')

app.post('/api/register', upload.single('voterCardFile'), (req, res) => {
  const { name, dob, phone, lga, ward, address, hasVoterCard } = req.body || {};

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!name || !dob || !phone) {
    // Clean up any uploaded file if validation fails
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      success: false,
      message: 'Full name, date of birth, and phone number are required.'
    });
  }

  if (!isValidPhone(phone)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      success: false,
      message: 'Please enter a valid phone number.'
    });
  }

  if (!['yes', 'no'].includes(sanitise(hasVoterCard).toLowerCase())) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      success: false,
      message: "Please answer whether you have a voter's card."
    });
  }

  // ── Duplicate check ─────────────────────────────────────────────────────────
  const records   = readRegistrations();
  const cleanPhone = sanitise(phone);

  const duplicate = records.find(r => r.phone === cleanPhone);
  if (duplicate) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(409).json({
      success: false,
      message: 'This phone number is already registered.'
    });
  }

  // ── Build record ─────────────────────────────────────────────────────────────
  const record = {
    id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name:         sanitise(name),
    dob:          sanitise(dob),
    phone:        cleanPhone,
    lga:          sanitise(lga),
    ward:         sanitise(ward),
    address:      sanitise(address),
    hasVoterCard: sanitise(hasVoterCard).toLowerCase(),
    voterCardFile: req.file
      ? {
          filename:     req.file.filename,
          originalName: path.basename(req.file.originalname),   // strip any path
          mimetype:     req.file.mimetype,
          size:         req.file.size
        }
      : null,
    createdAt: new Date().toISOString()
  };

  records.push(record);
  writeRegistrations(records);

  const fileInfo = record.voterCardFile
    ? ` | card: ${record.voterCardFile.filename} (${(record.voterCardFile.size / 1024).toFixed(0)} KB)`
    : ' | no card uploaded';

  console.log(`[REGISTER] ${record.name} | ${record.phone} | ${record.lga || 'N/A'}${fileInfo} | ${record.createdAt}`);

  return res.status(201).json({
    success: true,
    message: 'Registration successful.',
    id: record.id
  });
});

// ─── POST /api/check-image-clarity ───────────────────────────────────────────
// Accepts a single image file in memory, checks basic file-level signals:
//   - File size (too small = likely corrupt or blank)
//   - JPEG/PNG header entropy (rough proxy for image content)
// For full pixel-level analysis the client already runs a Canvas Laplacian check.
// This endpoint acts as a server-side safety net.

const uploadTmp = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
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

// ─── Serve Uploaded Files Statically ──────────────────────────────────────────
app.use('/uploads', express.static(UPLOAD_DIR));

// ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────

// GET /api/admin/registrations — fetch all records sorted newest first
app.get('/api/admin/registrations', (_req, res) => {
  const records = readRegistrations();
  // Sort descending by createdAt
  const sorted = [...records].reverse();
  res.json({
    success: true,
    total: sorted.length,
    data: sorted
  });
});

// DELETE /api/admin/registrations/:id — delete a registration record + its file
app.delete('/api/admin/registrations/:id', (req, res) => {
  const { id } = req.params;
  let records = readRegistrations();
  const index = records.findIndex(r => r.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Record not found.' });
  }

  const [deletedRecord] = records.splice(index, 1);
  writeRegistrations(records);

  // If there was an uploaded file, delete it from disk
  if (deletedRecord.voterCardFile && deletedRecord.voterCardFile.filename) {
    const filePath = path.join(UPLOAD_DIR, deletedRecord.voterCardFile.filename);
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
  }

  console.log(`[DELETE] Registration ${id} (${deletedRecord.name}) removed by admin.`);

  return res.json({
    success: true,
    message: `Registration for ${deletedRecord.name} deleted successfully.`
  });
});

// ─── Multer error handler ─────────────────────────────────────────────────────
// Catches file-too-large, wrong mime type, etc. and returns a clean JSON error.
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum size is 10 MB.'
      : `Upload error: ${err.message}`;
    return res.status(400).json({ success: false, message: msg });
  }
  if (err && err.message) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
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
app.listen(PORT, () => {
  console.log(`\n🟢  PCI server running → http://localhost:${PORT}`);
  console.log(`   Admin Dashboard   → http://localhost:${PORT}/admin.html`);
  console.log(`   Uploads saved to   → ${UPLOAD_DIR}\n`);
});
