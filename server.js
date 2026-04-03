// Islamic Shorts Automation - server.js
'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs/promises');
const crypto  = require('crypto');
const { spawn, execSync } = require('child_process');

const app    = express();
const PORT   = process.env.PORT || 3000;
const ROOT   = __dirname;
const DATA   = path.join(ROOT, 'data');
const TMP    = path.join(ROOT, 'tmp');
const PUBLIC = path.join(ROOT, 'public');
const FONTS  = path.join(ROOT, 'fonts');

// ── helpers ────────────────────────────────────────────────────────────────
const uid  = () => crypto.randomBytes(6).toString('hex');
const now  = () => new Date().toISOString();
const safe = v => v ? String(v).slice(0,4)+'••••' : '';

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file,'utf8')); } catch { return JSON.parse(JSON.stringify(fallback)); }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file),{recursive:true});
  const tmp = file+'.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data,null,2), 'utf8');
  await fsp.rename(tmp, file);
}

// ── config/queue ───────────────────────────────────────────────────────────
const CFG_FILE   = path.join(DATA, 'config.json');
const QUEUE_FILE = path.join(DATA, 'queue.json');

const DEFAULT_CFG = {
  googleClientId:'', googleClientSecret:'',
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${PORT}`,
  openRouterApiKey:'', pexelsApiKey:'',
  driveVideoFolderId:'', driveAudioFolderId:'',
  schedule:{ enabled:false, slots:[] },
  tokens:{ drive:null, youtube:null },
  channelName:'',
};
const DEFAULT_Q = { rows:[], idx:0, usedVideo:[], usedAudio:[] };

async function loadCfg()  { return { ...DEFAULT_CFG, ...(await readJson(CFG_FILE, DEFAULT_CFG)) }; }
async function saveCfg(p) { const c = { ...(await loadCfg()), ...p }; await writeJson(CFG_FILE, c); return c; }
async function loadQ()    { return { ...DEFAULT_Q, ...(await readJson(QUEUE_FILE, DEFAULT_Q)) }; }
async function saveQ(q)   { await writeJson(QUEUE_FILE, q); }

// ── SSE log ────────────────────────────────────────────────────────────────
const sseClients = new Set();
const logBuffer  = [];

function log(type, msg) {
  const entry = { ts: now(), type, msg };
  logBuffer.push(entry);
  if (logBuffer.length > 600) logBuffer.shift();
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
  }
  console.log(`[${entry.ts}] [${type.toUpperCase()}] ${msg}`);
}

// ── OAuth helpers ──────────────────────────────────────────────────────────
function makeAuthUrl(cfg, kind) {
  const scopes = kind === 'drive'
    ? 'https://www.googleapis.com/auth/drive'
    : 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
  const redirect = encodeURIComponent(`${cfg.appBaseUrl.replace(/\/$/,'')}/oauth2callback`);
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cfg.googleClientId}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=${kind}`;
}

async function exchangeCode(cfg, code) {
  const redirect = `${cfg.appBaseUrl.replace(/\/$/,'')}/oauth2callback`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ code, client_id:cfg.googleClientId, client_secret:cfg.googleClientSecret, redirect_uri:redirect, grant_type:'authorization_code' })
  });
  if (!r.ok) throw new Error('Token exchange failed: '+ await r.text());
  return r.json();
}

async function refreshToken(cfg, kind) {
  const tok = cfg.tokens?.[kind];
  if (!tok?.refresh_token) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ refresh_token:tok.refresh_token, client_id:cfg.googleClientId, client_secret:cfg.googleClientSecret, grant_type:'refresh_token' })
  });
  if (!r.ok) throw new Error('Refresh failed: '+ await r.text());
  const data = await r.json();
  const merged = { ...tok, access_token:data.access_token, expiry_date: Date.now() + (data.expires_in||3600)*1000 };
  await saveCfg({ tokens:{ ...cfg.tokens, [kind]:merged } });
  return merged.access_token;
}

async function getToken(kind) {
  const cfg = await loadCfg();
  const tok = cfg.tokens?.[kind];
  if (!tok?.access_token) return await refreshToken(cfg, kind);
  if (tok.expiry_date && tok.expiry_date - Date.now() < 120_000) return await refreshToken(cfg, kind);
  return tok.access_token;
}

// ── Drive helpers ──────────────────────────────────────────────────────────
async function driveList(folderId, mimePrefix) {
  const token = await getToken('drive');
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size)&pageSize=200`, {
    headers:{ Authorization:`Bearer ${token}` }
  });
  if (!r.ok) throw new Error('Drive list failed: '+ await r.text());
  const data = await r.json();
  return (data.files||[]).filter(f => f.mimeType?.startsWith(mimePrefix) || f.name?.match(mimePrefix));
}

async function driveDownload(fileId, dest) {
  const token = await getToken('drive');
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers:{ Authorization:`Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`Drive download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return dest;
}

async function driveBackup(name, obj) {
  try {
    const token = await getToken('drive');
    if (!token) return;
    const content = JSON.stringify(obj, null, 2);
    // search in appDataFolder
    const sr = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${name}' and trashed=false&fields=files(id)`, {
      headers:{ Authorization:`Bearer ${token}` }
    });
    const sd = await sr.json();
    const existing = sd.files?.[0]?.id;
    if (existing) {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=media`, {
        method:'PATCH', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:content
      });
    } else {
      const boundary = 'b'+uid();
      const meta = JSON.stringify({ name, parents:['appDataFolder'] });
      const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, {
        method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':`multipart/related; boundary=${boundary}` }, body
      });
    }
    log('success', `Drive backup: ${name}`);
  } catch(e) { log('error', `Drive backup failed (${name}): ${e.message}`); }
}

// ── pick unused ────────────────────────────────────────────────────────────
function pickUnused(items, used) {
  if (!items.length) return { chosen:null, nextUsed:used };
  let pool = items.filter(i => !used.includes(i.id||i));
  if (!pool.length) pool = items;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  const id = chosen.id || chosen;
  return { chosen, nextUsed: pool.length === items.length ? [id] : [...used, id] };
}

// ── video/audio sources ────────────────────────────────────────────────────
const PEXELS_QUERIES = ['mosque night','kaaba mecca','islamic prayer','starry sky calm','flowing water nature'];
const FALLBACK_AUDIO = [
  'https://www.youtube.com/watch?v=f0sA7p7Q4fc',
  'https://www.youtube.com/watch?v=xUnGI0eIbeU',
  'https://www.youtube.com/watch?v=87-JC0m1Ark',
];

async function getBgVideo(workDir, q) {
  const cfg = await loadCfg();
  // 1. Drive
  if (cfg.driveVideoFolderId && cfg.tokens?.drive?.refresh_token) {
    try {
      const files = await driveList(cfg.driveVideoFolderId, /\.(mp4|mov|avi|mkv|webm)$/i);
      const { chosen, nextUsed } = pickUnused(files, q.usedVideo||[]);
      if (chosen) {
        const dest = path.join(workDir, `bg_${chosen.id}.mp4`);
        await driveDownload(chosen.id, dest);
        q.usedVideo = nextUsed;
        await saveQ(q);
        log('success', `BG video from Drive: ${chosen.name}`);
        return dest;
      }
    } catch(e) { log('error', `Drive video failed: ${e.message}`); }
  }
  // 2. Pexels (only if key exists)
  if (cfg.pexelsApiKey) {
    for (const query of PEXELS_QUERIES) {
      try {
        const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10&orientation=portrait`, {
          headers:{ Authorization: cfg.pexelsApiKey }
        });
        if (!r.ok) { log('error',`Pexels ${r.status} for "${query}"`); continue; }
        const data = await r.json();
        let best = null;
        for (const v of data.videos||[]) {
          for (const vf of v.video_files||[]) {
            if (!best || (vf.height >= vf.width && vf.height > (best.height||0))) best = vf;
          }
        }
        if (best?.link) {
          const dest = path.join(workDir, `pexels_bg.mp4`);
          const vr = await fetch(best.link);
          if (!vr.ok) continue;
          const buf = Buffer.from(await vr.arrayBuffer());
          await fsp.writeFile(dest, buf);
          log('success', `BG video from Pexels: ${query}`);
          return dest;
        }
      } catch(e) { log('error', `Pexels (${query}): ${e.message}`); }
    }
  } else {
    log('info', 'Pexels key নেই — synthetic background use হবে');
  }
  // 3. Synthetic dark background
  const dest = path.join(workDir, 'synthetic_bg.mp4');
  await runCmd('ffmpeg', ['-y','-f','lavfi','-i','color=c=0x0a0f1e:s=1080x1920:d=120','-vf','format=yuv420p', dest]);
  log('info', 'BG video: synthetic dark');
  return dest;
}

async function getAudio(workDir, q) {
  const cfg = await loadCfg();
  // 1. Drive
  if (cfg.driveAudioFolderId && cfg.tokens?.drive?.refresh_token) {
    try {
      const files = await driveList(cfg.driveAudioFolderId, /\.(mp3|m4a|wav|aac|ogg)$/i);
      const { chosen, nextUsed } = pickUnused(files, q.usedAudio||[]);
      if (chosen) {
        const ext = path.extname(chosen.name) || '.mp3';
        const dest = path.join(workDir, `audio_${chosen.id}${ext}`);
        await driveDownload(chosen.id, dest);
        q.usedAudio = nextUsed;
        await saveQ(q);
        log('success', `Audio from Drive: ${chosen.name}`);
        return dest;
      }
    } catch(e) { log('error', `Drive audio failed: ${e.message}`); }
  }
  // 2. YT Audio Library via yt-dlp
  for (const url of FALLBACK_AUDIO) {
    try {
      const base = path.join(workDir, `fallback_${uid()}`);
      await runCmd('yt-dlp', ['-x','--audio-format','mp3','-o',`${base}.%(ext)s`, url]);
      const dest = `${base}.mp3`;
      if (fs.existsSync(dest)) {
        log('success', `Audio from YT fallback`);
        return dest;
      }
    } catch(e) { log('error', `YT audio fallback: ${e.message}`); }
  }
  // 3. Synthetic sine tone
  const dest = path.join(workDir, 'synthetic_audio.mp3');
  await runCmd('ffmpeg', ['-y','-f','lavfi','-i','sine=frequency=432:sample_rate=44100:duration=120','-filter:a','volume=0.05', dest]);
  log('info', 'Audio: synthetic tone');
  return dest;
}

// ── run subprocess ─────────────────────────────────────────────────────────
function runCmd(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio:['ignore','pipe','pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; d.toString().split('\n').filter(Boolean).forEach(l => log('info', `[${cmd}] ${l}`)); });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-2000)}`)));
  });
}

// ── AI meta ────────────────────────────────────────────────────────────────
const DEFAULT_HASHTAGS = ['#shorts','#islamicshorts','#banglashorts','#islamicvideo','#waz','#quran','#hadith','#allah','#islam','#dua','#iman','#banglaislamic','#islamicreminder','#viralshorts','#ytshorts','#muslimshorts','#islamicfacts','#banglaviral','#islamicstatus','#jinshorts'];
const DEFAULT_TAGS = ['islamic shorts','bangla waz','bangla islamic video','islamic reminder bangla','quran bangla','jin bangla','kalo jadu','islamic facts bangla','bangla viral shorts','islamic motivation bangla','akhirat reminder','allah reminder','muslim shorts','bangla quran','bangla hadith','islamic status bangla','religious shorts','bangla viral video','deen reminder','jinn bangla','islamic reel','youtube shorts bangla','islamic content','bangla reminder','short islamic clips'];

async function genMeta(hook) {
  const cfg = await loadCfg();
  if (!cfg.openRouterApiKey) return { title:hook.slice(0,100), description:'ইসলামিক অনুপ্রেরণামূলক শর্টস।\nআল্লাহকে স্মরণ করুন।\nভিডিওটি শেয়ার করুন।', hashtags:DEFAULT_HASHTAGS, tags:DEFAULT_TAGS };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${cfg.openRouterApiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model:'meta-llama/llama-3.3-70b-instruct:free',
        response_format:{ type:'json_object' },
        messages:[
          { role:'system', content:'Return only strict JSON. No markdown.' },
          { role:'user', content:`তুমি বাংলা YouTube Shorts SEO expert। শুধু JSON return করবে।\nHook: "${hook}"\n{"title":"max 100 chars viral Bengali title","description":"3 short Bengali lines","hashtags":["#shorts",...19 more Islamic Bengali],"tags":["islamic shorts",...24 more SEO tags]}` }
        ]
      })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    const parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/```json|```/g,'').trim()) : raw;
    log('success', 'OpenRouter meta generated');
    return {
      title: String(parsed.title||hook).slice(0,100),
      description: String(parsed.description||''),
      hashtags: Array.isArray(parsed.hashtags) && parsed.hashtags.length >= 10 ? parsed.hashtags.slice(0,20) : DEFAULT_HASHTAGS,
      tags: Array.isArray(parsed.tags) && parsed.tags.length >= 10 ? parsed.tags.slice(0,25) : DEFAULT_TAGS,
    };
  } catch(e) {
    log('error', `OpenRouter failed, fallback: ${e.message}`);
    return { title:hook.slice(0,100), description:'ইসলামিক অনুপ্রেরণামূলক শর্টস।\nআল্লাহকে স্মরণ করুন।\nভিডিওটি শেয়ার করুন।', hashtags:DEFAULT_HASHTAGS, tags:DEFAULT_TAGS };
  }
}

// ── YouTube upload ─────────────────────────────────────────────────────────
async function uploadYT(videoPath, meta) {
  const token = await getToken('youtube');
  if (!token) { log('info', 'YouTube not connected — preview only'); return { previewOnly:true }; }
  const size = fs.statSync(videoPath).size;
  const desc = `${meta.description}\n\n${meta.hashtags.join(' ')}`;
  const initR = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'X-Upload-Content-Type':'video/mp4', 'X-Upload-Content-Length':size },
    body: JSON.stringify({
      snippet:{ title:meta.title, description:desc.slice(0,5000), tags:meta.tags.slice(0,30), categoryId:'22' },
      status:{ privacyStatus:'public', selfDeclaredMadeForKids:false }
    })
  });
  if (!initR.ok) throw new Error('YT init failed: '+ await initR.text());
  const uploadUrl = initR.headers.get('location');
  const buf = fs.readFileSync(videoPath);
  const upR = await fetch(uploadUrl, { method:'PUT', headers:{ 'Content-Type':'video/mp4', 'Content-Length':size }, body:buf });
  if (!upR.ok) throw new Error('YT upload failed: '+ await upR.text());
  const ytData = await upR.json();
  log('success', `YouTube upload: https://youtu.be/${ytData.id}`);
  return { previewOnly:false, videoId:ytData.id, url:`https://youtu.be/${ytData.id}` };
}

// ── main job ───────────────────────────────────────────────────────────────
let jobRunning = false;
const jobQueue = [];

async function runJob() {
  if (jobRunning || !jobQueue.length) return;
  jobRunning = true;
  const job = jobQueue.shift();
  const workDir = path.join(TMP, `job_${uid()}`);
  try {
    await fsp.mkdir(workDir, { recursive:true });
    const q = await loadQ();
    if (!q.rows.length) throw new Error('CSV queue খালি — আগে CSV upload করুন');
    const row = q.rows[q.idx] || q.rows[0];
    const hook = String(row.hook||'').trim();
    if (!hook) throw new Error('CSV row এ hook নেই');
    const points = Object.keys(row)
      .filter(k => /^point\d+$/i.test(k))
      .sort((a,b) => +a.replace(/\D/g,'') - +b.replace(/\D/g,''))
      .map(k => String(row[k]||'').trim())
      .filter(Boolean);
    if (!points.length) throw new Error('CSV row এ কোনো point নেই');
    log('info', `Job শুরু: "${hook}" (${points.length} points)`);

    const bgPath    = await getBgVideo(workDir, q);
    const audioPath = await getAudio(workDir, q);
    const outPath   = path.join(workDir, 'final.mp4');
    const fontPath  = path.join(FONTS, 'BalooDa2-Bold.ttf');

    log('info', 'video_gen.py চালানো হচ্ছে...');
    await runCmd('python3', [
      path.join(ROOT,'video_gen.py'),
      '--hook',  hook,
      '--points', points.join('|'),
      '--bg',    bgPath,
      '--audio', audioPath,
      '--font',  fontPath,
      '--out',   outPath,
      '--tmp',   workDir,
    ]);

    if (!fs.existsSync(outPath)) throw new Error('video_gen.py কোনো output দেয়নি');
    log('success', `Video তৈরি: ${(fs.statSync(outPath).size/1024/1024).toFixed(1)}MB`);

    const meta   = await genMeta(hook);
    const upload = job.previewOnly ? { previewOnly:true } : await uploadYT(outPath, meta);

    if (!upload.previewOnly) {
      q.idx = (q.idx + 1) % q.rows.length;
      await saveQ(q);
      log('success', `Queue advanced → row ${q.idx+1}/${q.rows.length}`);
    }
    log('success', `✅ Job শেষ${upload.videoId ? ': https://youtu.be/'+upload.videoId : ' (preview)'}`);
  } catch(e) {
    log('error', `Job failed: ${e.message}`);
  } finally {
    jobRunning = false;
    // cleanup workDir after 5 min
    setTimeout(() => fsp.rm(workDir, { recursive:true, force:true }).catch(()=>{}), 5*60*1000);
    if (jobQueue.length) runJob();
  }
}

function enqueue(previewOnly=false) {
  jobQueue.push({ previewOnly });
  log('info', `Job queued (${previewOnly?'preview':'upload'})`);
  runJob();
}

// ── scheduler ──────────────────────────────────────────────────────────────
const lastRun = new Map();
function dhakaNow() {
  const p = new Intl.DateTimeFormat('en-US',{ timeZone:'Asia/Dhaka', hour12:false, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'2-digit', minute:'2-digit' }).formatToParts(new Date());
  const get = t => p.find(x=>x.type===t)?.value||'';
  return { dateKey:`${get('year')}-${get('month')}-${get('day')}`, weekday:get('weekday'), hhmm:`${get('hour')}:${get('minute')}` };
}
const toMin = hhmm => { const [h,m] = hhmm.split(':').map(Number); return h*60+m; };

async function schedulerTick() {
  try {
    const cfg = await loadCfg();
    if (!cfg.schedule?.enabled) return;
    const { dateKey, weekday, hhmm } = dhakaNow();
    const nowMin = toMin(hhmm);
    for (const slot of (cfg.schedule.slots||[]).filter(s=>s.enabled!==false)) {
      if (slot.days?.length && !slot.days.includes(weekday)) continue;
      const diff = nowMin - toMin(slot.time||'09:00');
      const key  = `${slot.id}_${dateKey}`;
      if (diff >= 0 && diff < 2 && !lastRun.has(key)) {
        lastRun.set(key, now());
        log('success', `⏰ Scheduled slot: ${slot.time} (${weekday})`);
        enqueue(false);
      }
    }
  } catch(e) { log('error', `Scheduler tick: ${e.message}`); }
}

// ── middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit:'20mb' }));
app.use(express.urlencoded({ extended:true }));
app.use(express.static(PUBLIC));
const upload = multer({ dest: path.join(TMP,'uploads') });

// ── API routes ─────────────────────────────────────────────────────────────
app.get('/api/logs/stream', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ ts:now(), type:'info', msg:'SSE connected' })}\n\n`);
  logBuffer.slice(-80).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/status', async(_,res) => {
  const cfg = await loadCfg();
  const q   = await loadQ();
  res.json({
    ok: true,
    drive:   !!cfg.tokens?.drive?.refresh_token,
    youtube: !!cfg.tokens?.youtube?.refresh_token,
    channelName: cfg.channelName||'',
    driveVideoFolderId: cfg.driveVideoFolderId||'',
    driveAudioFolderId: cfg.driveAudioFolderId||'',
    googleClientId: cfg.googleClientId||'',
    appBaseUrl: cfg.appBaseUrl||'',
    openRouterMasked: safe(cfg.openRouterApiKey),
    pexelsMasked: safe(cfg.pexelsApiKey),
    schedule: cfg.schedule||{},
    queue: { total:q.rows.length, idx:q.idx, hook:q.rows[q.idx]?.hook||'—' },
    running: jobRunning,
    queued: jobQueue.length,
  });
});

app.post('/api/config', async(req,res) => {
  try {
    const p = { ...req.body };
    if (p.schedule?.slots) p.schedule.slots = p.schedule.slots.map(s=>({ id:s.id||uid(), time:s.time||'09:00', days:Array.isArray(s.days)?s.days:[], enabled:s.enabled!==false }));
    await saveCfg(p);
    await driveBackup('yta_schedule_config.json', { schedule:(await loadCfg()).schedule });
    log('success','Config saved');
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/csv/upload', upload.single('csv'), async(req,res) => {
  try {
    if (!req.file) throw new Error('CSV file missing');
    const raw  = await fsp.readFile(req.file.path, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const headers = lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',').map(v=>v.trim().replace(/^"|"$/g,''));
      return Object.fromEntries(headers.map((h,i) => [h, vals[i]||'']));
    }).filter(r => String(r.hook||'').trim());
    if (!rows.length) throw new Error('CSV এ কোনো valid row নেই');
    await saveQ({ rows, idx:0, usedVideo:[], usedAudio:[] });
    log('success', `CSV uploaded: ${rows.length} rows`);
    res.json({ ok:true, total:rows.length, first:rows[0]?.hook||'—' });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  } finally {
    if (req.file?.path) fsp.unlink(req.file.path).catch(()=>{});
  }
});

app.post('/api/queue/reset', async(_,res) => {
  const q = await loadQ();
  q.idx = 0; q.usedVideo = []; q.usedAudio = [];
  await saveQ(q);
  log('success','Queue reset');
  res.json({ ok:true });
});

app.post('/api/trigger', async(_,res) => {
  const cfg = await loadCfg();
  enqueue(!cfg.tokens?.youtube?.refresh_token);
  res.json({ ok:true });
});

// OAuth
app.get('/auth/drive', async(_,res) => {
  try { const cfg = await loadCfg(); res.redirect(makeAuthUrl(cfg,'drive')); }
  catch(e) { res.status(500).send(e.message); }
});
app.get('/auth/youtube', async(_,res) => {
  try { const cfg = await loadCfg(); res.redirect(makeAuthUrl(cfg,'youtube')); }
  catch(e) { res.status(500).send(e.message); }
});
app.get('/oauth2callback', async(req,res) => {
  try {
    const { code, state:kind } = req.query;
    if (!code || !kind) throw new Error('Missing OAuth params');
    const tokens = await exchangeCode(await loadCfg(), String(code));
    const cfg = await loadCfg();
    await saveCfg({ tokens:{ ...cfg.tokens, [kind]: tokens } });
    if (kind === 'youtube') {
      try {
        const t = await getToken('youtube');
        const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers:{ Authorization:`Bearer ${t}` } });
        const d = await r.json();
        const name = d.items?.[0]?.snippet?.title || '';
        await saveCfg({ channelName:name });
        log('success', `YouTube connected: ${name}`);
      } catch {}
    } else {
      log('success', 'Drive connected');
    }
    await driveBackup('yta_tokens_backup.json', { tokens:(await loadCfg()).tokens });
    res.send('<!doctype html><html><body style="background:#0a0f1e;color:#4ade80;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px">✅</div><h2>সংযুক্ত হয়েছে!</h2><p style="color:#64748b">এই ট্যাব বন্ধ করুন।</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>');
  } catch(e) { res.status(500).send('OAuth failed: '+e.message); }
});

// only serve index.html for non-API routes
app.get(/^(?!\/api\/).*/, (_,res) => res.sendFile(path.join(PUBLIC,'index.html')));

// ── bootstrap ──────────────────────────────────────────────────────────────
(async () => {
  await fsp.mkdir(DATA, { recursive:true });
  await fsp.mkdir(TMP,  { recursive:true });
  await fsp.mkdir(path.join(TMP,'uploads'), { recursive:true });
  await fsp.mkdir(FONTS, { recursive:true });
  await saveCfg({});
  await saveQ(await loadQ());
  log('info', 'Bootstrap complete');

  // auto refresh tokens every 30 min
  setInterval(async () => {
    const cfg = await loadCfg();
    if (cfg.tokens?.drive?.refresh_token)   refreshToken(cfg,'drive').catch(e=>log('error','Drive refresh: '+e.message));
    if (cfg.tokens?.youtube?.refresh_token) refreshToken(cfg,'youtube').catch(e=>log('error','YT refresh: '+e.message));
  }, 30*60*1000);

  setInterval(schedulerTick, 30*1000);

  app.listen(PORT, () => log('success', `Server running on :${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
