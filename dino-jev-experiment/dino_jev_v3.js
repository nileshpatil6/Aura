// v3: same lookahead-planning driver as v2 (Jev plans up to 4 obstacles per call; a local timer
// only picks the exact moment to execute each plan), refactored so the game I/O goes through a
// small TRANSPORT interface with two implementations:
//   --transport cdp  (default) same as v2: a separate scratch Chrome profile, driven over CDP.
//   --transport ext            the user's REAL Chrome, driven by a companion extension
//                               (dino-jev-experiment/extension/) that connects back to this
//                               script over ws://127.0.0.1:<port>. In this mode the script never
//                               launches, closes, or otherwise automates Chrome -- the user opens
//                               chromedino.com themselves with the extension loaded.
// v2 (dino_jev_v2.js) is left untouched. Scratch-only; does not modify the Aura repo except
// requiring its existing jev.js / env-keys.js helpers (read-only).

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const AURA_DIR = path.join(__dirname, '..');
const { jevCall } = require(path.join(AURA_DIR, 'src', 'jev.js'));
const { resolveJevKey } = require(path.join(AURA_DIR, 'src', 'env-keys.js'));

const SCRATCH_DIR = __dirname;
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(SCRATCH_DIR, 'profile'); // cdp transport only; never run alongside v1/v2
const CDP_PORT = 9223;
const EXT_WS_PORT = 8765; // must match extension/content.js's DEFAULT_PORT
const GAME_URL = 'https://chromedino.com/'; // see v1's dino_jev.js header for why not chrome://dino

// ---- tunable knobs ----------------------------------------------------------
const CONFIG = {
  pollIntervalMs: 16,
  pipelineIntervalMs: 250,
  pipelineIntervalFastMs: 100,
  pipelineFastThresholdMs: 800,
  maxInFlight: 3,
  jevTimeoutMs: 4000,
  maxObstaclesPerCall: 6, // horizon.obstacles rarely holds more than 2-3 at once, but give Jev everything visible
  jumpWindowLowPx: 15,
  duckStartGapPx: 40,
  fastDropSafetyMarginMs: 300, // cut a jump short once the next obstacle's trigger is this close, no matter what
  matchTolerancePx: 40,
  costPerInputToken: 0.042 / 1_000_000,
  // Safety watchdog: a run where the scratch Chrome closed mid-round once made ~8,800 wasted Jev
  // calls over ~40 minutes because a hung CDP call left the poll loop stuck while the pipeline
  // timer kept re-planning the same stale obstacle forever (see runRound comments).
  // 800ms is still very generous for a LOCAL CDP call (Runtime.evaluate normally resolves in
  // single-digit ms; this is not the Jev network round trip). Needed 4 consecutive failures to
  // reach freezeDetectMs with the original 2000ms value, pushing detection to ~8s (verified) --
  // too slow against the coordinator's "~6s" target. At 800ms, ~6 failures land inside 5s.
  snapshotTimeoutMs: 800,
  // Verification (killing the scratch Chrome mid-round) measured kill-to-exit at ~8.8s with
  // 5000ms here: 5000ms of accumulated failures + a fixed 2000ms post-round drain + cleanup
  // overhead. Tightened to land closer to the coordinator's "~6s" verification target.
  freezeDetectMs: 3500,      // no game progress (distance/obstacle movement) or no successful snapshot for this long -> frozen
  maxJevCallsPerRound: Number(process.env.DINO_CAP_ROUND) || 600,
  maxJevCallsPerProcess: Number(process.env.DINO_CAP_PROCESS) || 2500,
};

function parseArgs() {
  const runsArg = process.argv.find((a) => a.startsWith('--runs='));
  const transportArg = process.argv.find((a) => a.startsWith('--transport='));
  return {
    runs: runsArg ? parseInt(runsArg.split('=')[1], 10) : 3,
    transport: transportArg ? transportArg.split('=')[1] : 'cdp',
  };
}

// ==================================================================================
// TRANSPORT: cdp -- identical mechanics to v2, wrapped behind the same named-method
// interface the ext transport exposes: connect(), readSnapshot(), pressSpace(), setDuck(bool),
// beforeRoundStart(), close().
// ==================================================================================
function createCdpTransport() {
  let ws = null, send = null, pid = null;

  function cdpConnectWs(wsUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', (e) => reject(new Error('ws error: ' + e.message)));
    });
  }
  function makeSender(socket) {
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    return function (method, params = {}) {
      return new Promise((resolve, reject) => {
        const thisId = ++id;
        pending.set(thisId, { resolve, reject });
        socket.send(JSON.stringify({ id: thisId, method, params }));
      });
    };
  }
  async function evalJson(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async function waitForCdpReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const res = await fetch(`http://127.0.0.1:${port}/json`); if (res.ok) return true; } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }
  async function launchChrome() {
    const child = spawn(
      CHROME_EXE,
      [
        `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`,
        '--no-first-run', '--no-default-browser-check', '--window-size=900,500', 'about:blank',
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    const ready = await waitForCdpReady(CDP_PORT, 15000);
    if (!ready) throw new Error('Chrome CDP endpoint did not come up in time');
    return child.pid;
  }
  async function pickPageTarget() {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const list = await res.json();
    return list.find((t) => t.type === 'page') || list[0];
  }

  const SNAPSHOT_EXPR = `
    (function() {
      const r = Runner.instance_;
      const obs = r.horizon.obstacles.slice(0, ${CONFIG.maxObstaclesPerCall}).map(o => ({
        xPos: o.xPos, yPos: o.yPos, width: o.width, size: o.size,
        height: o.typeConfig ? o.typeConfig.height : undefined,
        typeName: o.typeConfig ? o.typeConfig.type : undefined,
        collisionBoxes: o.collisionBoxes || null,
      }));
      return {
        crashed: r.crashed, started: r.started, currentSpeed: r.currentSpeed, distanceRan: r.distanceRan,
        scoreStr: r.distanceMeter ? r.distanceMeter.digits.join('') : null,
        tRex: {
          xPos: r.tRex.xPos, yPos: r.tRex.yPos, jumping: r.tRex.jumping, ducking: r.tRex.ducking,
          jumpVelocity: r.tRex.jumpVelocity,
        },
        obstacles: obs,
      };
    })()
  `;

  return {
    kind: 'cdp',
    async connect() {
      pid = await launchChrome();
      console.log(`[cdp] Chrome launched, pid=${pid}`);
      const page = await pickPageTarget();
      ws = await cdpConnectWs(page.webSocketDebuggerUrl);
      send = makeSender(ws);
      await send('Runtime.enable');
      await send('Page.enable');
      // The Runner pauses itself on window blur; emulate focus so another window taking the
      // foreground between rounds cannot freeze the game.
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      console.log(`[cdp] Navigating to ${GAME_URL} ...`);
      await send('Page.navigate', { url: GAME_URL });
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try { if (await evalJson(`typeof Runner !== 'undefined' && !!Runner.instance_`)) ready = true; } catch {}
      }
      if (!ready) throw new Error('Runner instance never became available on ' + GAME_URL);
      await new Promise((r) => setTimeout(r, 500));
      const tRexConfig = await evalJson(`Runner.instance_.tRex.config`);
      const groundY = await evalJson(`Runner.instance_.tRex.yPos`);
      return { tRexConfig, groundY };
    },
    async beforeRoundStart() { await send('Page.bringToFront'); },
    async readSnapshot() { return evalJson(SNAPSHOT_EXPR); },
    async pressSpace() {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    },
    async setDuck(holdDown) {
      await send('Input.dispatchKeyEvent', {
        type: holdDown ? 'keyDown' : 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
        windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
      });
    },
    async close() {
      if (ws) try { ws.close(); } catch {}
      if (pid) {
        console.log(`[cdp] Closing Chrome pid=${pid} (this instance only)...`);
        try { execSync(`taskkill /PID ${pid} /T /F`); } catch (e) { console.error('Failed to kill Chrome:', e.message); }
      }
    },
  };
}

// ==================================================================================
// TRANSPORT: ext -- a plain WebSocket SERVER (no ws npm package; hand-rolled RFC 6455 server
// using only Node's http/crypto built-ins, since "no npm installs unless unavoidable" and this
// protocol is simple enough not to need one) that the extension's content.js connects to. This
// transport never touches Chrome itself: the user runs their own browser, loads the unpacked
// extension, and opens https://chromedino.com/ themselves.
// ==================================================================================
function createExtTransport() {
  const crypto = require('crypto');
  let server = null, socket = null, connectResolve = null;
  let reqId = 0;
  const pending = new Map();
  const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

  function frameText(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }
  // Minimal RFC 6455 frame parser: text frames only, handles client->server masking, and
  // reassembles frames split across TCP chunks (tracked via a per-socket leftover buffer).
  function makeFrameReader(onMessage, onClose) {
    let buf = Buffer.alloc(0);
    return function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return; // wait for more data
        let payload = buf.slice(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
          payload = unmasked;
        }
        buf = buf.slice(offset + maskLen + len);
        if (opcode === 0x8) { onClose(); return; } // close frame
        if (opcode === 0x1) onMessage(payload.toString('utf8')); // text frame
        // ping(0x9)/pong(0xA)/binary(0x2) ignored -- not used by this protocol
      }
    };
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      console.log(`[ext] extension connected from ${msg.url}`);
      if (connectResolve) { connectResolve(); connectResolve = null; }
    } else if (msg.type === 'result' && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
    }
  }

  function rpc(method, args) {
    if (!socket) return Promise.reject(new Error('extension not connected'));
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      socket.write(frameText(JSON.stringify({ id, method, args: args || [] })));
    });
  }

  return {
    kind: 'ext',
    async connect() {
      server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
      server.on('upgrade', (req, sock) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) { sock.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
        sock.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        socket = sock;
        sock.on('data', makeFrameReader(handleMessage, () => { socket = null; }));
        sock.on('error', () => { socket = null; });
        sock.on('close', () => { socket = null; });
      });
      await new Promise((resolve, reject) => {
        server.listen(EXT_WS_PORT, '127.0.0.1', resolve);
        server.on('error', reject);
      });
      console.log(`[ext] WebSocket server listening on ws://127.0.0.1:${EXT_WS_PORT}/`);
      console.log('[ext] Waiting for the extension to connect (load it unpacked, then open '
        + `${GAME_URL} in your normal Chrome)...`);
      await new Promise((resolve) => { connectResolve = resolve; });
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        try { if (await rpc('ready')) ready = true; } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready) throw new Error('Runner instance never became available on the extension side');
      const tRexConfig = await rpc('tRexConfig');
      const groundY = await rpc('groundY');
      return { tRexConfig, groundY };
    },
    async beforeRoundStart() { /* no-op: cannot / should not focus the user's real window */ },
    async readSnapshot() { return rpc('snapshot'); },
    async pressSpace() { return rpc('pressSpace'); },
    async setDuck(holdDown) { return rpc('setDuck', [holdDown]); },
    async close() {
      // Never touches Chrome -- only our own local WS server.
      if (server) try { server.close(); } catch {}
    },
  };
}

// ---- physics helpers (identical to v2's post-fix version) ---------------------------------
const FRAME_MS = 1000 / 60;

function collisionWidthOf(o) {
  if (!o.collisionBoxes || !o.collisionBoxes.length) return o.width;
  let minX = Infinity, maxX = -Infinity;
  for (const b of o.collisionBoxes) { minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.width); }
  return Math.max(1, maxX - minX);
}

// NOTE: an earlier version of this file estimated remaining flight time from a single early-game
// measurement (128ms at speed 6.06) scaled by jumpVelocity ratio, and used that estimate to GATE
// the proactive fast-drop decision below. Trace logs showed that estimate badly underestimating
// real flight duration later in a run (the dino was still visibly jumping 500ms+ after press),
// causing the fast-drop to never fire and two crashes while still airborne. Removed; the
// fast-drop decision now uses only directly-measured gap/speed (see msUntilTrigger below), not an
// estimate of flight duration.

function computeJumpWindow(speed, tRexConfig, obstacleWidthPx, nextTriggerMs) {
  const h = tRexConfig.MAX_JUMP_HEIGHT;
  const g = tRexConfig.GRAVITY;
  const flightFrames = 2 * Math.sqrt((2 * h) / g);
  const flightPx = speed * flightFrames;
  const flightMs = flightFrames * FRAME_MS;
  const overlapPx = (obstacleWidthPx || 20) + tRexConfig.WIDTH;
  const marginPx = Math.max(0, (flightPx - overlapPx) / 2);
  let high = Math.max(CONFIG.jumpWindowLowPx + 5, Math.round(marginPx));
  // Two crashes in the last batch (obs38 executed at gap=2, obs39 at gap=15) both came from THIS
  // shrinking the window all the way down to the floor whenever a tight next obstacle was
  // detected, front-loading is good in principle but left ZERO margin against poll granularity /
  // CDP round-trip time for the jump key itself -- by the time gap crossed the shrunk `high`, it
  // was already nearly 0. Soften to half the shrink instead of all the way to the floor: still
  // biases earlier for a tight follow-up, but keeps real margin for THIS obstacle. The
  // proactive fast-drop path (gap-based, not a flight-time estimate -- see below) is what
  // actually handles the next obstacle if this jump runs long, not a razor-thin window here.
  if (nextTriggerMs !== null && nextTriggerMs !== undefined && flightMs > nextTriggerMs) {
    high = Math.max(CONFIG.jumpWindowLowPx + 5, Math.round((high + CONFIG.jumpWindowLowPx + 5) / 2));
  }
  return { low: CONFIG.jumpWindowLowPx, high, flightPx: Math.round(flightPx), flightMs: Math.round(flightMs), overlapPx: Math.round(overlapPx) };
}
function computeDuckWindow(tRexConfig, obstacleWidthPx) {
  return { start: CONFIG.duckStartGapPx, releaseAt: -((obstacleWidthPx || 20) + tRexConfig.WIDTH) };
}
function classifyObstacle(obs, tRexConfig, groundY) {
  if (obs.typeName !== 'PTERODACTYL') return 'ground';
  const height = obs.height || 40;
  const bottom = obs.yPos + height;
  const standingTop = groundY;
  const standingBottom = groundY + tRexConfig.HEIGHT;
  const duckingTop = standingBottom - tRexConfig.HEIGHT_DUCK;
  if (bottom > duckingTop) return 'bird-low';
  if (bottom > standingTop) return 'bird-mid';
  return 'bird-high';
}
function correctActionFor(obsClass) {
  if (obsClass === 'ground' || obsClass === 'bird-low') return 'jump';
  if (obsClass === 'bird-mid') return 'duck';
  return 'none';
}
function describeType(o) {
  if (o.typeName !== 'PTERODACTYL') {
    const base = o.typeName === 'CACTUS_LARGE' ? 'big cactus' : 'small cactus';
    return o.size > 1 ? `${base} group of ${o.size}` : base;
  }
  if (o.obsClass === 'bird-low') return 'bird low';
  if (o.obsClass === 'bird-mid') return 'bird mid';
  return 'bird high';
}

const CRITERIA = {
  jump: 'Jump: this obstacle is a cactus (any group size), or a pterodactyl flying low near the ground. Ducking will NOT clear a low bird or a cactus; only jumping does.',
  duck: 'Duck: this obstacle is a pterodactyl flying at head height. Ducking under it is the only way to avoid it. Never duck for a cactus.',
  none: 'None: this obstacle is a pterodactyl flying high overhead. It will not hit the dino no matter what, so no action is needed.',
};

// ---- obstacle identity tracker (identical to v2) -------------------------------------------
function makeTracker(tRexConfig, groundY) {
  let idCounter = 0;
  let lastTs = null;
  const active = [];
  const history = [];

  function update(snap, nowTs) {
    const dtMs = lastTs === null ? 0 : nowTs - lastTs;
    const predictedDelta = snap.currentSpeed * (60 / 1000) * dtMs;
    lastTs = nowTs;
    const unmatched = active.slice();
    const nextActive = [];
    let newObstacleSeen = false;

    for (const live of snap.obstacles) {
      let best = null, bestDiff = Infinity, bestIdx = -1;
      for (let i = 0; i < unmatched.length; i++) {
        const t = unmatched[i];
        if (t.typeName !== live.typeName) continue;
        const predicted = t.xPos - predictedDelta;
        const diff = Math.abs(predicted - live.xPos);
        if (diff < bestDiff) { bestDiff = diff; best = t; bestIdx = i; }
      }
      if (best && bestDiff <= CONFIG.matchTolerancePx) {
        best.xPos = live.xPos; best.yPos = live.yPos; best.width = live.width;
        best.size = live.size; best.height = live.height;
        unmatched.splice(bestIdx, 1);
        nextActive.push(best);
      } else {
        idCounter++;
        const rec = {
          id: 'obs' + idCounter, typeName: live.typeName, xPos: live.xPos, yPos: live.yPos,
          width: live.width, size: live.size, height: live.height,
          obsClass: classifyObstacle(live, tRexConfig, groundY),
          firstSeenTs: nowTs,
          plan: null, planSeq: 0, firstPlanAtTs: null, firstPlanLeadTimeMs: null,
          triggerReachedTs: null,
          executed: false, executedAtGap: null, executedAtTs: null,
          duckHeld: false, unplannedLogged: false,
        };
        nextActive.push(rec);
        newObstacleSeen = true;
      }
    }
    for (const gone of unmatched) history.push(gone);
    active.length = 0;
    active.push(...nextActive);
    return { newObstacleSeen };
  }

  return { active, history, update };
}

// ---- one experiment round (transport-agnostic) -----------------------------------------------
async function runRound(transport, tRexConfig, groundY, key, roundIndex, logDir, processState) {
  const logPath = path.join(logDir, `run${roundIndex}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const tracker = makeTracker(tRexConfig, groundY);

  let latestSnapshot = null;
  let runActive = true;
  let requestSeq = 0;
  let inFlight = 0;
  const latencies = [];
  let jevCallCount = 0;
  let totalInputTokens = 0;
  let duckActiveId = null;
  let fastDropForId = null;
  let currentJumpStartedTs = null;
  let unplannedCount = 0;
  let crashInfo = null;
  let frozenReason = null;         // set -> whole process aborts after this round
  let capHitLogged = false;
  let consecutiveSnapshotFailures = 0;
  let firstFailureTs = null;
  let lastProgressTs = Date.now();
  let lastProgressSig = null;      // distance + tracked obstacle xPos's, to detect a stuck game

  function pxPerMsFor(speed) { return speed * (60 / 1000); }
  function gapFor(snap, o) { return o.xPos - (snap.tRex.xPos + tRexConfig.WIDTH); }
  function logEvent(obj) { logStream.write(JSON.stringify({ t: Date.now(), ...obj }) + '\n'); }

  async function pipelineTick() {
    if (!runActive || inFlight >= CONFIG.maxInFlight || !latestSnapshot) return;
    const snap = latestSnapshot;
    if (snap.crashed) return;
    // Hard call caps, checked before every launch (not just successes -- a frozen/hung run was
    // still LAUNCHING calls, most of which would time out, not just wasting the ones that
    // resolved). Per-round cap ends just this round; per-process cap also stops all further
    // rounds via processState, checked by main() after this round returns.
    if (requestSeq >= CONFIG.maxJevCallsPerRound) {
      if (!capHitLogged) { capHitLogged = true; logEvent({ kind: 'call_cap', scope: 'round', requestSeq }); }
      runActive = false;
      return;
    }
    if (processState.totalJevCalls >= CONFIG.maxJevCallsPerProcess) {
      if (!capHitLogged) { capHitLogged = true; logEvent({ kind: 'call_cap', scope: 'process', total: processState.totalJevCalls }); }
      processState.capReached = true;
      runActive = false;
      return;
    }
    const candidates = tracker.active.filter((o) => !o.executed).slice(0, CONFIG.maxObstaclesPerCall);
    if (candidates.length === 0) return;

    const pxPerMs = pxPerMsFor(snap.currentSpeed);
    const nowTs = Date.now();
    const details = candidates.map((o, i) => {
      const gap = gapFor(snap, o);
      const estArrivalMs = Math.max(0, gap / Math.max(pxPerMs, 0.01));
      const prev = i > 0 ? candidates[i - 1] : null;
      const gapToPrev = prev ? Math.round(o.xPos - (prev.xPos + prev.width)) : null;
      return { o, gap: Math.round(gap), estArrivalMs: Math.round(estArrivalMs), estArrivalTs: nowTs + estArrivalMs, gapToPrev };
    });

    const lines = details.map((d, i) => {
      const key2 = `o${i + 1}`;
      const kind = describeType(d.o);
      const prevNote = d.gapToPrev === null ? '' : ` The gap from the previous obstacle to this one is ${d.gapToPrev} px.`;
      return `${key2}: ${kind}, width ${d.o.width}px, gap to dino ${d.gap}px, estimated arrival in ${d.estArrivalMs}ms.${prevNote}`;
    });
    const stateText = `Chrome dino runner. Current game speed ${snap.currentSpeed.toFixed(2)} px/frame, distance `
      + `${Math.round(snap.distanceRan)}. Obstacles ahead, nearest first:\n${lines.join('\n')}\n`
      + `Plan the correct action for EACH obstacle listed above, independently.`;

    const questions = {};
    for (let i = 0; i < details.length; i++) {
      questions[`o${i + 1}`] = {
        type: 'choice',
        instructions: `Decide the action for obstacle o${i + 1} (${describeType(details[i].o)}).`,
        criteria: CRITERIA,
      };
    }

    const seq = ++requestSeq;
    processState.totalJevCalls++;
    inFlight++;
    const startTs = Date.now();
    jevCall({ key, state: stateText, questions, timeoutMs: CONFIG.jevTimeoutMs }).then((res) => {
      inFlight--;
      const latencyMs = Date.now() - startTs;
      latencies.push(latencyMs);
      if (!res.ok) {
        logEvent({ kind: 'call_error', seq, error: res.error, latencyMs });
        return;
      }
      jevCallCount++;
      totalInputTokens += (res.usage && res.usage.input_tokens) || 0;
      for (let i = 0; i < details.length; i++) {
        const d = details[i];
        const ans = res.answers && res.answers[`o${i + 1}`];
        if (!ans) continue;
        const obstacle = tracker.active.find((o) => o.id === d.o.id);
        if (!obstacle || obstacle.executed || obstacle.removed) continue;
        if (seq <= obstacle.planSeq) continue;
        obstacle.planSeq = seq;
        obstacle.plan = { choice: ans.choice, confidence: ans.confidence };
        if (obstacle.firstPlanAtTs === null) {
          obstacle.firstPlanAtTs = Date.now();
          obstacle.firstPlanLeadTimeMs = Math.round(d.estArrivalTs - obstacle.firstPlanAtTs);
        }
        logEvent({
          kind: 'plan', id: obstacle.id, type: describeType(obstacle), size: obstacle.size,
          choice: ans.choice, confidence: ans.confidence, latencyMs, leadTimeMs: obstacle.firstPlanLeadTimeMs,
        });
      }
    }).catch((e) => {
      inFlight--;
      logEvent({ kind: 'call_exception', seq, error: String(e) });
    });
  }

  async function executionTick() {
    if (!runActive || !latestSnapshot) return;
    const snap = latestSnapshot;
    if (snap.crashed) return;

    if (duckActiveId) {
      const held = tracker.active.find((o) => o.id === duckActiveId) || tracker.history.find((o) => o.id === duckActiveId);
      if (held) {
        const gap = held.xPos !== undefined ? gapFor(snap, held) : -9999;
        const dw = computeDuckWindow(tRexConfig, collisionWidthOf(held));
        if (gap < dw.releaseAt) { await withTimeout(transport.setDuck(false), CONFIG.snapshotTimeoutMs); duckActiveId = null; }
      } else {
        await withTimeout(transport.setDuck(false), CONFIG.snapshotTimeoutMs); duckActiveId = null;
      }
    }

    if (fastDropForId && !snap.tRex.jumping) {
      const obstacle = tracker.active.find((o) => o.id === fastDropForId);
      fastDropForId = null;
      if (obstacle && !obstacle.executed) {
        const c = obstacle.plan ? obstacle.plan.choice : 'jump';
        if (c === 'duck') {
          duckActiveId = obstacle.id;
        } else {
          await withTimeout(transport.setDuck(false), CONFIG.snapshotTimeoutMs);
          await withTimeout(transport.pressSpace(), CONFIG.snapshotTimeoutMs);
          currentJumpStartedTs = Date.now();
        }
        obstacle.executed = true;
        obstacle.executedAtGap = Math.round(gapFor(snap, obstacle));
        obstacle.executedAtTs = Date.now();
        logEvent({ kind: 'execute', id: obstacle.id, action: c, note: 'post-fast-drop', gap: obstacle.executedAtGap });
      } else {
        await withTimeout(transport.setDuck(false), CONFIG.snapshotTimeoutMs);
      }
    }

    const nearest = tracker.active.find((o) => !o.executed);
    if (!nearest) return;
    const gap = gapFor(snap, nearest);
    const nearestWidth = collisionWidthOf(nearest);

    const next = tracker.active.find((o) => o !== nearest && !o.executed);
    let nextTriggerMs = null;
    if (next) {
      const nextGap = gapFor(snap, next);
      const nextWidth = collisionWidthOf(next);
      const nextJw = computeJumpWindow(snap.currentSpeed, tRexConfig, nextWidth, null);
      const nextTriggerGapPx = next.obsClass === 'bird-mid' ? computeDuckWindow(tRexConfig, nextWidth).start : nextJw.high;
      const pxPerMs = pxPerMsFor(snap.currentSpeed);
      nextTriggerMs = Math.max(0, (nextGap - nextTriggerGapPx) / Math.max(pxPerMs, 0.01));
    }

    const jw = computeJumpWindow(snap.currentSpeed, tRexConfig, nearestWidth, nextTriggerMs);
    const dw = computeDuckWindow(tRexConfig, nearestWidth);
    const triggerHigh = nearest.obsClass === 'bird-mid' ? dw.start : jw.high;

    // Detailed per-tick trace once an obstacle is getting close, throttled to ~every 40ms so it
    // doesn't flood the log at the 16ms poll rate. Answers "was the window too small" vs. "did we
    // see the window open and just fail to act in time" -- the plan/execute events alone don't
    // show the gap trajectory in between.
    if (gap < 200 && (nearest.lastTraceAtTs === undefined || Date.now() - nearest.lastTraceAtTs >= 40)) {
      nearest.lastTraceAtTs = Date.now();
      logEvent({
        kind: 'trace', id: nearest.id, gap: Math.round(gap), jwLow: jw.low, jwHigh: jw.high,
        planChoice: nearest.plan ? nearest.plan.choice : null, jumping: snap.tRex.jumping,
        // jumpElapsedMs is ground-truth data on how long a jump actually stays airborne at this
        // game speed -- kept explicitly because a WRONG estimate of this (128ms, measured once
        // early-game) is exactly what caused the two crashes this fixes; logging the real number
        // every tick means future tuning has real data instead of another single measurement.
        jumpElapsedMs: snap.tRex.jumping && currentJumpStartedTs ? Date.now() - currentJumpStartedTs : null,
        fastDropForId, nextTriggerMs: nextTriggerMs === null ? null : Math.round(nextTriggerMs),
      });
    }

    if (nearest.triggerReachedTs === null && gap <= triggerHigh) nearest.triggerReachedTs = Date.now();

    // PROACTIVE fast-drop, checked BEFORE the "no plan yet" branch below: the obs145 crash (score
    // 1972 run) showed a SECOND way the old ordering missed this. obs145 never got a plan until
    // 521ms after its trigger window opened (a genuinely slow Jev reply), and because the
    // fast-drop check used to live inside the `if (nearest.plan)` branch, it never even ran while
    // `nearest.plan` was still null -- so a still-airborne dino from the PREVIOUS jump just sat
    // there doing nothing while gap ran 177->126->89->63->12 and crashed, still jumping the whole
    // time. Whether to get grounded ASAP is a timing decision, not an action choice, so it can use
    // the locally-computed obsClass (ground truth geometry, not a Jev decision) instead of waiting
    // on Jev's plan: any obstacle that isn't a high-flying bird will need the dino grounded one way
    // or another (jump or duck), so proactively landing is never wrong, only sometimes early.
    const likelyNeedsGrounded = nearest.obsClass !== 'bird-high';
    if (likelyNeedsGrounded && snap.tRex.jumping && fastDropForId !== nearest.id) {
      const pxPerMs = pxPerMsFor(snap.currentSpeed);
      const msUntilTrigger = Math.max(0, (gap - triggerHigh) / Math.max(pxPerMs, 0.01));
      if (msUntilTrigger < CONFIG.fastDropSafetyMarginMs) {
        fastDropForId = nearest.id;
        await withTimeout(transport.setDuck(true), CONFIG.snapshotTimeoutMs);
        logEvent({ kind: 'fast_drop_start', id: nearest.id, gap: Math.round(gap), msUntilTrigger: Math.round(msUntilTrigger), hadPlan: !!nearest.plan });
      }
      return;
    }

    if (!nearest.plan) {
      if (nearest.triggerReachedTs !== null && !nearest.unplannedLogged) {
        nearest.unplannedLogged = true;
        unplannedCount++;
        logEvent({ kind: 'unplanned', id: nearest.id, type: describeType(nearest), gap: Math.round(gap) });
      }
      return;
    }

    const choice = nearest.plan.choice;

    if (choice === 'jump') {
      if (gap > jw.high) return;
      if (snap.tRex.jumping) return;
      await withTimeout(transport.pressSpace(), CONFIG.snapshotTimeoutMs);
      currentJumpStartedTs = Date.now();
      nearest.executed = true;
      nearest.executedAtGap = Math.round(gap);
      nearest.executedAtTs = Date.now();
      logEvent({ kind: 'execute', id: nearest.id, action: 'jump', gap: nearest.executedAtGap, confidence: nearest.plan.confidence });
    } else if (choice === 'duck') {
      if (gap > dw.start) return;
      if (snap.tRex.jumping) return;
      if (duckActiveId !== nearest.id) {
        await withTimeout(transport.setDuck(true), CONFIG.snapshotTimeoutMs);
        duckActiveId = nearest.id;
        nearest.executed = true;
        nearest.executedAtGap = Math.round(gap);
        nearest.executedAtTs = Date.now();
        logEvent({ kind: 'execute', id: nearest.id, action: 'duck', gap: nearest.executedAtGap, confidence: nearest.plan.confidence });
      }
    } else {
      if (gap > jw.high) return;
      nearest.executed = true;
      nearest.executedAtGap = Math.round(gap);
      nearest.executedAtTs = Date.now();
      logEvent({ kind: 'execute', id: nearest.id, action: 'none', gap: nearest.executedAtGap, confidence: nearest.plan.confidence });
    }
  }

  // withTimeout: the actual root cause of the ~8,800-call runaway. When the scratch Chrome
  // closes mid-round, a pending CDP Runtime.evaluate promise (readSnapshot) never resolves OR
  // rejects -- there was no 'close' handling on the socket -- so it just hangs forever. `pollBusy`
  // then stays true forever too, silently freezing the poll loop, while the SEPARATE pipeline
  // timer kept firing against the last-known-good (now stale) snapshot/tracker state forever,
  // re-planning the same obstacle thousands of times. Racing every snapshot read against a
  // timeout turns that hang into an observable failure the watchdog below can act on.
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  function triggerFrozen(reason) {
    if (frozenReason) return; // already handled
    frozenReason = reason;
    processState.frozen = true;
    processState.frozenReason = reason;
    runActive = false;
    logEvent({ kind: 'frozen', reason });
  }

  let pollBusy = false;
  const pollTimer = setInterval(async () => {
    if (pollBusy || !runActive) return;
    pollBusy = true;
    try {
      const snap = await withTimeout(transport.readSnapshot(), CONFIG.snapshotTimeoutMs);
      consecutiveSnapshotFailures = 0;
      firstFailureTs = null;
      latestSnapshot = snap;
      if (snap.crashed) {
        if (runActive) {
          runActive = false;
          let blamed = null, bestAbsGap = Infinity;
          for (const o of tracker.active) {
            const g = Math.abs(gapFor(snap, o));
            if (g < bestAbsGap) { bestAbsGap = g; blamed = o; }
          }
          if (!blamed) blamed = tracker.history[tracker.history.length - 1] || null;
          crashInfo = blamed ? {
            id: blamed.id, type: describeType(blamed), obsClass: blamed.obsClass,
            plan: blamed.plan, executed: blamed.executed, executedAtGap: blamed.executedAtGap,
            correctAction: correctActionFor(blamed.obsClass),
          } : null;
          logEvent({ kind: 'crash', blamed: crashInfo });
        }
        return;
      }
      const { newObstacleSeen } = tracker.update(snap, Date.now());
      // Freeze detection #1: distance and every tracked obstacle's xPos are both part of the
      // signature, so a game that's technically still "running" but not actually advancing
      // (e.g. the tab lost its render loop) is caught too, not just a fully-dead connection.
      const sig = Math.round(snap.distanceRan) + '|' + tracker.active.map((o) => Math.round(o.xPos)).join(',');
      const now = Date.now();
      if (sig !== lastProgressSig) { lastProgressSig = sig; lastProgressTs = now; }
      else if (now - lastProgressTs >= CONFIG.freezeDetectMs) {
        triggerFrozen(`no game progress for ${CONFIG.freezeDetectMs}ms (distance/obstacles unchanged)`);
        return;
      }
      await executionTick();
      if (newObstacleSeen) pipelineTick().catch(() => {});
    } catch (e) {
      // Freeze detection #2: repeated snapshot failures/timeouts, or the transport connection
      // itself closing (CDP socket close / extension disconnect both surface here as a rejected
      // or timed-out readSnapshot call).
      consecutiveSnapshotFailures++;
      if (firstFailureTs === null) firstFailureTs = Date.now();
      const failureMs = Date.now() - firstFailureTs;
      if (failureMs >= CONFIG.freezeDetectMs) {
        triggerFrozen(`snapshot reads failing/timing out for ~${failureMs}ms, ${consecutiveSnapshotFailures} in a row (${e && e.message})`);
      }
    } finally {
      pollBusy = false;
    }
  }, CONFIG.pollIntervalMs);

  let pipelineTimerHandle = null;
  function schedulePipeline() {
    if (!runActive) return;
    let delay = CONFIG.pipelineIntervalMs;
    const nearestForCadence = tracker.active.find((o) => !o.executed);
    if (nearestForCadence && latestSnapshot) {
      const gap = gapFor(latestSnapshot, nearestForCadence);
      const pxPerMs = pxPerMsFor(latestSnapshot.currentSpeed);
      const msToArrival = gap / Math.max(pxPerMs, 0.01);
      if (msToArrival < CONFIG.pipelineFastThresholdMs) delay = CONFIG.pipelineIntervalFastMs;
    }
    pipelineTimerHandle = setTimeout(() => { pipelineTick().catch(() => {}); schedulePipeline(); }, delay);
  }
  schedulePipeline();

  const startTime = Date.now();
  while (runActive) await new Promise((r) => setTimeout(r, 30));
  const durationMs = Date.now() - startTime;
  clearInterval(pollTimer);
  clearTimeout(pipelineTimerHandle);
  // Shorter drain on a frozen exit: those in-flight calls are independent Jev network requests
  // (unaffected by the dead Chrome connection) that will resolve or time out on their own regardless;
  // waiting the full 2s here just delays the clear exit message this whole fix is meant to give.
  const drainDeadline = Date.now() + (frozenReason ? 500 : 2000);
  while (inFlight > 0 && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 50));
  logStream.end();
  // Also needs the timeout wrapper: on a frozen/dead connection this call's underlying CDP
  // promise never resolves OR rejects (no close-handling on the socket), which doesn't hang the
  // whole process (Node exits once the dead socket itself closes and no other handles remain),
  // but it DOES silently abandon this function mid-cleanup -- the round-result and FROZEN console
  // messages below never printed, even though the process exited "successfully" moments later.
  try { await withTimeout(transport.setDuck(false), CONFIG.snapshotTimeoutMs); } catch {}

  const allObstacles = [...tracker.history, ...tracker.active];
  const plannedBeforeArrival = allObstacles.filter((o) => o.triggerReachedTs !== null && o.firstPlanAtTs !== null && o.firstPlanAtTs <= o.triggerReachedTs);
  const everReachedTrigger = allObstacles.filter((o) => o.triggerReachedTs !== null);
  const leadTimes = allObstacles.filter((o) => o.firstPlanLeadTimeMs !== null).map((o) => o.firstPlanLeadTimeMs);
  const avgLeadTimeMs = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null;

  let deathCause = 'none (no crash observed obstacle)';
  if (crashInfo) {
    if (!crashInfo.plan) deathCause = 'unplanned (Jev never answered in time)';
    else if (crashInfo.plan.choice !== crashInfo.correctAction) deathCause = `Jev wrong action (chose ${crashInfo.plan.choice}, needed ${crashInfo.correctAction})`;
    else if (!crashInfo.executed) deathCause = 'timing (correct plan never executed in time)';
    else deathCause = 'timing/physics (correct plan executed but mistimed)';
  }

  const finalScore = parseInt((latestSnapshot && latestSnapshot.scoreStr) || '0', 10);
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  return {
    round: roundIndex, score: finalScore, durationMs, jevCallCount,
    avgLatency, p50: pct(0.5), p90: pct(0.9),
    totalInputTokens, cost: totalInputTokens * CONFIG.costPerInputToken,
    obstacleCount: allObstacles.length, unplannedCount,
    plannedBeforeArrivalPct: everReachedTrigger.length ? Math.round((100 * plannedBeforeArrival.length) / everReachedTrigger.length) : null,
    avgLeadTimeMs: avgLeadTimeMs === null ? null : Math.round(avgLeadTimeMs),
    crashInfo, deathCause, logPath,
  };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const { runs: RUNS, transport: transportKind } = parseArgs();
  if (transportKind !== 'cdp' && transportKind !== 'ext') {
    throw new Error(`--transport must be "cdp" or "ext", got "${transportKind}"`);
  }

  const { key, source } = resolveJevKey({ searchDirs: [AURA_DIR] });
  if (!key) throw new Error('Could not resolve Jev API key from ' + AURA_DIR + '\\.env');
  console.log(`Jev key resolved from ${source}. Transport: ${transportKind}.`);

  const transport = transportKind === 'cdp' ? createCdpTransport() : createExtTransport();

  try {
    const { tRexConfig, groundY } = await transport.connect();
    console.log('tRex config:', tRexConfig, 'groundY:', groundY);

    let warmupTokens = 0;
    {
      const warmStart = Date.now();
      const res = await jevCall({
        key, state: 'Connection warm-up, not a real game state. Just answer yes.',
        questions: { warm: { type: 'noul', instructions: 'Answer yes.' } },
        timeoutMs: CONFIG.jevTimeoutMs,
      });
      if (res.ok) warmupTokens = (res.usage && res.usage.input_tokens) || 0;
      console.log(`Warm-up call: ${Date.now() - warmStart}ms, ok=${res.ok}`);
    }

    const processState = { totalJevCalls: 0, frozen: false, frozenReason: null, capReached: false };
    const results = [];
    for (let i = 1; i <= RUNS; i++) {
      console.log(`\n=== Round ${i}/${RUNS}: pressing Space to start ===`);
      // Batch-of-20 calibration found bad rounds clustering right after long inter-round
      // cooldowns: e.g. round 1 (880, healthy) -> round 2 (45, all 3 calls ~1750ms) -> round 3
      // (44, same pattern) -> round 4 (579, healthy) -> round 5 (45, same pattern again). The
      // ONE-TIME warm-up before round 1 doesn't help later rounds if the underlying HTTP
      // connection goes idle/stale during a multi-second cooldown; re-warm before EVERY round,
      // but (matching the earlier warm-up-placement fix) BEFORE pressSpace so it doesn't eat
      // into monitored game time.
      // Round 1 still hit the connection-latency spike once (2070-2280ms, 'unplanned' death) even
      // with the global pre-loop warm-up: the `i > 1` guard skipped round 1's OWN re-warm, and
      // whatever gap exists between the global warm-up and round 1's first real call was enough
      // for the connection to go stale again. Re-warm before every round, no exception.
      {
        const rewarmStart = Date.now();
        const rewarmRes = await jevCall({
          key, state: 'Connection re-warm, not a real game state. Just answer yes.',
          questions: { warm: { type: 'noul', instructions: 'Answer yes.' } },
          timeoutMs: CONFIG.jevTimeoutMs,
        });
        console.log(`[re-warm before round ${i}] ${Date.now() - rewarmStart}ms, ok=${rewarmRes.ok}`);
        if (rewarmRes.ok) warmupTokens += (rewarmRes.usage && rewarmRes.usage.input_tokens) || 0;
      }
      await transport.beforeRoundStart();
      let started = false;
      await transport.pressSpace();
      for (let j = 0; j < 100 && !started; j++) {
        await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
        const snap = await transport.readSnapshot();
        if (snap.started && !snap.crashed) started = true;
        else if (j % 20 === 19) await transport.pressSpace();
      }
      if (!started) throw new Error(`Round ${i}: game never started`);

      const result = await runRound(transport, tRexConfig, groundY, key, i, SCRATCH_DIR, processState);
      results.push(result);
      if (processState.frozen) {
        console.log(`\n!!! FROZEN GAME DETECTED: ${processState.frozenReason} !!!`);
        console.log(`Round ${i} ended early and the run is stopping now (no further rounds) to avoid wasting Jev calls on a dead session.`);
      }
      if (processState.capReached) {
        console.log(`\n!!! Jev call cap reached (${CONFIG.maxJevCallsPerProcess} calls this process) -- stopping, no further rounds. !!!`);
      }
      console.log(`Round ${i} result:`, {
        score: result.score, durationMs: result.durationMs, jevCalls: result.jevCallCount,
        avgLatency: Math.round(result.avgLatency), p50: result.p50, p90: result.p90,
        obstacles: result.obstacleCount, unplanned: result.unplannedCount,
        plannedBeforeArrivalPct: result.plannedBeforeArrivalPct, avgLeadTimeMs: result.avgLeadTimeMs,
        deathCause: result.deathCause, cost: result.cost.toFixed(6),
      });
      if (processState.frozen || processState.capReached) break; // stop the whole run, no more rounds
      // Scaling this UP with call count (the original fix) turned out to likely be
      // counterproductive under the idle-connection theory above: a longer gap with zero network
      // activity gives the connection MORE time to go stale, not less. A flat, short cooldown
      // (just enough for the game's own GAMEOVER_CLEAR_TIME, 750ms, to elapse) plus the re-warm
      // call above is the combination actually being tested now.
      await new Promise((r) => setTimeout(r, 1200));
    }

    console.log(`\n================ SUMMARY (v3, transport=${transportKind}) ================`);
    let totalCalls = 1, totalCost = warmupTokens * CONFIG.costPerInputToken, bestScore = -1, bestRound = null;
    for (const r of results) {
      totalCalls += r.jevCallCount;
      totalCost += r.cost;
      if (r.score > bestScore) { bestScore = r.score; bestRound = r.round; }
      console.log(
        `Run ${r.round}: score=${r.score} duration=${(r.durationMs / 1000).toFixed(1)}s calls=${r.jevCallCount} `
        + `avgLat=${Math.round(r.avgLatency)}ms p50=${r.p50}ms p90=${r.p90}ms obstacles=${r.obstacleCount} `
        + `unplanned=${r.unplannedCount} plannedBeforeArrival=${r.plannedBeforeArrivalPct}% avgLead=${r.avgLeadTimeMs}ms `
        + `death="${r.deathCause}" log=${r.logPath}`
      );
    }
    console.log(`Best score: ${bestScore} (run ${bestRound})`);
    console.log(`Total Jev calls: ${totalCalls}, total input-token cost: $${totalCost.toFixed(6)}`);
    if (processState.frozen) console.log(`\nSTOPPED EARLY: frozen game detected (${processState.frozenReason}). Ran ${results.length}/${RUNS} requested rounds.`);
    if (processState.capReached) console.log(`\nSTOPPED EARLY: Jev call cap reached. Ran ${results.length}/${RUNS} requested rounds.`);
  } finally {
    await transport.close();
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
