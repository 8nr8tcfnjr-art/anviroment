const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 600);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 6 * 60 * 60 * 1000);

app.use(cors({ origin: ALLOW_ORIGIN === '*' ? true : ALLOW_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

const root = path.join(os.tmpdir(), 'okruzhenie-render');
fs.mkdirSync(root, { recursive: true });
const jobs = new Map();

const upload = multer({
  dest: root,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

function safeId() { return crypto.randomBytes(10).toString('hex'); }
function safeName(name) { return String(name || 'okruzhenie').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function qualityCrf(v) {
  const n = Number(v);
  return [14,17,20].includes(n) ? n : 17;
}

function ffmpegProgress(line, durationSec) {
  const m = line.match(/out_time_ms=(\d+)/);
  if (!m || !durationSec) return null;
  const seconds = Number(m[1]) / 1000000;
  return clamp(seconds / durationSec * 100, 0, 100);
}

async function cleanupJob(job) {
  try { if (job.input) await fsp.rm(job.input, { force: true }); } catch {}
  try { if (job.output) await fsp.rm(job.output, { force: true }); } catch {}
}

async function runEncode(job, meta) {
  job.status = 'encoding';
  job.stage = 'encoding';
  job.message = 'Кодировка H.264 + AAC';
  job.progress = 0;

  const width = clamp(Number(meta.width) || 1920, 320, 3840);
  const height = clamp(Number(meta.height) || 1080, 240, 2160);
  const fps = [30,60].includes(Number(meta.fps)) ? Number(meta.fps) : 30;
  const crf = qualityCrf(meta.crf);
  const duration = Math.max(1, Number(meta.duration) || 8);
  const base = safeName(meta.filename || 'okruzhenie')
    .replace(/\.mp4$/i, '') || 'okruzhenie';
  job.filename = `${base}.mp4`;
  job.output = path.join(root, `${job.id}.mp4`);

  const args = [
    '-hide_banner','-loglevel','error','-y',
    '-i',job.input,
    '-vf',`scale=${width}:${height}:flags=lanczos,fps=${fps}`,
    '-c:v','libx264','-preset', process.env.X264_PRESET || 'medium',
    '-crf',String(crf),'-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','320k','-ar','48000','-ac','2',
    '-movflags','+faststart',
    '-progress','pipe:1','-nostats',
    job.output
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore','pipe','pipe'] });
    job.pid = p.pid;
    let stderr = '';
    p.stdout.on('data', buf => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        const pct = ffmpegProgress(line, duration);
        if (pct != null) job.progress = Math.round(pct * 10) / 10;
      }
    });
    p.stderr.on('data', buf => { stderr += buf.toString(); if (stderr.length > 10000) stderr = stderr.slice(-10000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited with ${code}`)));
    job.cancel = () => { try { p.kill('SIGTERM'); } catch {} };
  });

  job.status = 'done';
  job.stage = 'done';
  job.progress = 100;
  job.message = 'MP4 готов';
  job.completedAt = Date.now();
}

app.get('/health', (req,res) => res.json({ ok:true, service:'okruzhenie-render-server', ffmpeg:!!ffmpegPath }));

app.post('/api/render', upload.single('video'), async (req,res) => {
  if (!req.file) return res.status(400).json({ error:'video is required' });
  let meta = {};
  try { meta = JSON.parse(req.body.meta || '{}'); } catch { meta = {}; }
  const id = safeId();
  const job = {
    id, status:'queued', stage:'queued', progress:0,
    message:'Рендер поставлен в очередь', input:req.file.path,
    createdAt:Date.now(), filename:'okruzhenie.mp4'
  };
  jobs.set(id, job);
  res.status(202).json({ jobId:id, status:job.status });

  // One encode at a time keeps a small server from running out of RAM/CPU.
  const run = async () => {
    while ([...jobs.values()].some(j => j.status === 'encoding' && j.id !== id)) await new Promise(r => setTimeout(r, 500));
    try { await runEncode(job, meta); }
    catch (e) { job.status='error'; job.stage='error'; job.error=e.message; job.message='Рендер не удался'; }
  };
  run();
});

app.get('/api/render/:id', (req,res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error:'job not found' });
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    jobId:job.id,status:job.status,stage:job.stage,progress:job.progress,
    message:job.message,filename:job.filename,
    eta: job.status==='encoding' && job.progress>0 ? Math.max(0, Math.round((100-job.progress)/Math.max(job.progress,1)))+'%' : '',
    fileUrl: job.status==='done' ? `${base}/api/render/${job.id}/file` : null,
    error:job.error || null
  });
});

app.get('/api/render/:id/file', async (req,res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.output) return res.status(404).json({ error:'file not ready' });
  if (!fs.existsSync(job.output)) return res.status(404).json({ error:'file missing' });
  res.download(job.output, job.filename || 'okruzhenie.mp4');
});

app.delete('/api/render/:id', async (req,res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error:'job not found' });
  if (job.status === 'encoding' && job.cancel) job.cancel();
  job.status='error'; job.stage='cancelled'; job.error='Cancelled';
  await cleanupJob(job);
  jobs.delete(job.id);
  res.json({ ok:true });
});

setInterval(async () => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id,job] of jobs) {
    if ((job.completedAt || job.createdAt) < cutoff && job.status !== 'encoding') {
      await cleanupJob(job); jobs.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`ОКРУЖЕНИЕ render server listening on :${PORT}`));
