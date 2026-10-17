// Vision-mode step loop. Executes one text instruction by alternating capture,
// one Jev image call (verify previous / ground current), and one input action.
// Only talks to the world through `deps`, so the loop runs under plain node
// with fakes. Contract: docs/jev-vision/CONTRACT.md section 2.9 and 3.5.

const {
  parseTrivialCommand, buildVisionRequest, interpretVisionAnswers, describeStep,
  actionSignature, isConsequential, sanitizeText, SCREEN_REF, describeElement,
  stepNeedsGround, isClickOp, boxCenterToNormalized, isRiskyHotkey,
} = require('./jev-vision');

const TIMEOUT_MARK = Symbol('uia-grace-timeout');

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
      ok: status === 'done' || status === 'unverified',
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
    const target = step && step.target ? sanitizeText(step.target, 40) : '';
    const box = read.box
      ? `[${read.box.left.toFixed(2)},${read.box.top.toFixed(2)},${read.box.right.toFixed(2)},${read.box.bottom.toFixed(2)}]@${read.box.confidence.toFixed(2)}`
      : '-';
    const el = read.element ? `${read.element.id}@${read.element.conf.toFixed(2)}` : '-';
    const eCount = snap && Array.isArray(snap.elements) ? snap.elements.length : 0;
    const kb = Math.round(cap.jpeg.length / 1024);
    log(`[jv] #${state.jevCalls} s${state.i + 1}/${state.plan.steps.length} ${op} "${target}" ` +
      `cap=${cap.ms} ${cap.width}x${cap.height} ${kb}KB uia=${uiaStatus}(e=${eCount}) jev=${jevMs} | ` +
      `prev=${fmtNum(read.prevDone)} vis=${fmtNum(read.visible)} box=${box} el=${el} ` +
      `blk=${fmtNum(read.blocked)} risky=${fmtNum(read.risky)} done=${fmtNum(read.taskDone)} -> ${outcome}`);
  }

  function doneSummary() {
    const h = state.history.slice(-3);
    return h.length ? `Done: ${h.join('; ')}` : 'Done.';
  }

  async function observe({ step, verifyStep, ground, final }) {
    let cap;
    if (prefetched) { cap = prefetched; prefetched = null; }
    else {
      const capAt = deps.now();
      const raw = await deps.capture();
      cap = { ...raw, at: capAt };
    }
    if (deps.signal.aborted) return { aborted: true };
    if (!cap || !cap.ok) return { fatal: true, error: 'capture failed: ' + ((cap && cap.error) || 'unknown') };

    let snap = null;
    let uiaStatus = 'off';
    if (ground && cfg.uia && !state.uiaOff) {
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
      built = buildVisionRequest({ task, step: ground ? step : null, verify: verifyStep, final, snap, display, cfg });
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
    return { ok: true, read, built, snap, cap, display, uiaStatus, jevMs: jr.ms, step, final: !!final };
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

    if (isClickOp(step.op)) {
      const res = await actClick(step, click, built, read);
      if (res.aborted) return { aborted: true };
      via = res.via;
      outcome = res.outcome;
      if (outcome === 'no_target') return { via, outcome };
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
    state.pendingVerify = { step, index: state.i, actedAt: deps.now() };
    state.i++;
    pollCount = 0;
    return { via, outcome };
  }

  async function doReplan(reason, failedStep) {
    if (state.replans >= cfg.maxReplans || !deps.replan) return { done: finish('failed', reason) };
    state.replans++;
    progress({ phase: 'replan', index: state.i + 1, desc: reason });
    const done = state.history.slice(-8);
    const screen = state.lastSnap ? {
      title: state.lastSnap.title,
      process: state.lastSnap.process,
      elements: (state.lastSnap.elements || []).slice(0, 30).map(describeElement),
    } : null;
    const rr = await deps.replan({
      instruction,
      done,
      failed: { step: failedStep || state.plan.steps[state.i], reason },
      screen,
    });
    if (deps.signal.aborted) return { done: finish('cancelled', 'Cancelled') };
    state.plannerMs += (rr && rr.ms) || 0;
    if (!rr || !rr.ok || !rr.plan || !rr.plan.steps || !rr.plan.steps.length) {
      return { done: finish('failed', reason) };
    }
    state.plan = { steps: [...state.plan.steps.slice(0, state.i), ...rr.plan.steps], source: 'replan' };
    state.pendingVerify = null;
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
  const trivial = parseTrivialCommand(instruction);
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

    const obs = await observe({ step, verifyStep, ground, final: false });
    if (obs.aborted) return finish('cancelled', 'Cancelled');
    if (obs.fatal) return finish('error', obs.error);
    if (obs.retry) continue;
    const read = obs.read;

    // Verify the previous step first; it gates whether we may act.
    if (verifyStep) {
      const pd = read.prevDone;
      if (pd !== null && pd >= cfg.thresholds.prevDone) {
        state.pendingVerify = null;
        pollCount = 0;
        logJev(obs, 'verified');
      } else {
        // Launching an app or a page takes seconds; give both the long window.
        const launching = pending.step.op === 'open_app' || pending.step.op === 'open_url';
        const exhausted = launching
          ? deps.now() - pending.actedAt >= cfg.appWaitMs
          : pollCount >= cfg.maxPolls;
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
          logJev(obs, 'replan');
          const rp = await doReplan('repeating', step);
          if (rp.done) return rp.done;
          continue;
        }

        const g = await gate(step, read);
        if (g.aborted) return finish('cancelled', 'Cancelled');
        if (g.refused) { logJev(obs, 'refused'); return finish('refused', `Refused: ${describeStep(step)}`); }

        logJev(obs, read.clickReason);
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

      // Not grounded yet: poll, then replan.
      const blk = read.blocked;
      const reason = blk !== null && blk >= cfg.thresholds.blocked ? 'obstructed' : 'target_not_found';
      if (pollCount < cfg.maxPolls) {
        pollCount++;
        logJev(obs, 'poll');
        await deps.sleep(cfg.pollIntervalMs);
        if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
        continue;
      }
      logJev(obs, 'replan');
      const rp = await doReplan(reason, step);
      if (rp.done) return rp.done;
      continue;
    }

    // Verify passed (or there is nothing to verify) and the step needs no
    // target: execute it now without another observation.
    const direct = await executeDirect(step);
    if (direct.aborted) return finish('cancelled', 'Cancelled');
    if (direct.error) return finish('error', direct.error);
    if (direct.refused) return finish('refused', `Refused: ${describeStep(step)}`);
    continue;
  }

  // ---- Final -----------------------------------------------------------
  let pending = state.pendingVerify;
  let verifyStep = pending && pending.step.done_when ? pending.step : null;

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
        if (pollCount >= cfg.maxPolls) return finish('unverified', 'Unverified');
        pollCount++;
        await deps.sleep(cfg.pollIntervalMs);
        if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
      }
    }
    return finish('done', doneSummary());
  }

  for (;;) {
    const lim = checkLimits(true);
    if (lim) return lim;
    const obs = await observe({ step: null, verifyStep, ground: false, final: true });
    if (obs.aborted) return finish('cancelled', 'Cancelled');
    if (obs.fatal) return finish('error', obs.error);
    if (obs.retry) continue;
    const read = obs.read;
    const pdOk = read.prevDone !== null && read.prevDone >= cfg.thresholds.prevDone;
    const tdOk = read.taskDone !== null && read.taskDone >= cfg.thresholds.taskDone;
    if (pdOk || tdOk) {
      state.pendingVerify = null;
      logJev(obs, pdOk ? 'verified' : 'task_done');
      return finish('done', doneSummary());
    }
    logJev(obs, 'poll');
    if (pollCount >= cfg.maxPolls) return finish('unverified', 'Unverified');
    pollCount++;
    await deps.sleep(cfg.pollIntervalMs);
    if (deps.signal.aborted) return finish('cancelled', 'Cancelled');
  }
}

module.exports = { runVisionTask };
