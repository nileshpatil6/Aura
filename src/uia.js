// Windows UI Automation bridge: a SECOND warm PowerShell session (separate from
// automation.js's input session) that is per-monitor DPI aware and hosts
// System.Windows.Automation. MUST NOT require('electron').
// Contract: docs/jev-uia/CONTRACT.md section "uia.js / uia-host.ps1".

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UIA_SENTINEL = '<<AURA_UIA_DONE>>';
const HOST_SCRIPT = path.join(__dirname, 'uia-host.ps1'); // read via fs (asar-safe), copied to os.tmpdir()

// Own state, deliberately separate from automation.js's psProc/psChain so a
// hung/killed UIA call never blocks input, and vice versa (contract D3).
let uiaProc = null;
let uiaBuf = '';
let uiaPending = null;      // { resolve, timer } — resolve takes the raw stdout text (or null)
let uiaChain = Promise.resolve();
let uiaGen = 0;             // bumped on every kill/restart; stamped into snapshotIds
let uiaJustSpawned = false; // true for the first call after ensureUia() spawns a fresh process

function killUia() {
  if (uiaProc) { try { uiaProc.kill(); } catch {} }
  uiaProc = null;
  uiaBuf = '';
  if (uiaPending) { const p = uiaPending; uiaPending = null; clearTimeout(p.timer); p.resolve(null); }
}

function ensureUia() {
  if (uiaProc) return uiaProc;
  try {
    // Dot-source from a file rather than piping the here-string through stdin
    // (broken with `-Command -`, see contract trap 1). Written WITH a UTF-8
    // BOM so PowerShell 5.1 decodes non-ASCII window titles correctly.
    const tmpFile = path.join(os.tmpdir(), 'aura_uia_host.ps1');
    const scriptText = fs.readFileSync(HOST_SCRIPT, 'utf8');
    fs.writeFileSync(tmpFile, '﻿' + scriptText, 'utf8');

    const proc = spawn('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true });

    // A killed-on-timeout process's own async handlers (data/exit/error) can
    // still fire after a later call has already spawned a replacement and
    // moved uiaProc on. Without this guard those stale handlers null out the
    // NEW process's uiaProc/uiaBuf out from under it — orphaning the real
    // process (leaked powershell.exe) and desyncing its stdout buffer for
    // every call after. Each handler closes over its own `proc` and checks
    // it is still the current one before touching module state.
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (uiaProc !== proc) return;
      uiaBuf += chunk;
      const i = uiaBuf.indexOf(UIA_SENTINEL);
      if (i !== -1 && uiaPending) {
        const out = uiaBuf.slice(0, i);
        uiaBuf = uiaBuf.slice(i + UIA_SENTINEL.length);
        const p = uiaPending; uiaPending = null;
        clearTimeout(p.timer);
        p.resolve(out);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => {}); // non-fatal; surfaced via stdout JSON
    proc.on('exit', () => { if (uiaProc === proc) { uiaProc = null; uiaBuf = ''; } });
    proc.on('error', () => { if (uiaProc === proc) { uiaProc = null; uiaBuf = ''; } });
    // Writing to stdin after the process has exited (e.g. a call queued just
    // as a timeout killed it) throws EPIPE; without a listener that is an
    // uncaught error that crashes the main process.
    proc.stdin.on('error', () => {});

    proc.stdin.write(`. '${tmpFile.replace(/'/g, "''")}'\n`);
    uiaProc = proc;
    uiaJustSpawned = true;
    return proc;
  } catch {
    return null;
  }
}

// Take the LAST line starting with '{' and JSON.parse it.
function parseHostOutput(raw) {
  const lines = raw.split(/\r?\n/);
  let jsonLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('{')) { jsonLine = t; break; }
  }
  if (!jsonLine) return { ok: false, reason: 'error', detail: 'bad host output' };
  try {
    return JSON.parse(jsonLine);
  } catch {
    return { ok: false, reason: 'error', detail: 'bad host output' };
  }
}

// One request/response round trip against an already-spawned process.
function sendOneCmd(proc, cmdObj, timeoutMs) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(JSON.stringify(cmdObj), 'utf8').toString('base64');
    const timer = setTimeout(() => {
      if (uiaPending) {
        uiaPending = null;
        uiaGen++;
        killUia();
        resolve({ ok: false, reason: 'timeout' });
      }
    }, timeoutMs);

    uiaPending = {
      resolve: (raw) => {
        clearTimeout(timer);
        if (raw === null) { resolve({ ok: false, reason: 'error', detail: 'no output' }); return; }
        resolve(parseHostOutput(raw));
      },
      timer,
    };

    try {
      proc.stdin.write(`Invoke-AuraUia '${b64}'\nWrite-Output "${UIA_SENTINEL}"\n`);
    } catch {
      clearTimeout(timer);
      uiaPending = null;
      killUia();
      resolve({ ok: false, reason: 'error', detail: 'write failed' });
    }
  });
}

// Serializes calls on uiaChain (one pending at a time), same shape as
// automation.js's psChain. On timeout: kill the host, bump the generation
// (invalidating any snapshot it produced), and let the next call respawn.
function runUiaCmd(cmdObj, timeoutMs) {
  const task = async () => {
    let proc = ensureUia();
    if (!proc) return { ok: false, reason: 'error', detail: 'spawn failed' };

    if (uiaJustSpawned) {
      // A fresh process still has to load the UIA assemblies and compile the
      // Add-Type helper (~500ms+) before it can answer anything. Absorb that
      // in a dedicated ping at ping's own generous timeout instead of
      // spending the caller's (possibly much tighter, e.g. 2500ms snapshot)
      // budget on cold-start overhead and timing it out for no real reason.
      uiaJustSpawned = false;
      await sendOneCmd(proc, { cmd: 'ping' }, 8000);
      proc = ensureUia(); // the warm-up itself may have timed out and respawned
      if (!proc) return { ok: false, reason: 'error', detail: 'spawn failed' };
    }

    return sendOneCmd(proc, cmdObj, timeoutMs);
  };
  uiaChain = uiaChain.then(task, task);
  return uiaChain;
}

/**
 * @param {{ excludePid:number, auraRects?:number[][], maxElements?:number, timeoutMs?:number }} opts
 * @returns {Promise<object>} UiaSnapshot | UiaFailure (never throws)
 */
async function uiaSnapshot({ excludePid, auraRects = [], maxElements = 200, timeoutMs = 2500 } = {}) {
  const res = await runUiaCmd({ cmd: 'snapshot', excludePid, auraRects, maxElements }, timeoutMs);
  if (!res || typeof res !== 'object') return { ok: false, reason: 'error', detail: 'bad host output' };
  if (!res.ok) return res;
  // Read uiaGen now: this call's own timer was cleared (we're in the success
  // path), and calls are serialized, so no other call could have bumped it
  // since this one started — it reflects exactly the process that answered.
  return { ...res, snapshotId: `g${uiaGen}${res.snapshotId}` };
}

/**
 * Low-level act on an element cached by the host from snapshot `snapshotId`.
 * @param {{ snapshotId:string, index:number, op:'click'|'focus'|'set_value'|'scroll', text?:string,
 *           direction?:'up'|'down', timeoutMs?:number }} opts
 * @returns {Promise<object>} UiaActResult (never throws)
 */
async function uiaAct({ snapshotId, index, op, text, direction, timeoutMs = 5000 } = {}) {
  const m = /^g(\d+)(s\d+)$/.exec(snapshotId || '');
  if (!m) return { ok: false, reason: 'stale_snapshot' };
  const gen = Number(m[1]);
  if (gen !== uiaGen) return { ok: false, reason: 'stale_snapshot' };

  const res = await runUiaCmd({ cmd: 'act', snapshotId: m[2], index, op, text, direction }, timeoutMs);
  if (!res || typeof res !== 'object') return { ok: false, reason: 'error', detail: 'bad host output' };
  return res;
}

/** Starts the host (loads assemblies, compiles helper type) without waiting. Idempotent. */
function uiaWarm() {
  try {
    ensureUia();
    runUiaCmd({ cmd: 'ping' }, 8000).catch(() => {});
  } catch {}
}

/** Kills the host process; pending call resolves { ok:false, reason:'error' }. */
function shutdownUia() {
  uiaGen++; // any snapshot from the old process must not be reusable after a restart
  killUia();
}

module.exports = { uiaSnapshot, uiaAct, uiaWarm, shutdownUia };
