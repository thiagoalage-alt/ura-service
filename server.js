require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3050;

const OUTPUTS_DIR = process.env.OUTPUTS_DIR || path.join(__dirname, 'outputs');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const STATIC_PREFIX = process.env.STATIC_PREFIX || '/ura';
const PYTHON = process.env.PYTHON_BIN || 'python3';
const PY_TTS = process.env.PYTHON_TTS_SCRIPT || path.join(__dirname, 'scripts', 'tts_generator.py');
const PY_PROC = path.join(__dirname, 'scripts', 'audio_processor.py');
const VOICES_FILE = process.env.VOICES_FILE || path.join(__dirname, 'voices.json');
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const GLOBAL_DATA_DIR = path.join(__dirname, '..', 'data', 'voices_sample');

[OUTPUTS_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
// Garante a existência do diretório global de amostras
if (!fs.existsSync(GLOBAL_DATA_DIR)) fs.mkdirSync(GLOBAL_DATA_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /audio\/(mpeg|wav|ogg|mp4)|application\/octet-stream/.test(file.mimetype)
      || /\.(mp3|wav|ogg|m4a)$/i.test(file.originalname);
    cb(null, ok);
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use(`${STATIC_PREFIX}/outputs`, express.static(OUTPUTS_DIR));
app.use(`${STATIC_PREFIX}/samples`, express.static(GLOBAL_DATA_DIR));
if (fs.existsSync(FRONTEND_DIR)) app.use(STATIC_PREFIX, express.static(FRONTEND_DIR));

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const safe = s => String(s || '').replace(/[^a-z0-9_\-\.]/gi, '_');
function intDate() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function tail(s, n = 30) { return (s || '').trim().split(/\r?\n/).slice(-n).join('\n'); }
function parseOut(stdout) {
  const r = {};
  (stdout || '').split(/\r?\n/).forEach(l => { const m = l.match(/^(\w+)=(.+)$/); if (m) r[m[1]] = m[2].trim(); });
  return r;
}
function runPy(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [args[0], ...args.slice(1)], { cwd: cwd || path.dirname(args[0]) });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get(`${STATIC_PREFIX}/status`, (_req, res) =>
  res.json({ status: 'ok', version: '2.1.0', timestamp: new Date().toISOString() }));

app.get(`${STATIC_PREFIX}/connectivity`, (_req, res) => {
  dns.lookup('edge.microsoft.com', { timeout: 3000 }, err => {
    if (err) return res.json({ online: false, engine: 'gtts', label: 'Offline — Modo Local (TTS)', color: 'warning' });
    res.json({ online: true, engine: 'edge-tts', label: 'Online — Vozes Neurais (IA)', color: 'success' });
  });
});

app.get(`${STATIC_PREFIX}/samples-health`, (_req, res) => {
  try {
    const samplesExist = fs.existsSync(GLOBAL_DATA_DIR);
    const files = samplesExist ? fs.readdirSync(GLOBAL_DATA_DIR).filter(f => f.endsWith('.mp3')) : [];
    return res.json({
      status: samplesExist ? 'active' : 'missing_directory',
      path_resolved: GLOBAL_DATA_DIR,
      samples_count: files.length,
      samples_available: files
    });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao ler status das amostras de vozes.', details: e.message });
  }
});

app.get(`${STATIC_PREFIX}/voices`, (_req, res) => {
  try {
    if (fs.existsSync(VOICES_FILE)) {
      const d = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf-8'));
      return res.json({ voices: d.voices || d || [] });
    }
  } catch (e) { console.error('[voices]', e.message); }
  res.json({ voices: [] });
});

app.post(`${STATIC_PREFIX}/generate`, async (req, res) => {
  const { text, voice, rate, pitch } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Campo "text" obrigatório.' });
  if (!fs.existsSync(PY_TTS)) return res.status(501).json({ error: `Script não encontrado: ${PY_TTS}` });

  const filename = safe(`${intDate()}_${voice || 'default'}_${uuidv4()}.mp3`);
  const outPath = path.join(OUTPUTS_DIR, filename);
  const { code, out, err } = await runPy([
    PY_TTS, '--text', text,
    '--voice', String(voice || 'pt-BR-FranciscaNeural'),
    '--rate', String(rate || '+0%'),
    '--pitch', String(pitch || '+0Hz'),
    '--out', outPath,
  ]).catch(e => ({ code: -1, out: '', err: e.message }));

  const parsed = parseOut(out);
  const actual = parsed.out || outPath;
  const fname = path.basename(actual);

  if (code === 0 && fs.existsSync(actual)) {
    const url = `${req.protocol}://${req.get('host')}${STATIC_PREFIX}/download/${encodeURIComponent(fname)}`;
    return res.json({ url, filename: fname, engine: parsed.engine || 'unknown' });
  }
  res.status(500).json({ error: 'Falha na geração.', stdout: tail(out), stderr: tail(err) });
});

app.post(`${STATIC_PREFIX}/upload-music`, upload.single('music'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const ext = path.extname(req.file.originalname) || '.mp3';
  const dest = req.file.path + ext;
  fs.renameSync(req.file.path, dest);
  res.json({ music_id: path.basename(dest), original: req.file.originalname });
});

app.post(`${STATIC_PREFIX}/process`, async (req, res) => {
  const { input_filename, music_id, eq, reverb, reverb_decay, music_vol, format, music_start, music_duration } = req.body || {};
  if (!input_filename) return res.status(400).json({ error: 'input_filename obrigatório.' });

  const inputPath = path.join(OUTPUTS_DIR, safe(input_filename));
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Arquivo de entrada não encontrado.' });

  const ext = format === 'mp3' ? '.mp3' : '.wav';
  const outName = safe(`proc_${intDate()}_${uuidv4()}${ext}`);
  const outPath = path.join(OUTPUTS_DIR, outName);
  const musicPath = music_id ? path.join(UPLOADS_DIR, safe(music_id)) : '';

  const args = [
    PY_PROC,
    '--input', inputPath,
    '--output', outPath,
    '--eq', JSON.stringify(eq || {}),
    '--reverb', String(reverb || 0),
    '--reverb-decay', String(reverb_decay || 0.5),
    '--music-vol', String(music_vol || 0.3),
    '--music-start', String(music_start || 0),
    '--music-duration', String(music_duration || 0),
    '--format', ['wav16k', 'wav8k8bit'].includes(format) ? format : 'mp3',
  ];
  if (musicPath && fs.existsSync(musicPath)) args.push('--music', musicPath);

  const { code, out, err } = await runPy(args).catch(e => ({ code: -1, out: '', err: e.message }));
  const parsed = parseOut(out);
  const actual = parsed.out || outPath;
  const fname = path.basename(actual);

  if (code === 0 && fs.existsSync(actual)) {
    const url = `${req.protocol}://${req.get('host')}${STATIC_PREFIX}/download/${encodeURIComponent(fname)}`;
    return res.json({ url, filename: fname, format: parsed.format });
  }
  res.status(500).json({ error: 'Falha no processamento.', stdout: tail(out), stderr: tail(err) });
});

app.get(`${STATIC_PREFIX}/download/:filename`, (req, res) => {
  const fname = safe(req.params.filename || '');
  const fpath = path.join(OUTPUTS_DIR, fname);
  if (!fname || !fs.existsSync(fpath)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  const ct = fname.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
  res.setHeader('Content-Type', ct);
  res.download(fpath, fname);
});

app.get(`${STATIC_PREFIX}/*`, (req, res, next) => {
  const knownPaths = ['/status', '/voices', '/generate', '/download', '/connectivity', '/process', '/upload-music', '/outputs', '/samples-health', '/samples'];
  if (knownPaths.some(p => req.path.startsWith(`${STATIC_PREFIX}${p}`))) return next();
  const idx = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  next();
});

app.listen(PORT, () => {
  console.log(`\n🎙️  URA +Inteligente v2.1  →  http://localhost:${PORT}${STATIC_PREFIX}/\n`);
});
