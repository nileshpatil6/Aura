// v2: TypeSafe Jev plays Chrome's dino runner via LOOKAHEAD PLANNING over up to 4 obstacles at
// once, instead of v1's single-nearest-obstacle reactive loop. Jev still makes every jump/duck/
// none decision; this script only tracks obstacle identity across frames, asks Jev to plan all
// visible obstacles in one batched call, caches the newest answer per obstacle, and executes each
// plan's action locally when physics says the trigger window has arrived. v1 (dino_jev.js) is left
// untouched. Scratch-only; does not modify the Aura repo except requiring its existing jev.js /
// env-keys.js helpers (read-only).

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AURA_DIR = path.join(__dirname, '..');
const { jevCall } = require(path.join(AURA_DIR, 'src', 'jev.js'));
const { resolveJevKey } = require(path.join(AURA_DIR, 'src', 'env-keys.js'));

const SCRATCH_DIR = __dirname;
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(SCRATCH_DIR, 'profile'); // same profile dir v1 uses; never run both at once
const CDP_PORT = 9223;
const GAME_URL = 'https://chromedino.com/'; // see v1's dino_jev.js header for why not chrome://dino

// ---- tunable knobs ----------------------------------------------------------
const CONFIG = {
  pollIntervalMs: 16,       // fast execution-timing loop
  pipelineIntervalMs: 250,  // Jev planning cadence
  maxInFlight: 3,
  jevTimeoutMs: 4000,
  maxObstaclesPerCall: 4,
  jumpWindowLowPx: 15,
  duckStartGapPx: 40,       // start ducking this many px before the bird's front edge would arrive
  matchTolerancePx: 40,     // obstacle-identity nearest-neighbor tolerance between polls
  costPerInputToken: 0.042 / 1_000_000,
};

const RUNS = (() => {
  const arg = process.argv.find((a) => a.startsWith('--runs='));
  return arg ? parseInt(arg.split('=')[1], 10) : 3;
})();

// ---- minimal CDP client (Node 22 global WebSocket + fetch) -----------------
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + e.message)));
  });
}
function makeSender(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const thisId = ++id;
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  };
}
async function evalJson(send, expression) {
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

// ---- game IO ------------------------------------------------------------------
async function pressSpace(send) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
}
async function setDuck(send, holdDown) {
  await send('Input.dispatchKeyEvent', {
    type: holdDown ? 'keyDown' : 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
    windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
  });
}

// `size` (1-3) is the cluster count baked into a single obstacle instance (verified via probe:
// a size=2 CACTUS_SMALL already reports width=34 vs. a lone unit's typeConfig.width=17), so no
// merging of separate array entries is needed for "group of N" obstacles.
const SNAPSHOT_EXPR = `
  (function() {
    const r = Runner.instance_;
    const obs = r.horizon.obstacles.slice(0, ${CONFIG.maxObstaclesPerCall}).map(o => ({
      xPos: o.xPos, yPos: o.yPos, width: o.width, size: o.size,
      height: o.typeConfig ? o.typeConfig.height : undefined,
      typeName: o.typeConfig ? o.typeConfig.type : undefined,
    }));
    return {
      crashed: r.crashed, started: r.started, currentSpeed: r.currentSpeed, distanceRan: r.distanceRan,
      scoreStr: r.distanceMeter ? r.distanceMeter.digits.join('') : null,
      tRex: { xPos: r.tRex.xPos, yPos: r.tRex.yPos, jumping: r.tRex.jumping, ducking: r.tRex.ducking },
      obstacles: obs,
    };
  })()
`;
async function readSnapshot(send) { return evalJson(send, SNAPSHOT_EXPR); }
async function readTRexConfig(send) { return evalJson(send, `Runner.instance_.tRex.config`); }

// ---- physics helpers (same formulas v1 calibrated) ----------------------------
// See v1 dino_jev.js for the derivation notes (fixed MIN==MAX_JUMP_HEIGHT apex, width-centered
// margin). Reused verbatim here since the underlying game physics are identical.
function computeJumpWindow(speed, tRexConfig, obstacleWidthPx) {
  const h = tRexConfig.MAX_JUMP_HEIGHT;
  const g = tRexConfig.GRAVITY;
  const flightFrames = 2 * Math.sqrt((2 * h) / g);
  const flightPx = speed * flightFrames;
  const overlapPx = (obstacleWidthPx || 20) + tRexConfig.WIDTH;
  const marginPx = Math.max(0, (flightPx - overlapPx) / 2);
  const high = Math.max(CONFIG.jumpWindowLowPx + 5, Math.round(marginPx));
  return { low: CONFIG.jumpWindowLowPx, high, flightPx: Math.round(flightPx), overlapPx: Math.round(overlapPx) };
}
// Ducking has no flight arc: start holding down shortly before the bird's front edge arrives,
// release once its trailing edge has cleared the dino's front edge.
function computeDuckWindow(tRexConfig, obstacleWidthPx) {
  return { start: CONFIG.duckStartGapPx, releaseAt: -((obstacleWidthPx || 20) + tRexConfig.WIDTH) };
}

// Bug found via live observation + BIRD_DEBUG dump: `groundY` (Runner.instance_.tRex.yPos while
// standing, 93) is the TOP of the dino's sprite, not a ground line to subtract HEIGHT from --
// confirmed by groundY + tRexConfig.HEIGHT (93+47=140) == canvas HEIGHT(150) - BOTTOM_PAD(10). The
// original version subtracted HEIGHT/HEIGHT_DUCK from groundY, inverting the standing/ducking spans,
// so every observed bird tier (yPos 50/75/100, height 40) classified as 'bird-low' (jump) -- matching
// the reported symptom of birds that should be ducked always getting jumped instead. Corrected spans,
// anchored at the dino's fixed BOTTOM (groundY + HEIGHT): standing top=groundY, ducking top=bottom-
// HEIGHT_DUCK (ducking shrinks from the top, feet stay planted).
function classifyObstacle(obs, tRexConfig, groundY) {
  if (obs.typeName !== 'PTERODACTYL') return 'ground';
  const height = obs.height || 40;
  const bottom = obs.yPos + height;
  const standingTop = groundY;
  const standingBottom = groundY + tRexConfig.HEIGHT;
  const duckingTop = standingBottom - tRexConfig.HEIGHT_DUCK;
  if (bottom > duckingTop) return 'bird-low';  // dips into the ducking dino's span too -> must jump
  if (bottom > standingTop) return 'bird-mid'; // overlaps the standing dino only -> duck clears it
  return 'bird-high';                          // entirely above the standing dino -> passes overhead
}
// Ground truth for scoring Jev's own accuracy in the report (not used to pick the action).
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

// ---- obstacle identity tracker --------------------------------------------------
// horizon.obstacles only grows at the tail (new spawns) and shrinks at the head (fully scrolled
// off-screen); relative order never changes since every obstacle moves at the same speed. So a
// simple nearest-predicted-xPos match (same type, predicted using last speed*dt) is a robust,
// order-preserving identity scheme -- explicitly NOT plain array index, which would misattribute
// an in-flight plan to the wrong obstacle the moment the nearest one is spliced out.
function makeTracker(tRexConfig, groundY) {
  let idCounter = 0;
  let lastTs = null;
  const active = []; // ordered nearest -> farthest, stable .id
  const history = []; // completed (removed) records, for the final report

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
        if (process.env.DEBUG_BIRDS && live.typeName === 'PTERODACTYL') {
          const duckingTop = groundY - tRexConfig.HEIGHT_DUCK, standingTop = groundY - tRexConfig.HEIGHT;
          console.log('BIRD_DEBUG', { id: rec.id, yPos: live.yPos, height: live.height, obsClass: rec.obsClass, duckingTop, standingTop, groundY });
        }
      }
    }
    // anything left in `unmatched` fell off the live list (scrolled fully off-screen) -> archive it
    for (const gone of unmatched) history.push(gone);
    active.length = 0;
    active.push(...nextActive);
    return { newObstacleSeen };
  }

  return { active, history, update };
}

// ---- one experiment round -----------------------------------------------------
async function runRound(send, tRexConfig, groundY, key, roundIndex, logDir) {
  const logPath = path.join(logDir, `run${roundIndex}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const tracker = makeTracker(tRexConfig, groundY);

  let totalInputTokensWarmup = 0;
  // Calibration round 1 died 'unplanned' on the very first obstacle: pipelineTick only fires once
  // an obstacle exists, so the FIRST Jev call of the round ate the ~2s cold-start latency exactly
  // when the timing mattered. Pay that cost here, before any obstacle exists (v1 never had this bug
  // because its pipeline fired unconditionally every 130ms from the start, incidentally warming up
  // the connection). Not counted in decision-latency stats; its token cost still is.
  {
    const warmStart = Date.now();
    const res = await jevCall({
      key, state: 'Connection warm-up, not a real game state. Just answer yes.',
      questions: { warm: { type: 'noul', instructions: 'Answer yes.' } },
      timeoutMs: CONFIG.jevTimeoutMs,
    });
    const warmLatencyMs = Date.now() - warmStart;
    if (res.ok) totalInputTokensWarmup = (res.usage && res.usage.input_tokens) || 0;
    logStream.write(JSON.stringify({ t: Date.now(), kind: 'warmup', latencyMs: warmLatencyMs, ok: res.ok }) + '\n');
  }

  let latestSnapshot = null;
  let runActive = true;
  let requestSeq = 0;
  let inFlight = 0;
  const latencies = [];
  let jevCallCount = 0;
  let totalInputTokens = 0;
  let duckActiveId = null;       // obstacle id currently holding the duck key
  let fastDropForId = null;      // obstacle id waiting for a fast-drop landing before its jump
  let unplannedCount = 0;
  let crashInfo = null;

  function pxPerMsFor(speed) { return speed * (60 / 1000); }
  function gapFor(snap, o) { return o.xPos - (snap.tRex.xPos + tRexConfig.WIDTH); }

  function logEvent(obj) { logStream.write(JSON.stringify({ t: Date.now(), ...obj }) + '\n'); }

  async function pipelineTick() {
    if (!runActive || inFlight >= CONFIG.maxInFlight || !latestSnapshot) return;
    const snap = latestSnapshot;
    if (snap.crashed) return;
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
      const key = `o${i + 1}`;
      const kind = describeType(d.o);
      const prevNote = d.gapToPrev === null ? '' : ` The gap from the previous obstacle to this one is ${d.gapToPrev} px.`;
      return `${key}: ${kind}, width ${d.o.width}px, gap to dino ${d.gap}px, estimated arrival in ${d.estArrivalMs}ms.${prevNote}`;
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
        if (!obstacle || obstacle.executed || obstacle.removed) continue; // locked or gone
        if (seq <= obstacle.planSeq) continue; // stale answer, newer already applied
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

  // fast execution loop: local timing only, action always comes from `.plan.choice`
  async function executionTick() {
    if (!runActive || !latestSnapshot) return;
    const snap = latestSnapshot;
    if (snap.crashed) return;

    // release a held duck once its obstacle has cleared, regardless of execution order
    if (duckActiveId) {
      const held = tracker.active.find((o) => o.id === duckActiveId) || tracker.history.find((o) => o.id === duckActiveId);
      if (held) {
        const gap = held.xPos !== undefined ? gapFor(snap, held) : -9999;
        const dw = computeDuckWindow(tRexConfig, held.width);
        if (gap < dw.releaseAt) { await setDuck(send, false); duckActiveId = null; }
      } else {
        await setDuck(send, false); duckActiveId = null;
      }
    }

    // finish a pending fast-drop once landed, then jump for the obstacle that requested it
    if (fastDropForId && !snap.tRex.jumping) {
      await setDuck(send, false);
      const obstacle = tracker.active.find((o) => o.id === fastDropForId);
      fastDropForId = null;
      if (obstacle && !obstacle.executed) {
        await pressSpace(send);
        obstacle.executed = true;
        obstacle.executedAtGap = Math.round(gapFor(snap, obstacle));
        obstacle.executedAtTs = Date.now();
        logEvent({ kind: 'execute', id: obstacle.id, action: 'jump', note: 'post-fast-drop', gap: obstacle.executedAtGap });
      }
    }

    const nearest = tracker.active.find((o) => !o.executed);
    if (!nearest) return;
    const gap = gapFor(snap, nearest);
    const jw = computeJumpWindow(snap.currentSpeed, tRexConfig, nearest.width);
    const dw = computeDuckWindow(tRexConfig, nearest.width);
    const triggerHigh = nearest.obsClass === 'bird-mid' ? dw.start : jw.high;

    if (nearest.triggerReachedTs === null && gap <= triggerHigh) nearest.triggerReachedTs = Date.now();

    if (!nearest.plan) {
      if (nearest.triggerReachedTs !== null && !nearest.unplannedLogged) {
        nearest.unplannedLogged = true;
        unplannedCount++;
        logEvent({ kind: 'unplanned', id: nearest.id, type: describeType(nearest), gap: Math.round(gap) });
      }
      return; // no local fallback: only Jev's plan drives the action
    }

    const choice = nearest.plan.choice;
    if (choice === 'jump') {
      if (gap > jw.high) return; // not time yet
      if (snap.tRex.jumping) {
        // back-to-back: still airborne from a previous obstacle. Fast-drop (ArrowDown while
        // airborne triggers the game's speedDrop / DROP_VELOCITY) to land early, then jump.
        if (fastDropForId !== nearest.id) {
          fastDropForId = nearest.id;
          await setDuck(send, true);
          logEvent({ kind: 'fast_drop_start', id: nearest.id, gap: Math.round(gap) });
        }
        return;
      }
      await pressSpace(send);
      nearest.executed = true;
      nearest.executedAtGap = Math.round(gap);
      nearest.executedAtTs = Date.now();
      logEvent({ kind: 'execute', id: nearest.id, action: 'jump', gap: nearest.executedAtGap, confidence: nearest.plan.confidence });
    } else if (choice === 'duck') {
      if (gap > dw.start) return;
      if (!snap.tRex.jumping && duckActiveId !== nearest.id) {
        await setDuck(send, true);
        duckActiveId = nearest.id;
        nearest.executed = true;
        nearest.executedAtGap = Math.round(gap);
        nearest.executedAtTs = Date.now();
        logEvent({ kind: 'execute', id: nearest.id, action: 'duck', gap: nearest.executedAtGap, confidence: nearest.plan.confidence });
      }
    } else { // 'none'
      if (gap > jw.high) return;
      nearest.executed = true;
      nearest.executedAtGap = Math.round(gap);
      nearest.executedAtTs = Date.now();
      logEvent({ kind: 'execute', id: nearest.id, action: 'none', gap: nearest.executedAtGap, confidence: nearest.plan.confidence });
    }
  }

  let pollBusy = false;
  const pollTimer = setInterval(async () => {
    if (pollBusy || !runActive) return;
    pollBusy = true;
    try {
      const snap = await readSnapshot(send);
      latestSnapshot = snap;
      if (snap.crashed) {
        if (runActive) {
          runActive = false;
          // Blame whichever tracked obstacle's gap is closest to zero at the moment of the crash,
          // not just the first one in the array: a harmless high-flying bird can still be "active"
          // (not yet scrolled fully off-screen) well after it stopped being relevant, and naively
          // picking array-order-first wrongly pinned a crash on a 'none'-correctly-planned bird when
          // the real collision was with the next obstacle behind it.
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
      await executionTick();
      if (newObstacleSeen) pipelineTick().catch(() => {});
    } catch {
    } finally {
      pollBusy = false;
    }
  }, CONFIG.pollIntervalMs);
  const pipelineTimer = setInterval(() => pipelineTick().catch(() => {}), CONFIG.pipelineIntervalMs);

  const startTime = Date.now();
  while (runActive) await new Promise((r) => setTimeout(r, 30));
  const durationMs = Date.now() - startTime;
  clearInterval(pollTimer);
  clearInterval(pipelineTimer);
  const drainDeadline = Date.now() + 2000;
  while (inFlight > 0 && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 50));
  logStream.end();

  // release any held key so it doesn't bleed into the restart
  try { await setDuck(send, false); } catch {}

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
  const totalInputTokensAll = totalInputTokens + totalInputTokensWarmup;

  return {
    round: roundIndex, score: finalScore, durationMs, jevCallCount: jevCallCount + 1 /* +warmup */,
    avgLatency, p50: pct(0.5), p90: pct(0.9),
    totalInputTokens: totalInputTokensAll, cost: totalInputTokensAll * CONFIG.costPerInputToken,
    obstacleCount: allObstacles.length, unplannedCount,
    plannedBeforeArrivalPct: everReachedTrigger.length ? Math.round((100 * plannedBeforeArrival.length) / everReachedTrigger.length) : null,
    avgLeadTimeMs: avgLeadTimeMs === null ? null : Math.round(avgLeadTimeMs),
    crashInfo, deathCause, logPath,
  };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const { key, source } = resolveJevKey({ searchDirs: [AURA_DIR] });
  if (!key) throw new Error('Could not resolve Jev API key from ' + AURA_DIR + '\\.env');
  console.log(`Jev key resolved from ${source}. Launching Chrome...`);

  const pid = await launchChrome();
  console.log(`Chrome launched, pid=${pid}`);

  try {
    const page = await pickPageTarget();
    const ws = await cdpConnect(page.webSocketDebuggerUrl);
    const send = makeSender(ws);
    await send('Runtime.enable');
    await send('Page.enable');

    console.log(`Navigating to ${GAME_URL} ...`);
    await send('Page.navigate', { url: GAME_URL });
    // NOTE: this clone's `imagesLoaded` is a dead counter that never leaves 0 (verified via probe),
    // unlike stock chromium's dino -- not a usable readiness signal here. Runner.instance_ existing
    // plus a short settle wait (matching v1, which was reliable across 7 runs) is what we use instead.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { if (await evalJson(send, `typeof Runner !== 'undefined' && !!Runner.instance_`)) ready = true; } catch {}
    }
    if (!ready) throw new Error('Runner instance never became available on ' + GAME_URL);
    await new Promise((r) => setTimeout(r, 500));

    const tRexConfig = await readTRexConfig(send);
    const groundY = await evalJson(send, `Runner.instance_.tRex.yPos`);
    console.log('tRex config:', tRexConfig, 'groundY:', groundY);

    const results = [];
    for (let i = 1; i <= RUNS; i++) {
      console.log(`\n=== Round ${i}/${RUNS}: pressing Space to start ===`);
      await send('Page.bringToFront');
      let started = false;
      for (let j = 0; j < 20 && !started; j++) {
        await pressSpace(send);
        await new Promise((r) => setTimeout(r, 500));
        const snap = await readSnapshot(send);
        if (snap.started && !snap.crashed) started = true;
      }
      if (!started) throw new Error(`Round ${i}: game never started`);

      const result = await runRound(send, tRexConfig, groundY, key, i, SCRATCH_DIR);
      results.push(result);
      console.log(`Round ${i} result:`, {
        score: result.score, durationMs: result.durationMs, jevCalls: result.jevCallCount,
        avgLatency: Math.round(result.avgLatency), p50: result.p50, p90: result.p90,
        obstacles: result.obstacleCount, unplanned: result.unplannedCount,
        plannedBeforeArrivalPct: result.plannedBeforeArrivalPct, avgLeadTimeMs: result.avgLeadTimeMs,
        deathCause: result.deathCause, cost: result.cost.toFixed(6),
      });
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log('\n================ SUMMARY (v2, lookahead planning) ================');
    let totalCalls = 0, totalCost = 0, bestScore = -1, bestRound = null;
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

    ws.close();
  } finally {
    console.log(`\nClosing Chrome pid=${pid} (this instance only)...`);
    try { execSync(`taskkill /PID ${pid} /T /F`); } catch (e) { console.error('Failed to kill Chrome:', e.message); }
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
