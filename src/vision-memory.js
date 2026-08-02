// Vision Memory: background screenshots every N seconds with OCR text indexing.
// "Photographic memory" feature - search what you were doing weeks ago.
//
// Storage: <userData>/aura-memory/<YYYY-MM-DD>/<timestamp>.jpg + <timestamp>.txt (OCR'd text)
// Index: store.get('vision_index') = [{ ts, path, text, app, title }]

const { app, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');

let timer = null;
let enabled = false;
let intervalSec = 90;

function memoryDir() {
  const root = path.join(app.getPath('userData'), 'aura-memory');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function todayDir() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const dir = path.join(memoryDir(), stamp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function captureAndIndex() {
  if (!enabled) return;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (!sources.length) return;
    const ts = Date.now();
    const jpg = sources[0].thumbnail.toJPEG(78);
    const dir = todayDir();
    const jpgPath = path.join(dir, `${ts}.jpg`);
    fs.writeFileSync(jpgPath, jpg);

    // Lightweight OCR via Gemini (only if user has API key + enabled)
    const apiKey = store.get('settings', 'apiKey');
    let text = '';
    if (apiKey) {
      try {
        const b64 = jpg.toString('base64');
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [
              { inlineData: { mimeType: 'image/jpeg', data: b64 } },
              { text: 'Briefly describe this screen in 1-2 sentences focusing on what app is shown and what the user is doing. Then list any prominent visible text. Keep total under 100 words. Format: "App: <name>. Activity: <what>. Text: <key strings>"' },
            ] }],
            generationConfig: {
              maxOutputTokens: 256,
              thinkingConfig: { thinkingLevel: 'minimal' },
            },
          }),
        });
        if (r.ok) {
          const j = await r.json();
          text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
          fs.writeFileSync(path.join(dir, `${ts}.txt`), text);
        }
      } catch {}
    }

    const idx = store.get('vision_index') || [];
    idx.push({ ts, path: jpgPath, text });
    // Cap to last 2000 entries
    if (idx.length > 2000) idx.splice(0, idx.length - 2000);
    store.set('vision_index', idx);
  } catch (e) {
    console.error('vision-memory error:', e.message);
  }
}

function start(seconds = 90) {
  intervalSec = seconds;
  enabled = true;
  if (timer) clearInterval(timer);
  // First capture after 5s
  setTimeout(captureAndIndex, 5000);
  timer = setInterval(captureAndIndex, intervalSec * 1000);
}

function stop() {
  enabled = false;
  if (timer) clearInterval(timer);
  timer = null;
}

function search(query) {
  const idx = store.get('vision_index') || [];
  const q = (query || '').toLowerCase().trim();
  if (!q) return idx.slice(-50).reverse();
  return idx
    .filter(e => (e.text || '').toLowerCase().includes(q))
    .reverse()
    .slice(0, 50);
}

function getEntry(ts) {
  const idx = store.get('vision_index') || [];
  return idx.find(e => e.ts === ts);
}

function readImageB64(filepath) {
  try {
    return fs.readFileSync(filepath).toString('base64');
  } catch { return null; }
}

function isEnabled() { return enabled; }

module.exports = { start, stop, search, getEntry, readImageB64, isEnabled };
