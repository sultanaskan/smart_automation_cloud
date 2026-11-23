'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');

const app = express();
const port = Number(process.env.UPLOAD_DEMO_PORT || 4175);
const scanDelayMs = Math.max(0, Number(process.env.UPLOAD_DEMO_SCAN_DELAY_MS || 2500));
const maxFileBytes = 500 * 1024;
const maxFilesPerSession = 4;
const sessions = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileBytes, files: 1, fields: 2 }
});

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const sessionId = String(req.body.sessionId || '');
  const slot = Number(req.body.slot);
  if (!/^[a-f0-9-]{36}$/i.test(sessionId) || !Number.isInteger(slot) || slot < 1 || slot > maxFilesPerSession) {
    return res.status(400).json({ error: 'Invalid upload session or file number.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Choose a PDF file first.' });

  const expectedSlot = sessions.get(sessionId) || 1;
  if (slot !== expectedSlot) {
    return res.status(409).json({ error: `The server expects file ${expectedSlot} next.` });
  }

  // Simulates a server-side scan. The browser receives no success result until it finishes.
  await new Promise(resolve => setTimeout(resolve, scanDelayMs));
  const isPdf = req.file.originalname.toLowerCase().endsWith('.pdf')
    && req.file.buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (!isPdf) return res.status(422).json({ error: 'Server scan failed: choose a valid PDF file.' });

  sessions.set(sessionId, slot + 1);
  if (sessions.size > 5000) sessions.clear();
  return res.json({
    ok: true,
    checkedBy: 'server',
    slot,
    filename: req.file.originalname,
    bytes: req.file.size,
    nextSlot: slot < maxFilesPerSession ? slot + 1 : null,
    message: `File ${slot} passed the server check.`
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'The file exceeds the 500 KB demo limit.' });
  }
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: 'The demo server could not check this file.' });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Sequential upload demo: http://127.0.0.1:${port}`);
  console.log(`Simulated server scan delay: ${scanDelayMs} ms; maximum files: ${maxFilesPerSession}`);
  console.log('Files are checked in memory and are not saved to disk.');
});
