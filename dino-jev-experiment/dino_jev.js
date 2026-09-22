// Throwaway experiment: TypeSafe Jev plays Chrome's dino runner.
// Every jump/duck/wait decision is made by Jev; this script only polls game
// state, projects it forward by expected Jev latency, and applies whichever
// answer arrives newest. No local override ever picks the action itself.
//
// Scratch-only. Does not touch the Aura repo except `require`-ing its
// existing jev.js / env-keys.js helpers (read-only).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const AURA_DIR = path.join(__dirname, '..');
const { jevCall } = require(path.join(AURA_DIR, 'src', 'jev.js'));
const { resolveJevKey } = require(path.join(AURA_DIR, 'src', 'env-keys.js'));

const SCRATCH_DIR = __dirname;
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(SCRATCH_DIR, 'profile');
const CDP_PORT = 9223;
const GAME_URL = 'https://chromedino.com/'; // chrome://dino is an error-page interstitial that
// periodically re-checks connectivity and can tear down its own JS context (verified: Runner.instance_
// went undefined mid-session). chromedino.com hosts the same unmodified Runner/tRex/Horizon source in a
// normal page, so it was used instead, per the spec's documented fallback.

// ---- tunable knobs (adjust between calibration rounds) --------------------
const CONFIG = {
  pollIntervalMs: 20,
  pipelineIntervalMs: 130,
  maxInFlight: 4,
  jevTimeoutMs: 4000,
  startEmaLatencyMs: 450,
  emaAlpha: 0.3,
  jumpWindowLowPx: 15,
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
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function launchChrome() {
  const child = spawn(
    CHROME_EXE,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=900,500',
      'about:blank',
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

// ---- game IO ----------------------------------------------------------------
async function pressSpace(send) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
  });
}

async function setDuck(send, holdDown) {
  await send('Input.dispatchKeyEvent', {
    type: holdDown ? 'keyDown' : 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
    windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
  });
}

// Single batched read of everything the decision loop and logging need.
const SNAPSHOT_EXPR = `
  (function() {
    const r = Runner.instance_;
    const obs = r.horizon.obstacles.slice(0, 2).map(o => ({
      xPos: o.xPos, yPos: o.yPos, width: o.width, height: o.typeConfig ? o.typeConfig.height : undefined,
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

async function readSnapshot(send) {
  return evalJson(send, SNAPSHOT_EXPR);
}

// tRex.config is static for the whole session; read it once.
async function readTRexConfig(send) {
  return evalJson(send, `Runner.instance_.tRex.config`);
}

// ---- physics helpers ---------------------------------------------------------
// Calibration round 1 used the naive v0-based free-flight formula (2*|v0|/g frames) and it
// overshot badly: MIN_JUMP_HEIGHT == MAX_JUMP_HEIGHT == 30 in this build, meaning every tap
// (however brief) reaches the SAME ~30px apex, not the ~93px a free-flight v0=10.6 would imply.
// The observed crash landed the dino exactly as the obstacle arrived, consistent with a real
// flight of ~330ms rather than the ~580ms the naive formula assumed. Using the fixed apex height
// directly gives a much closer estimate: h=v0^2/(2g) => t_up=sqrt(2h/g), total flight=2*t_up frames.
//
// Calibration round 2 fixed that but still crashed: it jumped at gap~93px, which used up most of
// the (now short, ~330ms) flight before the obstacle even arrived, so the dino landed a beat
// before the obstacle's trailing edge cleared the dino's front edge. Total flight time is fixed
// by the apex height, not by when you press, so the obstacle's own width matters: the slack
// available to jump "early" is (flightPx - overlapPx) / 2, split roughly evenly before/after the
// obstacle's horizontal overlap with the dino. Wider obstacles get a narrower, later window.
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

// Calibration round 3: after clearing the first cactus cleanly, the dino died on a second, closely
// trailing cactus that Jev kept answering "wait" for all the way down to gap 0. Cause found in the
// logs: `obstacles[0]` stayed pinned on the FIRST cactus long after it had physically passed under
// the dino (gap going to -100, -150...), because the horizon only drops an obstacle from the array
// once it scrolls fully off the left edge of the canvas, not as soon as the dino clears it. That
// meant the second, closer cactus (already visible in `obstacles[1]`) was never surfaced to Jev
// until the stale one finally fell off-screen -- by then the real gap was already ~0. Fix: pick the
// first obstacle whose trailing edge hasn't yet passed the dino's leading edge, not just index 0.
function pickPrimaryObstacle(obstacles, tRexXPos) {
  for (const o of obstacles) {
    if (o.xPos + o.width >= tRexXPos) return o;
  }
  return null;
}

// Classifies the nearest obstacle against the dino's standing vs. ducking vertical span (both share
// the same 93px ground line; HEIGHT/HEIGHT_DUCK come from tRex.config, read once at startup).
function classifyObstacle(obs, tRexConfig, groundY) {
  if (!obs) return null;
  if (obs.typeName !== 'PTERODACTYL') return 'ground'; // cacti: always a jump obstacle, never duck
  const height = obs.height || 40; // fallback: sprite height wasn't exposed on every obstacle instance
  const bottom = obs.yPos + height;
  const duckingTop = groundY - tRexConfig.HEIGHT_DUCK;
  const standingTop = groundY - tRexConfig.HEIGHT;
  if (bottom > duckingTop) return 'bird-low'; // dips below ducking dino's head too -> must jump like a cactus
  if (bottom > standingTop) return 'bird-mid'; // between ducking and standing head height -> duck clears it
  return 'bird-high'; // entirely above standing dino's head -> passes overhead, no action needed
}

function buildState({ speed, gapPx, obsType, obsClass, jumpWindow, distanceRan }) {
  let obstacleDesc;
  if (!obsType) {
    obstacleDesc = 'No obstacle is currently near the dino.';
  } else {
    const kind = obsType === 'CACTUS_SMALL' ? 'a small cactus'
      : obsType === 'CACTUS_LARGE' ? 'a large cactus'
      : 'a flying pterodactyl';
    let heightNote = '';
    if (obsClass === 'bird-low') heightNote = ' flying low near the ground; ducking will NOT avoid it, it must be jumped like a cactus';
    else if (obsClass === 'bird-mid') heightNote = ' flying at head height; ducking under it avoids it';
    else if (obsClass === 'bird-high') heightNote = ' flying high overhead; it will not hit the dino no matter what';
    obstacleDesc = `The nearest obstacle is ${kind}${heightNote}. Its gap to the dino's front edge is ${gapPx} px `
      + `(negative means it is already at or has passed the dino's position).`;
  }
  return `Chrome dino runner game, endless side-scroller. The dino runs left to right at a fixed screen `
    + `position; obstacles approach from the right. Current game speed is ${speed.toFixed(2)} px per animation `
    + `frame, distance so far ${Math.round(distanceRan)}. ${obstacleDesc} A jump works when the gap is between `
    + `${jumpWindow.low} and ${jumpWindow.high} px at this speed (a jump carries the dino about ${jumpWindow.flightPx} `
    + `px forward while airborne, so jumping much earlier or later than this window misses).`;
}

const CRITERIA = {
  jump: 'Jump now: a cactus, or a low/ground-level pterodactyl, is inside or about to enter the jump window described in the state; jumping now will clear it.',
  duck: 'Duck now: a pterodactyl is flying at head height right in front of the dino; ducking under it is the only way to avoid it. Never duck for a cactus.',
  wait: 'Do nothing: there is no obstacle close enough yet, the obstacle has already passed, or it is a high-flying pterodactyl that will not hit the dino regardless of action.',
};

// ---- one experiment round -----------------------------------------------------
async function runRound(send, tRexConfig, groundY, key, roundIndex, logDir) {
  const logPath = path.join(logDir, `run${roundIndex}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  let latestSnapshot = null;
  let runActive = true;
  let duckHeld = false;
  let requestSeq = 0;
  let lastAppliedSeq = 0;
  let inFlight = 0;
  let emaLatency = CONFIG.startEmaLatencyMs;
  const latencies = [];
  let jevCallCount = 0;
  let jumpCount = 0;
  let totalInputTokens = 0;
  let lastKnownObstacle = null;
  let lastAppliedDecision = null; // { gapPx, choice, latencyMs } for death-cause reporting

  async function applyDecision(choice) {
    const cur = latestSnapshot;
    if (!cur || cur.crashed) return;
    if (choice === 'jump') {
      if (duckHeld) { duckHeld = false; await setDuck(send, false); }
      if (!cur.tRex.jumping) await pressSpace(send);
    } else if (choice === 'duck') {
      if (!cur.tRex.jumping && !duckHeld) { duckHeld = true; await setDuck(send, true); }
    } else {
      if (duckHeld) { duckHeld = false; await setDuck(send, false); }
    }
  }

  function pipelineTick() {
    if (!runActive || inFlight >= CONFIG.maxInFlight || !latestSnapshot) return;
    const snap = latestSnapshot;
    if (snap.crashed) return;
    const nearest = pickPrimaryObstacle(snap.obstacles, snap.tRex.xPos);
    if (nearest) lastKnownObstacle = nearest;
    const obsClass = nearest ? classifyObstacle(nearest, tRexConfig, groundY) : null;
    const gapNow = nearest ? nearest.xPos - (snap.tRex.xPos + tRexConfig.WIDTH) : null;
    const pxPerMs = snap.currentSpeed * (60 / 1000); // speed is px/frame at nominal 60fps
    const projectedGap = gapNow === null ? null : Math.round(gapNow - pxPerMs * emaLatency);
    const jw = computeJumpWindow(snap.currentSpeed, tRexConfig, nearest ? nearest.width : null);
    const stateText = buildState({
      speed: snap.currentSpeed, gapPx: projectedGap, obsType: nearest ? nearest.typeName : null,
      obsClass, jumpWindow: jw, distanceRan: snap.distanceRan,
    });

    const seq = ++requestSeq;
    inFlight++;
    const startTs = Date.now();
    jevCall({
      key,
      state: stateText,
      questions: {
        action: { type: 'choice', instructions: "Decide the dino's action for this exact instant.", criteria: CRITERIA },
      },
      timeoutMs: CONFIG.jevTimeoutMs,
    }).then((res) => {
      inFlight--;
      const latencyMs = Date.now() - startTs;
      emaLatency = emaLatency * (1 - CONFIG.emaAlpha) + latencyMs * CONFIG.emaAlpha;
      latencies.push(latencyMs);
      let choice = null, conf = null;
      if (res.ok) {
        jevCallCount++;
        totalInputTokens += (res.usage && res.usage.input_tokens) || 0;
        const ans = res.answers && res.answers.action;
        if (ans) { choice = ans.choice; conf = ans.confidence; }
      }
      const isNewest = seq > lastAppliedSeq;
      const applied = runActive && isNewest && res.ok && choice;
      if (applied) {
        lastAppliedSeq = seq;
        if (choice === 'jump') jumpCount++;
        lastAppliedDecision = { gapPx: projectedGap, obsType: nearest ? nearest.typeName : null, choice, latencyMs };
        applyDecision(choice).catch(() => {});
      }
      logStream.write(JSON.stringify({
        t: Date.now(), seq, gapAtLaunch: gapNow, projectedGap, obsType: nearest ? nearest.typeName : null,
        obsClass, choice, conf, latencyMs, applied: !!applied, ok: res.ok, err: res.ok ? undefined : res.error,
      }) + '\n');
    }).catch((e) => {
      inFlight--;
      logStream.write(JSON.stringify({ t: Date.now(), seq, error: String(e) }) + '\n');
    });
  }

  // poll + pipeline timers for this round only
  const pollTimer = setInterval(async () => {
    try {
      const snap = await readSnapshot(send);
      latestSnapshot = snap;
      if (snap.crashed && runActive) {
        runActive = false;
      }
    } catch {}
  }, CONFIG.pollIntervalMs);
  const pipelineTimer = setInterval(pipelineTick, CONFIG.pipelineIntervalMs);

  const startTime = Date.now();
  // wait for crash
  while (runActive) {
    await new Promise((r) => setTimeout(r, 30));
  }
  const durationMs = Date.now() - startTime;
  clearInterval(pollTimer);
  clearInterval(pipelineTimer);
  // let any in-flight requests settle so counts/logs are complete
  const drainDeadline = Date.now() + 2000;
  while (inFlight > 0 && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 50));
  logStream.end();

  const finalScore = parseInt((latestSnapshot && latestSnapshot.scoreStr) || '0', 10);
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  return {
    round: roundIndex,
    score: finalScore,
    durationMs,
    jevCallCount,
    jumpCount,
    avgLatency, p50: pct(0.5), p90: pct(0.9),
    totalInputTokens,
    cost: totalInputTokens * CONFIG.costPerInputToken,
    deathObstacle: lastAppliedDecision || (lastKnownObstacle ? { gapPx: null, obsType: lastKnownObstacle.typeName, choice: null, latencyMs: null } : null),
    logPath,
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
    // wait for the page (and Runner class) to be ready
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const has = await evalJson(send, `typeof Runner !== 'undefined' && !!Runner.instance_`);
        if (has) ready = true;
      } catch {}
    }
    if (!ready) throw new Error('Runner instance never became available on ' + GAME_URL);

    const tRexConfig = await readTRexConfig(send);
    const groundY = (await evalJson(send, `Runner.instance_.tRex.yPos`));
    console.log('tRex config:', tRexConfig, 'groundY:', groundY);

    const results = [];
    for (let i = 1; i <= RUNS; i++) {
      console.log(`\n=== Round ${i}/${RUNS}: pressing Space to start ===`);
      await send('Page.bringToFront'); // background tabs throttle rAF, which stalls "started"
      // wait for the run to actually start; a background tab or a missed keystroke can eat the
      // first tap, so retry Space every ~500ms instead of relying on a single press.
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
        jumps: result.jumpCount, avgLatency: Math.round(result.avgLatency),
        p50: result.p50, p90: result.p90, cost: result.cost.toFixed(6),
      });
      // let the game-over panel settle before the next Space restarts it
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log('\n================ SUMMARY ================');
    let totalCalls = 0, totalCost = 0, bestScore = -1, bestRound = null;
    for (const r of results) {
      totalCalls += r.jevCallCount;
      totalCost += r.cost;
      if (r.score > bestScore) { bestScore = r.score; bestRound = r.round; }
      console.log(
        `Run ${r.round}: score=${r.score} duration=${(r.durationMs / 1000).toFixed(1)}s calls=${r.jevCallCount} `
        + `jumps=${r.jumpCount} avgLat=${Math.round(r.avgLatency)}ms p50=${r.p50}ms p90=${r.p90}ms `
        + `death=${JSON.stringify(r.deathObstacle)} log=${r.logPath}`
      );
    }
    console.log(`Best score: ${bestScore} (run ${bestRound})`);
    console.log(`Total Jev calls: ${totalCalls}, total input-token cost: $${totalCost.toFixed(6)}`);

    ws.close();
  } finally {
    console.log(`\nClosing Chrome pid=${pid} (this instance only)...`);
    try {
      require('child_process').execSync(`taskkill /PID ${pid} /T /F`);
    } catch (e) {
      console.error('Failed to kill Chrome:', e.message);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
