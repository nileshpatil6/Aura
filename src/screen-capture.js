// Primary-display screenshot capture for Jev Vision mode. Requires electron,
// so it is only loaded by main.js and scripts/jev-vision-probe.js. Contract:
// docs/jev-vision/CONTRACT.md section 3.6.
//
// Two paths, same result shape:
//   - stream (default): a hidden BrowserWindow (src/capture-host.html) keeps one
//     primary-display video stream open and encodes a JPEG on request. Started
//     lazily on the first capture or by warmCapture(), dropped after idle and on
//     display changes.
//   - thumbnail (fallback): desktopCapturer.getSources with a thumbnail, 500+ ms.
// Any stream failure falls back to the thumbnail path and is logged once.

const path = require('path');
const { app, screen, desktopCapturer, BrowserWindow } = require('electron');
const { fitImageSize, validateImageDims } = require('./jev-vision');

const STREAM_FPS = 15;            // capture rate while the stream is open
// Max wait for a frame newer than the request. A desktop stream only sends a
// frame when pixels change, so on a static screen the wait always runs out; the
// runner's settle delay and verify polls already cover a late repaint, so keep
// it short. AURA_JV_FRESH_MS overrides.
const START_TIMEOUT_MS = 3500;
const GRAB_TIMEOUT_MS = 1500;
const FRESH_WAIT_MS = Math.max(0, Number(process.env.AURA_JV_FRESH_MS) || 60);
const IDLE_STOP_MS = 120000;      // close the stream after this long without a capture
const RETRY_AFTER_FAIL_MS = 30000;

let logFn = null;
function setCaptureLogger(fn) { logFn = typeof fn === 'function' ? fn : null; }

/**
 * DisplayInfo for the primary display. `phys` comes from screen.dipToScreenRect
 * so UIA rects (physical) can be normalized against it.
 */
function primaryDisplayInfo() {
  const d = screen.getPrimaryDisplay();
  const r = screen.dipToScreenRect(null, d.bounds);
  return {
    dipW: d.bounds.width,
    dipH: d.bounds.height,
    physX: r.x,
    physY: r.y,
    physW: r.width,
    physH: r.height,
    scaleFactor: d.scaleFactor,
  };
}

// Validate a finished frame against the API limits and the display aspect.
function checkFrame(width, height, phys) {
  if (!validateImageDims(width, height)) {
    return `capture ${width}x${height} outside limits`;
  }
  const dispAspect = phys.width / phys.height;
  const imgAspect = width / height;
  if (Math.abs(imgAspect - dispAspect) / dispAspect > 0.01) {
    return `capture aspect ${imgAspect.toFixed(4)} != display ${dispAspect.toFixed(4)}`;
  }
  return null;
}

// The native stream frame must match the display: a stale or letterboxed frame
// would otherwise be stretched to the display aspect and clicks would land off target.
function checkAspect(srcW, srcH, phys) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) return 'capture frame has no size';
  const dispAspect = phys.width / phys.height;
  const srcAspect = srcW / srcH;
  if (Math.abs(srcAspect - dispAspect) / dispAspect > 0.01) {
    return `stream frame ${srcW}x${srcH} != display ${phys.width}x${phys.height}`;
  }
  return null;
}

// getSources()[0] is not guaranteed to be the primary display (T2). With several
// sources and no display_id match we refuse rather than guess a monitor.
function pickPrimarySource(sources, primary) {
  if (!sources || !sources.length) return null;
  return sources.find(s => String(s.display_id) === String(primary.id)) ||
    (sources.length === 1 ? sources[0] : null);
}

// ── Thumbnail path (fallback) ────────────────────────────────────────────────
async function captureViaThumbnail({ maxSide, quality }) {
  const start = Date.now();
  try {
    const primary = screen.getPrimaryDisplay();
    const phys = screen.dipToScreenRect(null, primary.bounds);
    const size = fitImageSize(phys.width, phys.height, maxSide);
    if (!size) return { ok: false, error: `no valid capture size for ${phys.width}x${phys.height}` };

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    if (!sources || !sources.length) return { ok: false, error: 'no capture sources' };
    const src = pickPrimarySource(sources, primary);
    if (!src) return { ok: false, error: 'primary source not found' };

    const thumb = src.thumbnail;
    const actual = thumb.getSize();
    const bad = checkFrame(actual.width, actual.height, phys);
    if (bad) return { ok: false, error: bad };

    const jpeg = thumb.toJPEG(quality);
    return { ok: true, jpeg, width: actual.width, height: actual.height, ms: Date.now() - start, via: 'thumbnail' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'capture failed' };
  }
}

// ── Stream path ──────────────────────────────────────────────────────────────
const stream = {
  win: null,
  key: '',            // primary id + size the stream was started for
  starting: null,     // in-flight start promise
  idleTimer: null,
  failedAt: 0,
  gen: 0,             // bumped by stopStream; a start from an older gen must not touch state
  loggedFail: false,
  listening: false,
};

function log(line) { if (logFn) { try { logFn(line); } catch {} } }

// Rejects after `ms` so a hung renderer call cannot hang a capture.
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stopStream() {
  stream.gen++;
  clearTimeout(stream.idleTimer);
  stream.idleTimer = null;
  stream.key = '';
  stream.starting = null;
  const win = stream.win;
  stream.win = null;
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch {}
  }
}

function armIdleStop() {
  clearTimeout(stream.idleTimer);
  stream.idleTimer = setTimeout(() => { log('[jv] capture stream idle, closing'); stopStream(); }, IDLE_STOP_MS);
  if (stream.idleTimer.unref) stream.idleTimer.unref();
}

function listenForDisplayChanges() {
  if (stream.listening) return;
  stream.listening = true;
  const reset = () => { if (stream.win) { log('[jv] display changed, resetting capture stream'); stopStream(); } };
  screen.on('display-metrics-changed', reset);
  screen.on('display-added', reset);
  screen.on('display-removed', reset);
  app.once('before-quit', stopStream);
}

async function startStream(primary, size, key, gen) {
  listenForDisplayChanges();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = pickPrimarySource(sources, primary);
  if (!src) throw new Error('primary source not found');

  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  if (stream.gen !== gen) { try { win.destroy(); } catch {} throw new Error('capture stream replaced during start'); }
  stream.win = win;
  let dims;
  try {
    dims = await withTimeout((async () => {
      await win.loadFile(path.join(__dirname, 'capture-host.html'));
      return win.webContents.executeJavaScript(
        `start(${JSON.stringify(src.id)}, ${size.width}, ${size.height}, ${STREAM_FPS})`, true);
    })(), START_TIMEOUT_MS, 'capture stream start');
  } catch (e) {
    if (stream.win !== win && !win.isDestroyed()) { try { win.destroy(); } catch {} } // stale start: not ours to leave behind
    throw e;
  }
  if (stream.win !== win || stream.gen !== gen) throw new Error('capture stream replaced during start');
  stream.key = key;
  log(`[jv] capture stream up ${dims.w}x${dims.h}`);
}

// Resolves true when a stream for this display/size is running.
async function ensureStream(primary, size) {
  const key = `${primary.id}:${size.width}x${size.height}`;
  if (stream.win && !stream.win.isDestroyed() && stream.key === key) return true;
  if (stream.starting) {
    await stream.starting.catch(() => {});
    return stream.key === key && !!stream.win;
  }
  if (Date.now() - stream.failedAt < RETRY_AFTER_FAIL_MS) return false;

  stopStream();
  // Handlers act only while this start is still the current one, so a stale
  // start failing late cannot destroy a newer stream.
  const token = startStream(primary, size, key, stream.gen).then(
    () => { if (stream.starting === token) stream.starting = null; },
    (e) => {
      if (stream.starting === token) {
        stream.failedAt = Date.now();
        stopStream();
        if (!stream.loggedFail) {
          stream.loggedFail = true;
          log(`[jv] capture stream unavailable, using thumbnails: ${(e && e.message) || e}`);
        }
      }
      throw e;
    });
  stream.starting = token;
  try {
    await token;
  } catch {
    return false;
  }
  return true;
}

// The stream runs at the display's native size so a zoom crop has real pixels;
// every screenshot is scaled down to `size` in the page.
function nativeSize(phys) {
  return { width: phys.width, height: phys.height };
}

async function captureViaStream({ maxSide, quality }) {
  const start = Date.now();
  const primary = screen.getPrimaryDisplay();
  const phys = screen.dipToScreenRect(null, primary.bounds);
  const size = fitImageSize(phys.width, phys.height, maxSide);
  if (!size) return { ok: false, error: `no valid capture size for ${phys.width}x${phys.height}` };

  if (!(await ensureStream(primary, nativeSize(phys)))) return null; // null = use the fallback
  const win = stream.win;
  if (!win || win.isDestroyed()) return null;

  try {
    const r = await withTimeout(
      win.webContents.executeJavaScript(
        `grab(${(quality / 100).toFixed(2)}, ${FRESH_WAIT_MS}, ${size.width}, ${size.height})`, true),
      GRAB_TIMEOUT_MS, 'capture grab');
    // The output is always fitImageSize(phys), so the aspect check must run on the frame as captured.
    const bad = checkFrame(r.w, r.h, phys) || checkAspect(r.srcW, r.srcH, phys);
    if (bad) {
      // A wrong-size frame means the stream is stale (mode change): back off, rebuild later, use thumbnails now.
      stream.failedAt = Date.now();
      stopStream();
      if (!stream.loggedFail) {
        stream.loggedFail = true;
        log(`[jv] capture stream frame rejected, using thumbnails: ${bad}`);
      }
      return null;
    }
    armIdleStop();
    return { ok: true, jpeg: Buffer.from(r.b64, 'base64'), width: r.w, height: r.h, ms: Date.now() - start, via: 'stream' };
  } catch (e) {
    stream.failedAt = Date.now();
    stopStream();
    if (!stream.loggedFail) {
      stream.loggedFail = true;
      log(`[jv] capture stream failed, using thumbnails: ${(e && e.message) || e}`);
    }
    return null;
  }
}

/**
 * Capture the whole primary display as a JPEG sized inside the API limits.
 * Never throws. `fast:false` forces the thumbnail path.
 * @param {{ maxSide:number, quality:number, fast?:boolean }} opts
 * @returns {Promise<{ok:true, jpeg:Buffer, width:number, height:number, ms:number, via?:string}|{ok:false, error:string}>}
 */
async function capturePrimaryJpeg({ maxSide, quality, fast = true }) {
  if (fast) {
    try {
      const r = await captureViaStream({ maxSide, quality });
      if (r) return r;
    } catch (e) {
      log(`[jv] capture stream error, using thumbnails: ${(e && e.message) || e}`);
    }
  }
  return captureViaThumbnail({ maxSide, quality });
}

/**
 * A region of the most recent screenshot's frame at native resolution, for
 * re-locating a small target. Stream path only: returns null when the stream
 * is not running (the caller keeps its first box). Never throws.
 * @param {{ rect:{left:number,top:number,right:number,bottom:number}, quality:number,
 *           minSide?:number, maxSide?:number }} opts fractions of the display
 */
async function captureCrop({ rect, quality, minSide = 560, maxSide = 1024 }) {
  const start = Date.now();
  const win = stream.win;
  if (!win || win.isDestroyed() || !stream.key || !rect) return null;
  const vals = [rect.left, rect.top, rect.right, rect.bottom];
  if (!vals.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || !(rect.left < rect.right) || !(rect.top < rect.bottom)) return null;
  try {
    const r = await withTimeout(
      win.webContents.executeJavaScript(
        `crop(${vals.map(v => v.toFixed(6)).join(', ')}, ${minSide}, ${maxSide}, ${(quality / 100).toFixed(2)})`, true),
      GRAB_TIMEOUT_MS, 'capture crop');
    if (!validateImageDims(r.w, r.h)) return null;
    armIdleStop();
    return {
      ok: true, jpeg: Buffer.from(r.b64, 'base64'), width: r.w, height: r.h, ms: Date.now() - start,
      rect: { left: r.l, top: r.t, right: r.r, bottom: r.b },
    };
  } catch (e) {
    log(`[jv] capture crop failed: ${(e && e.message) || e}`);
    return null;
  }
}

/** Start the stream ahead of the first capture (vision boot, text box open). Never throws. */
async function warmCapture({ maxSide }) {
  try {
    const primary = screen.getPrimaryDisplay();
    const phys = screen.dipToScreenRect(null, primary.bounds);
    const size = fitImageSize(phys.width, phys.height, maxSide);
    if (!size) return false;
    const ok = await ensureStream(primary, nativeSize(phys));
    if (ok) armIdleStop();
    return ok;
  } catch {
    return false;
  }
}

module.exports = {
  primaryDisplayInfo, capturePrimaryJpeg, captureViaThumbnail, captureCrop, warmCapture,
  stopCapture: stopStream, setCaptureLogger,
};
