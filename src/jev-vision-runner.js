// Vision-mode step loop. Executes one text instruction by alternating capture,
// one Jev image call (verify previous / ground current), and one input action.
// Only talks to the world through `deps`, so the loop runs under plain node
// with fakes. Contract: docs/jev-vision/CONTRACT.md section 2.9 and 3.5.

const {
  parseTrivialCommand, buildVisionRequest, interpretVisionAnswers, describeStep,
  actionSignature, isConsequential, sanitizeText, SCREEN_REF, describeElement,
  stepNeedsGround, isClickOp, boxCenterToNormalized, isRiskyHotkey, sameFrame, sameRegion,
} = require('./jev-vision');

const TIMEOUT_MARK = Symbol('uia-grace-timeout');

// Final verdict thresholds that are not part of the Jev threshold table:
// below SURE_NOT_DONE the screen clearly does not show the result; below
// LIKELY_NOT_DONE an unverified last step is not trusted either.
const SURE_NOT_DONE = 0.05;
const LIKELY_NOT_DONE = 0.3;

function graceRace(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT_MARK);
    }, ms);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
    );
  });
}

/**
 * @param {string} instruction
 * @param {object} deps VisionDeps (see contract 2.9)
 * @param {object} cfg VisionConfig
 * @returns {Promise<object>} RunResult
 */
async function runVisionTask(instruction, deps, cfg) {
  const t0 = deps.now();
  const task = sanitizeText(instruction, 500);

  const state = {
    plan: null,
    i: 0,
    pendingVerify: null,     // { step, index, actedAt }
    retried: new Set(),      // step indexes re-executed once
    sigCounts: new Map(),
    consecJevErrors: 0,
    uiaOff: false,
    history: [],             // desc strings of executed steps
    lastSnap: null,
    actions: 0,
    jevCalls: 0,
    replans: 0,
    plannerMs: 0,
    lastAsk: null,           // { key, sig, obs } of the newest real Jev answer, for the unchanged-screen skip
    unchangedRun: 0,         // consecutive observations answered from lastAsk
    lastSeenSig: null,       // signature of the newest captured frame
    sigBeforeAction: null,   // lastSeenSig when the newest action started
    lastCap: null,
    lastRead: null,
    verifyReal: 0,           // real (non-skipped) Jev answers for the pending verify
    forceReal: false,        // next observation must call Jev even on an unchanged frame
    droppedUnverified: false, // a continue replan replaced a last step whose check never passed
  };
  let prefetched = null;
  let pollCount = 0;

  function log(line) { if (deps.log) deps.log(line); }
  function progress(evt) { if (deps.progress) deps.progress(evt); }

  function finish(status, summary) {
    const total = deps.now() - t0;
    log(`[jv] end ${status} actions=${state.actions} calls=${state.jevCalls} replans=${state.replans} ` +
      `planner=${Math.round(state.plannerMs)} total=${total}`);
    const result = {
      ok: status === 'done' || status === 'done_unconfirmed' || status === 'unverified',
      status,
      summary,
      actions: state.actions,
      jevCalls: state.jevCalls,
      replans: state.replans,
      plannerMs: Math.round(state.plannerMs),
      ms: total,
    };
    progress({ phase: 'end', result });
    return result;
  }

  // The final verify loops pass skipActions: a finished task must not fail on maxActions.
  function checkLimits(skipActions) {
    if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
    if (deps.now() - t0 > cfg.maxMs) return finish('failed', 'limit: maxMs');
    if (!skipActions && state.actions >= cfg.maxActions) return finish('failed', 'limit: maxActions');
    if (state.jevCalls >= cfg.maxJevCalls) return finish('failed', 'limit: maxJevCalls');
    return null;
  }

  function fmtNum(v) { return v === null || v === undefined ? '-' : Number(v).toFixed(2); }

  function logJev(obs, outcome) {
    const { read, step, final, cap, snap, uiaStatus, jevMs } = obs;
    const op = step ? step.op : (final ? 'final' : 'verify');
    const target = step && (step.target || step.target_from) ? sanitizeText(step.target || step.target_from, 40) : '';
    const box = read.box
      ? `[${read.box.left.toFixed(2)},${read.box.top.toFixed(2)},${read.box.right.toFixed(2)},${read.box.bottom.toFixed(2)}]@${read.box.confidence.toFixed(2)}`
      : '-';
    const el = read.element ? `${read.element.id}@${read.element.conf.toFixed(2)}` : '-';
    const eCount = snap && Array.isArray(snap.elements) ? snap.elements.length : 0;
    const kb = Math.round(cap.jpeg.length / 1024);
    log(`[jv] #${state.jevCalls} s${state.i + 1}/${state.plan.steps.length} ${op} "${target}" ` +
      `cap=${cap.ms} ${cap.width}x${cap.height} ${kb}KB uia=${uiaStatus}(e=${eCount}) jev=${obs.unchanged ? 'same-frame' : jevMs} | ` +
      `prev=${fmtNum(read.prevDone)} vis=${fmtNum(read.visible)} box=${box} el=${el} ` +
      `blk=${fmtNum(read.blocked)} risky=${fmtNum(read.risky)} done=${fmtNum(read.taskDone)} -> ${outcome}`);
  }

  function doneSummary() {
    const h = state.history.slice(-3);
    return h.length ? `Done: ${h.join('; ')}` : 'Done.';
  }

  // Identifies WHICH question set an observation asks, so an answer is only
  // reused for the same pending step, not across steps.
  function askKey({ step, ground, final }) {
    const v = state.pendingVerify && state.pendingVerify.step.done_when ? `v${state.pendingVerify.index}` : '';
    return `${ground && step ? `g${state.i}` : ''}|${v}|${final ? 'f' : ''}`;
  }

  async function observe({ step, verifyStep, ground, final, lastStep, clickAt }) {
    let cap;
    if (prefetched) { cap = prefetched; prefetched = null; }
    else {
      const capAt = deps.now();
      const raw = await deps.capture();
      cap = { ...raw, at: capAt };
    }
    if (deps.signal.aborted) return { aborted: true };
    if (!cap || !cap.ok) return { fatal: true, error: 'capture failed: ' + ((cap && cap.error) || 'unknown') };
    state.lastCap = cap;

    // Unchanged screen for the same question: the answer cannot differ, so do
    // not call Jev (or UIA) again. It counts as a repeated answer.
    const sig = cfg.frameSkip && cap.sig ? cap.sig : null;
    if (sig) state.lastSeenSig = sig;
    const key = askKey({ step, ground, final });
    // Always compared with the frame Jev actually answered, never with the previous
    // poll, so a slow change cannot hide. After a click the area around the click is
    // also compared at full sensitivity: a toggle repaint is a few cells and levels.
    const forced = state.forceReal;
    state.forceReal = false;
    if (!forced && sig && state.lastAsk && state.lastAsk.key === key && sameFrame(state.lastAsk.sig, sig) &&
        (!clickAt || sameRegion(state.lastAsk.sig, sig, clickAt.nx, clickAt.ny))) {
      state.unchangedRun++;
      return { ...state.lastAsk.obs, cap, unchanged: true };
    }
    state.unchangedRun = 0;

    let snap = null;
    let uiaStatus = 'off';
    if (ground && cfg.uia && !state.uiaOff && !(step && step.op === 'drag')) {
      const p = Promise.resolve().then(() => deps.uiaSnapshot());
      p.then((r) => { if (r && r.ok === false && r.reason === 'timeout') state.uiaOff = true; }, () => {});
      const uiaStart = deps.now();
      const got = await graceRace(p, cfg.uiaGraceMs);
      if (deps.signal.aborted) return { aborted: true };
      if (got === TIMEOUT_MARK) {
        uiaStatus = 'late';
      } else if (got && got.ok) {
        snap = got;
        uiaStatus = deps.now() - uiaStart;
      } else if (got && got.reason === 'timeout') {
        state.uiaOff = true;
      }
    }

    const display = deps.display();
    let built;
    try {
      built = buildVisionRequest({ task, step: ground ? step : null, verify: verifyStep, final, snap, display, cfg, lastStep });
    } catch (e) {
      return { fatal: true, error: String((e && e.message) || e) };
    }

    const image = { ref: SCREEN_REF, part: 'image', buffer: cap.jpeg, format: 'jpeg' };
    const jr = await deps.jev({ state: built.state, questions: built.questions, image });
    state.jevCalls++;
    if (deps.signal.aborted) return { aborted: true };

    if (!jr || !jr.ok) {
      const status = jr ? jr.status : null;
      if (status === 401 || status === 403) return { fatal: true, error: `jev auth ${status}` };
      state.consecJevErrors++;
      if (state.consecJevErrors >= 2) return { fatal: true, error: 'jev failed twice' };
      return { retry: true };
    }
    state.consecJevErrors = 0;

    const read = interpretVisionAnswers(jr.answers, built, display, cfg);
    if (!read.ok) {
      state.consecJevErrors++;
      if (state.consecJevErrors >= 2) return { fatal: true, error: 'bad answers twice' };
      return { retry: true };
    }

    if (snap) state.lastSnap = snap;
    state.lastRead = read;
    const result = { ok: true, read, built, snap, cap, display, uiaStatus, jevMs: jr.ms, step, final: !!final };
    if (sig) state.lastAsk = { key, sig, obs: result };
    return result;
  }

  async function actClick(step, click, built, read) {
    if (click.source === 'element' && step.op === 'click') {
      const el = built.elementMap[click.elementId];
      const r = await deps.uiaClick({ snapshotId: state.lastSnap ? state.lastSnap.snapshotId : undefined, index: el ? el.i : undefined });
      if (deps.signal.aborted) return { aborted: true };
      if (r && r.ok) return { via: 'element', outcome: 'ok' };
      if (r && (r.reason === 'stale_snapshot' || r.reason === 'stale_element')) {
        await deps.input({ action: 'click', nx: click.nx, ny: click.ny });
        return { via: 'box', outcome: 'ok' };
      }
      if (r && r.reason === 'occluded') {
        const usable = read && read.box && !read.boxReject ? boxCenterToNormalized(read.box) : null;
        if (usable) {
          await deps.input({ action: 'click', nx: usable.nx, ny: usable.ny });
          return { via: 'box', outcome: 'ok' };
        }
        return { via: 'element', outcome: 'no_target' };
      }
      // timeout means outcome unknown; never re-click.
      return { via: 'element', outcome: 'unknown' };
    }

    const action = step.op === 'double_click' ? 'double_click' : step.op === 'right_click' ? 'right_click' : 'click';
    await deps.input({ action, nx: click.nx, ny: click.ny });
    return { via: 'box', outcome: 'ok' };
  }

  // One plan step = at most one action unit. Returns { aborted } or { via, outcome }.
  async function executeStep(step, click, built, read) {
    const start = deps.now();
    let via = 'key';
    let outcome = 'ok';
    state.lastAsk = null;                      // the screen is about to change
    state.sigBeforeAction = state.lastSeenSig;

    if (isClickOp(step.op)) {
      const res = await actClick(step, click, built, read);
      if (res.aborted) return { aborted: true };
      via = res.via;
      outcome = res.outcome;
      if (outcome === 'no_target') return { via, outcome };
    } else if (step.op === 'drag') {
      if (!click || click.nx2 === undefined) return { via: 'box', outcome: 'no_target' };
      // computerAction drags with the mouse down, 20 intermediate moves, mouse up.
      await deps.input({ action: 'drag', nx: click.nx, ny: click.ny, nx2: click.nx2, ny2: click.ny2 });
      via = 'drag';
    } else if (step.op === 'type') {
      if (click) {
        const res = await actClick(step, click, built, read);
        if (res.aborted) return { aborted: true };
        via = res.via;
        if (deps.signal.aborted) return { aborted: true };
        // Never type blind: a focusing click that missed or could not be
        // confirmed would send the text to whatever window has focus.
        if (res.outcome === 'no_target' || res.outcome === 'unknown') return { via, outcome: 'no_target' };
      }
      if (step.clear) {
        await deps.input({ action: 'key', key: 'ctrl+a' });
        if (deps.signal.aborted) return { aborted: true };
      }
      const typed = await deps.input({ action: 'type', text: step.text });
      via = 'type';
      if (deps.signal.aborted) return { aborted: true };
      // Typing is never retried (T15); a reported failure ends the run.
      if (typed && typed.success === false) return { error: 'typing failed' };
      if (step.submit) {
        await deps.input({ action: 'key', key: 'enter' });
        if (deps.signal.aborted) return { aborted: true };
      }
    } else if (step.op === 'hotkey') {
      await deps.input({ action: 'key', key: step.keys });
      via = 'key';
    } else if (step.op === 'scroll') {
      const nx = click ? click.nx : 500;
      const ny = click ? click.ny : 500;
      await deps.input({ action: `scroll_${step.direction || 'down'}`, nx, ny, clicks: step.amount || 5 });
      via = 'key';
    } else if (step.op === 'open_app') {
      await deps.openApp(step.app);
      via = 'app';
    } else if (step.op === 'open_url') {
      if (!deps.openUrl) return { error: 'open_url is not supported here' };
      const opened = await deps.openUrl(step.url);
      if (opened && opened.success === false) return { error: 'could not open the url' };
      via = 'url';
    } else if (step.op === 'wait') {
      await deps.sleep((step.seconds || 1) * 1000);
      via = 'wait';
    }

    if (deps.signal.aborted) return { aborted: true };
    log(`[jv] act s${state.i + 1} ${step.op} via=${via} act=${deps.now() - start}`);
    state.actions++;
    state.history.push(describeStep(step));

    await deps.sleep(cfg.settleMs);
    if (deps.signal.aborted) return { aborted: true };
    state.pendingVerify = {
      step, index: state.i, actedAt: deps.now(),
      at: click && Number.isFinite(click.nx) ? { nx: click.nx, ny: click.ny } : null,
    };
    state.verifyReal = 0;
    state.i++;
    pollCount = 0;
    return { via, outcome };
  }

  /**
   * Ask the planner for the next steps, with the screen as it is now.
   * mode 'fail': a step failed or could not be verified; steps from the failure on are replaced.
   * mode 'continue': every step ran but the task is not done; new steps are appended.
   * Returns { ok } (steps spliced in), { complete } (continue mode, planner says finished)
   * or { done: RunResult } (run over). In continue mode a planner failure is { soft }.
   */
  async function doReplan(reason, failedStep, mode = 'fail') {
    if (state.replans >= cfg.maxReplans || !deps.replan) {
      return mode === 'continue' ? { soft: true } : { done: finish('failed', reason) };
    }
    state.replans++;
    progress({ phase: 'replan', index: state.i + 1, desc: reason });
    const done = state.history.slice(-8);
    const screen = state.lastSnap ? {
      title: state.lastSnap.title,
      process: state.lastSnap.process,
      elements: (state.lastSnap.elements || []).slice(0, 30).map(describeElement),
    } : null;

    // Fresh frame so the planner sees what the user sees right now.
    let image = null;
    try {
      const raw = await deps.capture();
      if (raw && raw.ok) { image = raw.jpeg; if (raw.sig) state.lastSeenSig = raw.sig; }
    } catch { /* fall back to the last observed frame */ }
    if (!image && state.lastCap) image = state.lastCap.jpeg;
    if (deps.signal.aborted) return { done: finish('cancelled', 'Cancelled') };

    const rd = state.lastRead;
    const jev = rd ? {
      vis: rd.visible, boxConf: rd.box ? rd.box.confidence : null, prevDone: rd.prevDone, taskDone: rd.taskDone,
    } : null;
    const failed = mode === 'continue' ? null : { step: failedStep || state.plan.steps[state.i], reason };
    const rr = await deps.replan({ instruction, done, failed, screen, image, jev, mode });
    if (deps.signal.aborted) return { done: finish('cancelled', 'Cancelled') };
    state.plannerMs += (rr && rr.ms) || 0;
    if (rr && rr.ok && rr.plan && rr.plan.complete && mode === 'continue') return { complete: true };
    if (!rr || !rr.ok || !rr.plan || !rr.plan.steps || !rr.plan.steps.length) {
      return mode === 'continue' ? { soft: true } : { done: finish('failed', reason) };
    }
    // A continue replan replaces a last step whose check never passed; remember it.
    if (mode === 'continue' && state.pendingVerify && state.pendingVerify.step.done_when) state.droppedUnverified = true;
    state.plan = { steps: [...state.plan.steps.slice(0, state.i), ...rr.plan.steps], source: 'replan' };
    state.pendingVerify = null;
    state.lastAsk = null;
    pollCount = 0;
    return { ok: true };
  }

  function consequential(step, read) {
    return step.risky === true || isConsequential(step) ||
      (step.op === 'hotkey' && isRiskyHotkey(step.keys)) ||
      (read && read.risky !== null && read.risky >= cfg.thresholds.risky);
  }

  async function gate(step, read) {
    if (!consequential(step, read)) return { allow: true };
    progress({ phase: 'confirm' });
    const ok = cfg.confirm ? await deps.confirm(`Aura is about to perform a consequential action:\n\n${describeStep(step)}\n\nAllow it?`) : false;
    if (deps.signal.aborted) return { aborted: true };
    return ok ? { allow: true } : { refused: true };
  }

  // Steps that need no observation still pass the safety gate; gate() lets
  // everything through that consequential(step, null) says is harmless.
  async function executeDirect(step) {
    const g = await gate(step, null);
    if (g.aborted) return { aborted: true };
    if (g.refused) return { refused: true };
    return executeStep(step, null, null, null);
  }

  // ---- Plan phase ------------------------------------------------------
  const trivial = parseTrivialCommand(instruction, { appKnown: deps.appKnown });
  let plan;
  if (trivial) {
    plan = trivial;
    log(`[jv] run "${sanitizeText(instruction, 80)}" plan=trivial steps=${plan.steps.length}`);
  } else {
    if (!deps.plan) return finish('error', 'no planner key');
    progress({ phase: 'planning' });
    const capAt = deps.now();
    const capP = deps.capture().then(r => ({ ...r, at: capAt }));
    const plannerP = deps.plan(instruction);
    const [capRes, pr] = await Promise.all([capP, plannerP]);
    if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
    state.plannerMs = (pr && pr.ms) || 0;
    if (!pr || !pr.ok) {
      log(`[jv] run "${sanitizeText(instruction, 80)}" plan=FAIL ${(pr && pr.error) || 'no planner'}`);
      return finish('error', (pr && pr.error) || 'planning failed');
    }
    plan = pr.plan;
    log(`[jv] run "${sanitizeText(instruction, 80)}" plan=gemini ${Math.round(state.plannerMs)}ms req=${pr.requests || 1} steps=${plan.steps.length}`);
    if (plan.steps[0] && stepNeedsGround(plan.steps[0]) && capRes && capRes.ok &&
        deps.now() - capRes.at <= cfg.settleMs * 4) {
      prefetched = capRes;
    }
  }
  state.plan = plan;

  // ---- Step loop -------------------------------------------------------
  // Runs until the plan is exhausted (returns null) or the run ends (RunResult).
  async function stepLoop() {
    while (state.i < state.plan.steps.length) {
      const lim = checkLimits();
      if (lim) return lim;

      const step = state.plan.steps[state.i];
      const pending = state.pendingVerify;
      const verifyStep = pending && pending.step.done_when ? pending.step : null;
      const ground = stepNeedsGround(step);

      progress({ phase: 'step', index: state.i + 1, total: state.plan.steps.length, desc: describeStep(step) });

      if (!verifyStep && !ground) {
        const r = await executeDirect(step);
        if (r.aborted) return finish('cancelled', 'Cancelled');
        if (r.error) return finish('error', r.error);
        if (r.refused) return finish('refused', `Refused: ${describeStep(step)}`);
        continue;
      }

      const clickAt = verifyStep && isClickOp(verifyStep.op) ? pending.at : null;
      const obs = await observe({ step, verifyStep, ground, final: false, clickAt });
      if (obs.aborted) return finish('cancelled', 'Cancelled');
      if (obs.fatal) return finish('error', obs.error);
      if (obs.retry) continue;
      if (verifyStep && !obs.unchanged) state.verifyReal++;
      const read = obs.read;

      // One log line per observation: when the previous step verified and the
      // same observation then grounds/acts, the line carries both outcomes.
      let verified = false;
      const note = (o) => (verified ? `verified+${o}` : o);

      // Verify the previous step first; it gates whether we may act.
      if (verifyStep) {
        const pd = read.prevDone;
        if (pd !== null && pd >= cfg.thresholds.prevDone) {
          state.pendingVerify = null;
          state.verifyReal = 0;
          pollCount = 0;
          verified = true;
        } else {
          // Launching an app or a page takes seconds; give both the long window.
          const launching = pending.step.op === 'open_app' || pending.step.op === 'open_url';
          // An unchanged screen repeats the same answer; two repeats end the wait early
          // (launches keep their time window, their polls cost no Jev call).
          // After a click, "unchanged" never ends the wait: a toggle that repaints late
          // looks unchanged, and a retry would click it back. A click is only retried
          // after maxPolls real Jev answers (a skipped poll is forced real if needed).
          const clickVerify = isClickOp(pending.step.op);
          let exhausted = launching
            ? deps.now() - pending.actedAt >= cfg.appWaitMs
            : clickVerify
              ? pollCount >= cfg.maxPolls
              : pollCount >= cfg.maxPolls || state.unchangedRun >= 2;
          if (exhausted && clickVerify && state.verifyReal < cfg.maxPolls) {
            exhausted = false;
            state.forceReal = true;
          }
          if (!exhausted) {
            pollCount++;
            logJev(obs, 'poll');
            await deps.sleep(cfg.pollIntervalMs);
            if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
            continue;
          }
          // Never re-execute type/hotkey/open_app/scroll (T15); those replan.
          if (isClickOp(pending.step.op) && !state.retried.has(pending.index)) {
            state.retried.add(pending.index);
            state.pendingVerify = null;
            state.i = pending.index;
            pollCount = 0;
            continue;
          }
          logJev(obs, 'replan');
          const rp = await doReplan('not_verified', pending.step);
          if (rp.done) return rp.done;
          continue;
        }
      }

      if (ground) {
        if (read.click) {
          const sig = actionSignature(step, read.click);
          const n = (state.sigCounts.get(sig) || 0) + 1;
          state.sigCounts.set(sig, n);
          if (n >= cfg.sameActionLimit) {
            logJev(obs, note('replan'));
            const rp = await doReplan('repeating', step);
            if (rp.done) return rp.done;
            continue;
          }

          const g = await gate(step, read);
          if (g.aborted) return finish('cancelled', 'Cancelled');
          if (g.refused) { logJev(obs, note('refused')); return finish('refused', `Refused: ${describeStep(step)}`); }

          logJev(obs, note(read.clickReason));
          const r = await executeStep(step, read.click, obs.built, read);
          if (r.aborted) return finish('cancelled', 'Cancelled');
          if (r.error) return finish('error', r.error);
          if (r.outcome === 'no_target') {
            if (pollCount < cfg.maxPolls) {
              pollCount++;
              await deps.sleep(cfg.pollIntervalMs);
              if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
              continue;
            }
            const rp = await doReplan('target_not_found', step);
            if (rp.done) return rp.done;
          }
          continue;
        }

        // Not grounded yet: poll, then replan. A second identical answer on an
        // unchanged screen cannot improve, so it goes straight to the replan.
        const blk = read.blocked;
        const reason = blk !== null && blk >= cfg.thresholds.blocked ? 'obstructed' : 'target_not_found';
        if (pollCount < cfg.maxPolls && state.unchangedRun < 1) {
          pollCount++;
          logJev(obs, note('poll'));
          await deps.sleep(cfg.pollIntervalMs);
          if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
          continue;
        }
        logJev(obs, note('replan'));
        const rp = await doReplan(reason, step);
        if (rp.done) return rp.done;
        continue;
      }

      // Verify passed (or there is nothing to verify) and the step needs no
      // target: execute it now without another observation.
      if (verified) logJev(obs, 'verified');
      const direct = await executeDirect(step);
      if (direct.aborted) return finish('cancelled', 'Cancelled');
      if (direct.error) return finish('error', direct.error);
      if (direct.refused) return finish('refused', `Refused: ${describeStep(step)}`);
      continue;
    }
    return null;
  }

  // ---- Final -----------------------------------------------------------
  // Returns a RunResult, or null when a "continue" replan added more steps.
  async function finalPhase() {
    const pending = state.pendingVerify;
    const verifyStep = pending && pending.step.done_when ? pending.step : null;
    const lastStep = pending ? pending.step : state.plan.steps[state.plan.steps.length - 1];
    pollCount = 0;

    if (!cfg.finalVerify) {
      if (verifyStep) {
        for (;;) {
          const lim = checkLimits(true);
          if (lim) return lim;
          const obs = await observe({ step: null, verifyStep, ground: false, final: false });
          if (obs.aborted) return finish('cancelled', 'Cancelled');
          if (obs.fatal) return finish('error', obs.error);
          if (obs.retry) continue;
          const pd = obs.read.prevDone;
          if (pd !== null && pd >= cfg.thresholds.prevDone) { logJev(obs, 'verified'); break; }
          logJev(obs, 'poll');
          if (pollCount >= cfg.maxPolls || state.unchangedRun >= 1) return finish('unverified', 'Unverified');
          pollCount++;
          await deps.sleep(cfg.pollIntervalMs);
          if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
        }
      }
      return finish('done', doneSummary());
    }

    // At most cfg.finalPolls Jev calls; an unchanged screen cannot change the answer, so stop there.
    // A last step that launches an app or a page gets the full launch window first:
    // an unpainted window looks "unchanged", and acting on a half-loaded screen
    // could open a duplicate.
    const launching = !!pending && (pending.step.op === 'open_app' || pending.step.op === 'open_url');
    let calls = 0;
    let read = null;
    for (;;) {
      const lim = checkLimits(true);
      if (lim) return lim;
      const obs = await observe({ step: null, verifyStep, ground: false, final: true, lastStep });
      if (obs.aborted) return finish('cancelled', 'Cancelled');
      if (obs.fatal) return finish('error', obs.error);
      if (obs.retry) continue;
      read = obs.read;
      const pdOk = read.prevDone !== null && read.prevDone >= cfg.thresholds.prevDone;
      const tdOk = read.taskDone !== null && read.taskDone >= cfg.thresholds.taskDone;
      if (pdOk || tdOk) {
        state.pendingVerify = null;
        logJev(obs, pdOk ? 'verified' : 'task_done');
        return finish('done', doneSummary());
      }
      logJev(obs, obs.unchanged ? 'same-frame' : 'poll');
      const waiting = launching && deps.now() - pending.actedAt < cfg.appWaitMs;
      if (obs.unchanged) { if (!waiting) break; }
      else {
        calls++;
        if (calls >= cfg.finalPolls && !waiting) break;
      }
      await deps.sleep(cfg.pollIntervalMs);
      if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
    }

    // Not confirmed. Every step is verified unless the last one's check failed
    // (earlier steps gate on theirs before the next one may run).
    const allVerified = !verifyStep && !state.droppedUnverified;
    const td = read && read.taskDone !== null ? read.taskDone : 0;
    const screenChanged = !(state.sigBeforeAction && state.lastSeenSig && sameFrame(state.sigBeforeAction, state.lastSeenSig));
    const canContinue = !!deps.replan && state.replans < cfg.maxReplans;
    // Only the CURRENT last step's failed check argues for continuing; a dropped one is just remembered for the verdict.
    const clearlyNotDone = (td < SURE_NOT_DONE && screenChanged) || (!!verifyStep && td < LIKELY_NOT_DONE);

    if (clearlyNotDone && canContinue) {
      const rp = await doReplan('not_complete', null, 'continue');
      if (rp.done) return rp.done;
      if (rp.ok) return null;
      if (rp.complete) {
        log('[jv] planner sees the task complete');
        return allVerified ? finish('done_unconfirmed', doneSummary()) : finish('unverified', 'Unverified');
      }
      // soft failure: fall through to the verdict below
    }

    if (allVerified) {
      log(`[jv] done_unconfirmed: all steps verified, task_done=${fmtNum(read && read.taskDone)}`);
      return finish('done_unconfirmed', doneSummary());
    }
    return finish('unverified', 'Unverified');
  }

  for (;;) {
    const stepped = await stepLoop();
    if (stepped) return stepped;
    const fin = await finalPhase();
    if (fin) return fin;
  }
}

module.exports = { runVisionTask };
