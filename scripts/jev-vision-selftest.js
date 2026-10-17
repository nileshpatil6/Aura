// Pure + fake-deps self-test for Jev Vision mode. Plain node, no electron, no
// network. Run: node scripts/jev-vision-selftest.js
// Contract: docs/jev-vision/CONTRACT.md section 7, step 1.

const assert = require('node:assert/strict');
const path = require('path');

const vision = require(path.join(__dirname, '..', 'src', 'jev-vision.js'));
const jev = require(path.join(__dirname, '..', 'src', 'jev.js'));
const { runVisionTask } = require(path.join(__dirname, '..', 'src', 'jev-vision-runner.js'));

const {
  DEFAULT_VISION_CFG, readVisionConfig, IMAGE_LIMITS, fitImageSize, validateImageDims,
  SCREEN_REF, sanitizeText, validatePlan, parseTrivialCommand, isConsequential,
  describeStep, buildVisionRequest, interpretVisionAnswers,
  boxCenterToNormalized, elementCenterToNormalized, normalizedToPhysical, actionSignature,
} = vision;

const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;
const display = { dipW: 1920, dipH: 1080, physX: 0, physY: 0, physW: 1920, physH: 1080, scaleFactor: 1 };

const tests = [];
function check(name, fn) { tests.push([name, fn]); }

// ── fitImageSize / validateImageDims ────────────────────────────────────────
check('fitImageSize: 1920x1080@1280 -> 1280x720', () => {
  assert.deepEqual(fitImageSize(1920, 1080, 1280), { width: 1280, height: 720 });
});
check('fitImageSize: 3840x2160@1568 -> 1568x882', () => {
  assert.deepEqual(fitImageSize(3840, 2160, 1568), { width: 1568, height: 882 });
});
check('fitImageSize: 5120x1440@1280 -> 1280x360', () => {
  assert.deepEqual(fitImageSize(5120, 1440, 1280), { width: 1280, height: 360 });
});
check('fitImageSize: 800x600@1280 -> 800x600 (no upscale)', () => {
  assert.deepEqual(fitImageSize(800, 600, 1280), { width: 800, height: 600 });
});
check('fitImageSize: 3000x200@1280 -> null (short side 280 breaks maxSide)', () => {
  assert.equal(fitImageSize(3000, 200, 1280), null);
});
check('fitImageSize: short side raised to 280 when it fits', () => {
  assert.deepEqual(fitImageSize(200, 100, 1280), { width: 560, height: 280 });
});
check('fitImageSize: garbage -> null', () => {
  assert.equal(fitImageSize(0, 0, 1280), null);
  assert.equal(fitImageSize(NaN, 100, 1280), null);
});
check('validateImageDims: 279 / 280 / 1568 / 1569 and pixels', () => {
  assert.equal(validateImageDims(279, 400), false);
  assert.equal(validateImageDims(280, 280), true);
  assert.equal(validateImageDims(1568, 1568), true);
  assert.equal(validateImageDims(1569, 1000), false);
  assert.equal(validateImageDims(280, 279), false);
  assert.equal(IMAGE_LIMITS.minPixels, 280 * 280);
  assert.equal(IMAGE_LIMITS.maxPixels, 1568 * 1568);
});

// ── readVisionConfig ────────────────────────────────────────────────────────
check('readVisionConfig: defaults on {}', () => {
  const c = readVisionConfig({});
  assert.equal(c.model, 'jev-1.14.0');
  assert.equal(c.transport, 'multipart');
  assert.equal(c.imgMaxSide, 1280);
  assert.equal(c.jpegQuality, 70);
  assert.equal(c.maxPolls, 4);
  assert.equal(c.uia, true);
  assert.equal(c.confirm, true);
  assert.equal(c.finalVerify, true);
  assert.deepEqual(c.thresholds, DEFAULT_VISION_CFG.thresholds);
});
check('readVisionConfig: numeric clamps', () => {
  assert.equal(readVisionConfig({ AURA_JV_IMG_MAX: '5000' }).imgMaxSide, 1568);
  assert.equal(readVisionConfig({ AURA_JV_IMG_MAX: '100' }).imgMaxSide, 280);
  assert.equal(readVisionConfig({ AURA_JV_JPEG_Q: '200' }).jpegQuality, 95);
  assert.equal(readVisionConfig({ AURA_JV_JPEG_Q: '10' }).jpegQuality, 30);
});
check('readVisionConfig: garbage and out-of-range -> default', () => {
  assert.equal(readVisionConfig({ AURA_JV_MAX_POLLS: 'abc' }).maxPolls, 4);
  assert.equal(readVisionConfig({ AURA_JV_MAX_MS: '-5' }).maxMs, 120000);
  assert.equal(readVisionConfig({ AURA_JV_TRANSPORT: 'bogus' }).transport, 'multipart');
  assert.equal(readVisionConfig({ AURA_JEV_VISION_MODEL: '  ' }).model, 'jev-1.14.0');
});
check("readVisionConfig: '0' flags and overrides", () => {
  assert.equal(readVisionConfig({ AURA_JV_UIA: '0' }).uia, false);
  assert.equal(readVisionConfig({ AURA_JV_CONFIRM: '0' }).confirm, false);
  assert.equal(readVisionConfig({ AURA_JV_FINAL_VERIFY: '0' }).finalVerify, false);
  assert.equal(readVisionConfig({ AURA_JV_UIA: '1' }).uia, true);
  assert.equal(readVisionConfig({ AURA_JV_TRANSPORT: 'json' }).transport, 'json');
});

// ── validatePlan ────────────────────────────────────────────────────────────
check('validatePlan: click requires target', () => {
  assert.equal(validatePlan({ steps: [{ op: 'click' }] }).ok, false);
});
check('validatePlan: type requires text 1..500', () => {
  assert.equal(validatePlan({ steps: [{ op: 'type', text: '' }] }).ok, false);
  assert.equal(validatePlan({ steps: [{ op: 'type', text: 'x'.repeat(501) }] }).ok, false);
});
check('validatePlan: hotkey grammar', () => {
  assert.equal(validatePlan({ steps: [{ op: 'hotkey', keys: 'ctrl+l' }] }).ok, true);
  assert.equal(validatePlan({ steps: [{ op: 'hotkey', keys: 'ctrl + l' }] }).ok, false);
  assert.equal(validatePlan({ steps: [{ op: 'hotkey', keys: 'ctrl+' }] }).ok, false);
});
check('validatePlan: open_app requires app, bad op rejected', () => {
  assert.equal(validatePlan({ steps: [{ op: 'open_app', app: '' }] }).ok, false);
  assert.equal(validatePlan({ steps: [{ op: 'fly' }] }).ok, false);
});
check('validatePlan: >12 steps truncated, not failed', () => {
  const steps = Array.from({ length: 15 }, () => ({ op: 'wait', seconds: 1 }));
  const r = validatePlan({ steps });
  assert.equal(r.ok, true);
  assert.equal(r.plan.steps.length, 12);
});
check('validatePlan: backticks stripped from target, kept in text, newlines collapsed', () => {
  const r = validatePlan({ steps: [
    { op: 'click', target: 'a`b\nc' },
    { op: 'type', text: 'x`y\nz' },
  ] });
  assert.equal(r.ok, true);
  // newline -> space, backticks removed (not replaced by a space)
  assert.equal(r.plan.steps[0].target, 'ab c');
  assert.equal(r.plan.steps[1].text, 'x`y z'); // backticks kept, newline collapsed
  assert.equal(r.plan.source, 'gemini');
});
check('validatePlan: truncates done_when to 200', () => {
  const r = validatePlan({ steps: [{ op: 'wait', seconds: 1, done_when: 'd'.repeat(300) }] });
  assert.equal(r.ok, true);
  assert.equal(r.plan.steps[0].done_when.length, 200);
});

// ── parseTrivialCommand ─────────────────────────────────────────────────────
check('parseTrivialCommand: open notepad', () => {
  assert.deepEqual(parseTrivialCommand('open notepad').steps[0], { op: 'open_app', app: 'notepad', done_when: '' });
});
check('parseTrivialCommand: click the Start button', () => {
  assert.deepEqual(parseTrivialCommand('click the Start button').steps[0], { op: 'click', target: 'Start button', done_when: '' });
});
check('parseTrivialCommand: double-click Recycle Bin', () => {
  assert.equal(parseTrivialCommand('double-click Recycle Bin').steps[0].op, 'double_click');
});
check('parseTrivialCommand: right click Recycle Bin', () => {
  assert.equal(parseTrivialCommand('right click Recycle Bin').steps[0].op, 'right_click');
});
check('parseTrivialCommand: press ctrl+shift+n', () => {
  assert.deepEqual(parseTrivialCommand('press ctrl+shift+n').steps[0], { op: 'hotkey', keys: 'ctrl+shift+n', done_when: '' });
});
check('parseTrivialCommand: press with spaces/plus normalized', () => {
  assert.equal(parseTrivialCommand('press ctrl plus shift plus n').steps[0].keys, 'ctrl+shift+n');
});
check('parseTrivialCommand: type "hi there"', () => {
  assert.deepEqual(parseTrivialCommand('type "hi there"').steps[0], { op: 'type', text: 'hi there', done_when: '' });
});
check('parseTrivialCommand: scroll down', () => {
  assert.equal(parseTrivialCommand('scroll down').steps[0].op, 'scroll');
});
check('parseTrivialCommand: multi-clause and non-matches -> null', () => {
  assert.equal(parseTrivialCommand('open notepad and type hi'), null);
  assert.equal(parseTrivialCommand('search for cats'), null);
  assert.equal(parseTrivialCommand('type hi'), null);
  assert.equal(parseTrivialCommand('open notepad, then click Save'), null);
});

// ── isConsequential ─────────────────────────────────────────────────────────
check('isConsequential: send/delete hits', () => {
  assert.equal(isConsequential({ op: 'click', target: 'Send button' }), true);
  assert.equal(isConsequential({ op: 'click', target: 'Delete' }), true);
  assert.equal(isConsequential({ op: 'click', target: 'Settings' }), false);
});
check('isConsequential: type without submit never, with submit can hit', () => {
  assert.equal(isConsequential({ op: 'type', text: 'send' }), false);
  assert.equal(isConsequential({ op: 'type', text: 'delete', submit: true }), true);
});
check('isConsequential: risky always', () => {
  assert.equal(isConsequential({ op: 'wait', seconds: 1, risky: true }), true);
  assert.equal(isConsequential({ op: 'wait', seconds: 1 }), false);
});

// ── buildVisionRequest ──────────────────────────────────────────────────────
function snapRefCount(built) {
  return JSON.stringify({ state: built.state, questions: built.questions }).split(SCREEN_REF).length - 1;
}
const cfg = readVisionConfig({});
const clickStep = { op: 'click', target: 'blue Send button', done_when: '' };
const verifyStep = { op: 'wait', seconds: 1, done_when: 'a green checkmark is visible' };

check('buildVisionRequest: J2 SCREEN_REF count == 1 in all combinations', () => {
  const combos = [
    buildVisionRequest({ task: 't', step: null, verify: verifyStep, final: false, snap: null, display, cfg }),
    buildVisionRequest({ task: 't', step: clickStep, verify: null, final: false, snap: null, display, cfg }),
    buildVisionRequest({ task: 't', step: clickStep, verify: verifyStep, final: false, snap: null, display, cfg }),
    buildVisionRequest({ task: 't', step: null, verify: null, final: true, snap: null, display, cfg }),
  ];
  for (const b of combos) assert.equal(snapRefCount(b), 1);
});
check('buildVisionRequest: question keys match the option-key regex', () => {
  const b = buildVisionRequest({ task: 't', step: clickStep, verify: verifyStep, final: true, snap: null, display, cfg });
  for (const k of Object.keys(b.questions)) assert.ok(OPTION_KEY_RE.test(k), `bad key ${k}`);
});
check('buildVisionRequest: target question has no criteria; risky only for click family', () => {
  const b = buildVisionRequest({ task: 't', step: clickStep, verify: null, final: false, snap: null, display, cfg });
  assert.ok(!('criteria' in b.questions.target));
  assert.ok('risky' in b.questions);
  const t = buildVisionRequest({ task: 't', step: { op: 'type', target: 'field', text: 'x' }, verify: null, final: false, snap: null, display, cfg });
  assert.ok(!('risky' in t.questions));
});
check('buildVisionRequest: element absent without snap, present with snap, none always', () => {
  const noSnap = buildVisionRequest({ task: 't', step: clickStep, verify: null, final: false, snap: null, display, cfg });
  assert.ok(!('element' in noSnap.questions));
  const snap = { elements: [{ id: 'e1', i: 0, name: 'Send', aid: '', rect: [10, 10, 40, 20], type: 'Button' }], focused: null };
  const withSnap = buildVisionRequest({ task: 't', step: clickStep, verify: null, final: false, snap, display, cfg });
  assert.ok('element' in withSnap.questions);
  assert.ok('none' in withSnap.questions.element.criteria);
  assert.ok(Object.keys(withSnap.questions.element.criteria).length <= 255);
});
check('buildVisionRequest: elements outside the primary rect excluded', () => {
  const snap = {
    elements: [
      { id: 'e1', i: 0, name: 'inside', aid: '', rect: [10, 10, 40, 20], type: 'Button' },
      { id: 'e2', i: 1, name: 'offscreen', aid: '', rect: [5000, 5000, 40, 20], type: 'Button' },
    ],
    focused: null,
  };
  const b = buildVisionRequest({ task: 't', step: clickStep, verify: null, final: false, snap, display, cfg });
  assert.ok('e1' in b.elementMap);
  assert.ok(!('e2' in b.elementMap));
});
check('buildVisionRequest: target containing SCREEN_REF and backticks is sanitized', () => {
  const dirty = { op: 'click', target: `aura_screen_capture_img and \`Code\``, done_when: '' };
  const b = buildVisionRequest({ task: 'aura_screen_capture_img task', step: dirty, verify: null, final: false, snap: null, display, cfg });
  assert.equal(snapRefCount(b), 1);
  // The one SCREEN_REF lives in state.screenshot only; no question may carry it (T4).
  const asks = JSON.stringify(b.questions);
  assert.ok(!asks.includes(SCREEN_REF));
  assert.ok(!asks.includes('`Code`'));
});

// ── buildJevHttpBody / jevCallImages body ───────────────────────────────────
check('buildJevHttpBody: multipart request part + file part + danger header', async () => {
  const buffer = Buffer.from('jpeg-bytes');
  const { body, headers } = jev.buildJevHttpBody({
    model: 'jev-1.14.0', state: { screenshot: SCREEN_REF }, questions: { q: 1 },
    images: [{ ref: SCREEN_REF, part: 'image', buffer, format: 'jpeg' }],
    transport: 'multipart',
  });
  assert.ok(body instanceof FormData);
  const filePart = body.get('image');
  assert.ok(filePart && filePart.type === 'image/jpeg');
  const request = body.get('request');
  assert.ok(request && request.type === 'application/json');
  const parsed = JSON.parse(await request.text());
  assert.deepEqual(parsed.assets, { [SCREEN_REF]: { type: 'image', format: 'jpeg', part: 'image' } });
  assert.equal(headers['TypeSafe-Danger-Zone-Images'], 'true');
  assert.ok(!Object.keys(headers).some(k => k.toLowerCase() === 'content-type'));
});
check('buildJevHttpBody: json transport round-trips the buffer', () => {
  const buffer = Buffer.from('jpeg-bytes');
  const { body, headers } = jev.buildJevHttpBody({
    model: 'jev-1.14.0', state: {}, questions: {},
    images: [{ ref: SCREEN_REF, part: 'image', buffer, format: 'jpeg' }],
    transport: 'json',
  });
  const parsed = JSON.parse(body);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['TypeSafe-Danger-Zone-Images'], 'true');
  assert.ok(Buffer.from(parsed.assets[SCREEN_REF].data_base64, 'base64').equals(buffer));
});

// ── interpretVisionAnswers ──────────────────────────────────────────────────
function groundBuilt(extraElements) {
  const snap = extraElements ? {
    elements: extraElements, focused: null,
  } : null;
  return buildVisionRequest({ task: 't', step: clickStep, verify: null, final: false, snap, display, cfg });
}
function noul(v) { return { type: 'noul', noul: v }; }
function boxAns(l, t, r, b, c) { return { type: 'box', box: { left: l, top: t, right: r, bottom: b }, confidence: c }; }
function choice(id, c) { return { type: 'choice', choice: id, confidence: c, probabilities: {} }; }
function groundAns(over) {
  return Object.assign({ visible: noul(0.9), target: boxAns(0.4, 0.4, 0.6, 0.6, 0.9), blocked: noul(0.05), risky: noul(0.1) }, over);
}

check('interpretVisionAnswers: valid box -> box click at 500/500', () => {
  const r = interpretVisionAnswers(groundAns(), groundBuilt(), display, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.click.source, 'box');
  assert.equal(Math.round(r.click.nx), 500);
  assert.equal(Math.round(r.click.ny), 500);
  assert.equal(r.clickReason, 'box');
});
check('interpretVisionAnswers: inverted / out-of-range -> invalid', () => {
  assert.equal(interpretVisionAnswers(groundAns({ target: boxAns(0.6, 0.4, 0.4, 0.6, 0.9) }), groundBuilt(), display, cfg).boxReject, 'invalid');
  assert.equal(interpretVisionAnswers(groundAns({ target: boxAns(0.4, 0.4, 1.7, 0.6, 0.9) }), groundBuilt(), display, cfg).boxReject, 'invalid');
  assert.equal(interpretVisionAnswers(groundAns({ target: { type: 'box', box: { left: NaN, top: 0.4, right: 0.6, bottom: 0.6 }, confidence: 0.9 } }), groundBuilt(), display, cfg).boxReject, 'invalid');
});
check('interpretVisionAnswers: area 0.3 -> too_large; low conf', () => {
  assert.equal(interpretVisionAnswers(groundAns({ target: boxAns(0.1, 0.1, 0.7, 0.6, 0.9) }), groundBuilt(), display, cfg).boxReject, 'too_large');
  assert.equal(interpretVisionAnswers(groundAns({ target: boxAns(0.4, 0.4, 0.6, 0.6, 0.1) }), groundBuilt(), display, cfg).boxReject, 'low_conf');
});
check('interpretVisionAnswers: visible 0.2 -> null / not_visible', () => {
  const r = interpretVisionAnswers(groundAns({ visible: noul(0.2) }), groundBuilt(), display, cfg);
  assert.equal(r.click, null);
  assert.equal(r.clickReason, 'not_visible');
});
check('interpretVisionAnswers: element inside box -> element_agrees', () => {
  const els = [{ id: 'e1', i: 0, name: 'Send', aid: '', rect: [800, 432, 80, 40], type: 'Button' }]; // center 840,452 -> 0.4375,0.4185
  const ans = groundAns({ element: choice('e1', 0.9) });
  const r = interpretVisionAnswers(ans, groundBuilt(els), display, cfg);
  assert.equal(r.click.source, 'element');
  assert.equal(r.clickReason, 'element_agrees');
});
check('interpretVisionAnswers: element outside box -> box / element_box_disagree', () => {
  const els = [{ id: 'e1', i: 0, name: 'Send', aid: '', rect: [1700, 900, 80, 40], type: 'Button' }];
  const r = interpretVisionAnswers(groundAns({ element: choice('e1', 0.9) }), groundBuilt(els), display, cfg);
  assert.equal(r.click.source, 'box');
  assert.equal(r.clickReason, 'element_box_disagree');
});
check('interpretVisionAnswers: element only (no usable box)', () => {
  const els = [{ id: 'e1', i: 0, name: 'Send', aid: '', rect: [800, 432, 80, 40], type: 'Button' }];
  const ans = groundAns({ target: boxAns(1.5, 0.4, 1.6, 0.6, 0.9), element: choice('e1', 0.9) });
  const r = interpretVisionAnswers(ans, groundBuilt(els), display, cfg);
  assert.equal(r.click.source, 'element');
  assert.equal(r.clickReason, 'element');
});
check("interpretVisionAnswers: 'none' -> no element, box click", () => {
  const els = [{ id: 'e1', i: 0, name: 'Send', aid: '', rect: [800, 432, 80, 40], type: 'Button' }];
  const ans = groundAns({ element: choice('none', 0.9) });
  const r = interpretVisionAnswers(ans, groundBuilt(els), display, cfg);
  assert.equal(r.element, null);
  assert.equal(r.click.source, 'box');
});
check('interpretVisionAnswers: wrong shape of an asked question -> ok:false', () => {
  const ans = groundAns();
  delete ans.visible;
  const r = interpretVisionAnswers(ans, groundBuilt(), display, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_answer');
});
check('interpretVisionAnswers: missing un-asked question ignored', () => {
  const built = buildVisionRequest({ task: 't', step: null, verify: null, final: true, snap: null, display, cfg });
  const r = interpretVisionAnswers({ task_done: noul(0.9) }, built, display, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.prevDone, null);
  assert.equal(r.taskDone, 0.9);
});

// ── coordinates ─────────────────────────────────────────────────────────────
check('coords: box center (0.5,0.5) -> 500/500, (1,1) clamps to 999', () => {
  assert.deepEqual(boxCenterToNormalized({ left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 }), { nx: 500, ny: 500 });
  assert.deepEqual(boxCenterToNormalized({ left: 1, top: 1, right: 1, bottom: 1 }), { nx: 999, ny: 999 });
});
check('coords: element on a display with a physX offset', () => {
  const d = { dipW: 1920, dipH: 1080, physX: 100, physY: 50, physW: 1600, physH: 900, scaleFactor: 1 };
  const el = { rect: [900, 475, 100, 50] }; // center = 950, 500 (physical px)
  const n = elementCenterToNormalized(el, d);
  assert.equal(Math.round(n.nx), Math.round(((950 - 100) / 1600) * 1000));
  assert.equal(Math.round(n.ny), Math.round(((500 - 50) / 900) * 1000));
});
check('coords: element outside the display -> null', () => {
  assert.equal(elementCenterToNormalized({ rect: [5000, 5000, 10, 10] }, display), null);
});
check('coords: normalizedToPhysical inverts the display mapping', () => {
  assert.deepEqual(normalizedToPhysical({ nx: 500, ny: 500 }, display), { x: 960, y: 540 });
});

// ── runner harness ──────────────────────────────────────────────────────────
function mkCfg(over) { return Object.assign({}, readVisionConfig({}), over || {}); }

function harness(opts = {}) {
  let clock = 0;
  const sig = { aborted: false };
  const calls = { capture: 0, jev: 0, input: 0, inputParams: [], uiaSnapshot: 0, uiaClick: 0, openApp: [], confirm: 0, replan: 0, plan: 0 };
  const base = {
    capture: async () => { calls.capture++; return { ok: true, jpeg: Buffer.from('jpeg'), width: 1280, height: 720, ms: 5 }; },
    uiaSnapshot: async () => { calls.uiaSnapshot++; return { ok: false, reason: 'error', detail: 'no' }; },
    uiaClick: async () => { calls.uiaClick++; return { ok: true, method: 'mouse' }; },
    input: async (p) => { calls.input++; calls.inputParams.push(p); return { success: true }; },
    openApp: async (n) => { calls.openApp.push(n); return { success: true }; },
    jev: async (p) => {
      calls.jev++;
      if (opts.abortInJev) sig.aborted = true;
      const answers = opts.answerFn ? opts.answerFn(p.questions, calls.jev) : {};
      return { ok: true, model: 'jev-1.14.0', answers, usage: {}, ms: 7 };
    },
    plan: opts.plan === undefined ? null : async (i) => { calls.plan++; return typeof opts.plan === 'function' ? opts.plan(i) : opts.plan; },
    replan: opts.replan === undefined ? null : async (a) => { calls.replan++; return typeof opts.replan === 'function' ? opts.replan(a) : opts.replan; },
    confirm: async () => { calls.confirm++; return opts.confirmResult === undefined ? true : opts.confirmResult; },
    display: () => display,
    log: () => {},
    progress: () => {},
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    signal: sig,
  };
  Object.assign(base, opts.overrides || {});
  return { deps: base, calls, cfg: mkCfg(opts.cfg) };
}
function groundAnswer(over) {
  return Object.assign({ visible: noul(0.9), target: boxAns(0.4, 0.4, 0.6, 0.6, 0.9), blocked: noul(0.05), risky: noul(0.1) }, over || {});
}
function planResult(steps, source) { return { ok: true, ms: 12, plan: { steps, source: source || 'gemini' } }; }

check('runner (a): trivial click -> ground, click, final task_done, done', async () => {
  const h = harness({
    cfg: { uia: false },
    answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : groundAnswer()),
  });
  const r = await runVisionTask('click the Start button', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.equal(h.calls.jev, 2);
  assert.equal(h.calls.input, 1);
  assert.deepEqual(h.calls.inputParams[0], { action: 'click', nx: 500, ny: 500 });
  assert.equal(h.calls.capture, 2); // ground observation + final task_done screenshot
});

check('runner (b): open_app polls, then exact planner text typed once', async () => {
  const plan = planResult([
    { op: 'open_app', app: 'notepad', done_when: 'Notepad window is open' },
    { op: 'type', text: 'hello from aura' },
  ]);
  let vc = 0;
  const h = harness({
    cfg: { uia: false },
    plan,
    answerFn: (q) => {
      if (q.task_done) return { task_done: noul(0.9) };
      if (q.prev_done) { vc++; return { prev_done: noul(vc === 1 ? 0.2 : 0.9) }; }
      return {};
    },
  });
  const r = await runVisionTask('open notepad and type hello from aura', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.deepEqual(h.calls.openApp, ['notepad']);
  const typeCalls = h.calls.inputParams.filter(p => p.action === 'type');
  assert.equal(typeCalls.length, 1);
  assert.equal(typeCalls[0].text, 'hello from aura');
});

check('runner (c): target never visible -> polls, replan x2, failed', async () => {
  const step = { op: 'click', target: 'missing button', done_when: '' };
  const h = harness({
    cfg: { uia: false, maxReplans: 2 },
    plan: () => planResult([step]),
    replan: () => planResult([step], 'replan'),
    answerFn: (q) => (q.target ? groundAnswer({ visible: noul(0.1) }) : {}),
  });
  const r = await runVisionTask('click something', h.deps, h.cfg);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.replan, 2);
  assert.equal(h.calls.input, 0);
});

check('runner (d): consequential + confirm false -> refused, no input', async () => {
  const h = harness({ cfg: { uia: false, confirm: true }, confirmResult: false, answerFn: () => groundAnswer() });
  const r = await runVisionTask('click the Delete button', h.deps, h.cfg);
  assert.equal(r.status, 'refused');
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.input, 0);
});

check('runner (e): abort during jev call -> cancelled, no input after', async () => {
  const h = harness({
    cfg: { uia: false },
    plan: () => planResult([{ op: 'click', target: 'Send', done_when: '' }]),
    abortInJev: true,
    answerFn: () => groundAnswer(),
  });
  const r = await runVisionTask('click send', h.deps, h.cfg);
  assert.equal(r.status, 'cancelled');
  assert.equal(h.calls.input, 0);
});

check('runner (f): repeating the same click -> replan then failed', async () => {
  const click1 = { op: 'click', target: 'cell', done_when: 'cell is selected' };
  const waitStep = { op: 'wait', seconds: 0.2 };
  const h = harness({
    cfg: { uia: false },
    plan: () => planResult([click1, waitStep]),
    replan: () => planResult([click1, waitStep], 'replan'),
    answerFn: (q) => (q.prev_done ? { prev_done: noul(0.1) } : groundAnswer()),
  });
  const r = await runVisionTask('select the cell', h.deps, h.cfg);
  assert.equal(r.status, 'failed');
  assert.equal(r.summary, 'repeating');
  assert.ok(h.calls.replan >= 1);
});

check('runner (g): jev 401 -> error after one call', async () => {
  const h = harness({
    cfg: { uia: false },
    overrides: { jev: async () => { h.calls.jev++; return { ok: false, status: 401, error: 'unauthorized', ms: 4 }; } },
  });
  const r = await runVisionTask('click the Start button', h.deps, h.cfg);
  assert.equal(r.status, 'error');
  assert.equal(h.calls.jev, 1);
});

check('runner (h): UIA timeout disables UIA for the rest of the run', async () => {
  const h = harness({
    cfg: { uia: true },
    overrides: { uiaSnapshot: async () => { h.calls.uiaSnapshot++; return { ok: false, reason: 'timeout' }; } },
    answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : groundAnswer()),
  });
  const r = await runVisionTask('click the Start button', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.equal(h.calls.uiaSnapshot, 1);
});

check('runner (i): uiaClick stale_snapshot -> input click at element center', async () => {
  const els = [{ id: 'e1', i: 0, name: 'Start', aid: '', rect: [900, 900, 100, 40], type: 'Button', pats: ['invoke'] }];
  const h = harness({
    cfg: { uia: true },
    overrides: {
      uiaSnapshot: async () => { h.calls.uiaSnapshot++; return { ok: true, snapshotId: 'g0s1', elements: els, focused: null, title: 'w', process: 'p' }; },
      uiaClick: async () => { h.calls.uiaClick++; return { ok: false, reason: 'stale_snapshot' }; },
    },
    answerFn: (q) => {
      if (q.task_done) return { task_done: noul(0.9) };
      return { visible: noul(0.9), target: boxAns(1.5, 0.4, 1.6, 0.5, 0.9), element: choice('e1', 0.9), blocked: noul(0.1), risky: noul(0.1) };
    },
  });
  const r = await runVisionTask('click the Start button', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.equal(h.calls.uiaClick, 1);
  const click = h.calls.inputParams.find(p => p.action === 'click');
  assert.ok(click);
  assert.ok(Math.abs(click.nx - 494.79) < 1);
  assert.ok(Math.abs(click.ny - 851.85) < 1);
});

// ── misc ────────────────────────────────────────────────────────────────────
check('runner (d2): type with submit that is consequential, confirm false -> refused, no input', async () => {
  const h = harness({
    cfg: { uia: false, confirm: true },
    confirmResult: false,
    plan: planResult([{ op: 'type', text: 'send it', submit: true, risky: true }]),
    answerFn: () => ({}),
  });
  const r = await runVisionTask('type something and press enter', h.deps, h.cfg);
  assert.equal(r.status, 'refused');
  assert.equal(h.calls.confirm, 1);
  assert.equal(h.calls.input, 0);
});

check('runner (d3): risky hotkey with confirm disabled -> refused, no input', async () => {
  const h = harness({
    cfg: { uia: false, confirm: false },
    plan: planResult([{ op: 'hotkey', keys: 'enter', risky: true }]),
    answerFn: () => ({}),
  });
  const r = await runVisionTask('submit the form and finish', h.deps, h.cfg);
  assert.equal(r.status, 'refused');
  assert.equal(h.calls.input, 0);
});

check('jevCall: timer stays armed through a stalled body read', async () => {
  const realFetch = global.fetch;
  global.fetch = (url, init) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }),
  });
  try {
    const r = await jev.jevCall({ key: 'k', state: 's', questions: {}, timeoutMs: 80 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
  } finally { global.fetch = realFetch; }
});

check('runner (d4): enter hotkey is gated even when the planner did not flag it', async () => {
  for (const keys of ['enter', 'ctrl+enter', 'alt+f4', 'shift+delete', 'delete']) {
    const h = harness({
      cfg: { uia: false, confirm: true }, confirmResult: false,
      plan: planResult([{ op: 'hotkey', keys }]), answerFn: () => ({}),
    });
    const r = await runVisionTask('press a key then finish', h.deps, h.cfg);
    assert.equal(r.status, 'refused', keys);
    assert.equal(h.calls.input, 0, keys);
  }
  const ok = harness({ cfg: { uia: false }, plan: planResult([{ op: 'hotkey', keys: 'ctrl+l' }]), answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : {}) });
  const r2 = await runVisionTask('press ctrl l then finish', ok.deps, ok.cfg);
  assert.equal(r2.status, 'done');
  assert.equal(ok.calls.confirm, 0);
});

check('runner (d5): risky type without submit and risky open_app are gated', async () => {
  for (const step of [{ op: 'type', text: 'hello', risky: true }, { op: 'open_app', app: 'notepad', risky: true }]) {
    const h = harness({ cfg: { uia: false, confirm: true }, confirmResult: false, plan: planResult([step]), answerFn: () => ({}) });
    const r = await runVisionTask('do two things then stop', h.deps, h.cfg);
    assert.equal(r.status, 'refused', step.op);
    assert.equal(h.calls.input, 0);
    assert.equal(h.calls.openApp.length, 0);
  }
});

check('runner: final verify is not failed by maxActions', async () => {
  const h = harness({
    cfg: { uia: false, maxActions: 1 },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : {}),
  });
  const r = await runVisionTask('press ctrl l then finish', h.deps, h.cfg);
  assert.equal(r.status, 'done');
});

check('runner: typing failure reported by input -> error, not retried', async () => {
  const h = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'type', text: 'abc' }]),
    answerFn: () => ({}),
    overrides: { input: async (p) => ({ success: p.action !== 'type' }) },
  });
  const r = await runVisionTask('type abc then stop', h.deps, h.cfg);
  assert.equal(r.status, 'error');
});

check('readVisionConfig: maxMs clamped to 140000', () => {
  assert.equal(readVisionConfig({ AURA_JV_MAX_MS: '900000' }).maxMs, 140000);
  assert.equal(readVisionConfig({ AURA_JV_MAX_MS: '60000' }).maxMs, 60000);
});

check('automation.buildTypeScript: single-pass SendKeys escaping', () => {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { Notification: class {} } : orig.call(this, req, ...rest); };
  let build;
  try { build = require(path.join(__dirname, '..', 'src', 'automation.js')).buildTypeScript; } finally { Module._load = orig; }
  const lit = (t) => /SendKeys\('(.*)'\)/.exec(build(t))[1];
  assert.equal(lit('a+b'), 'a{+}b');
  assert.equal(lit('{x}'), '{{}x{}}');
  assert.equal(lit('(1)^%~[]'), '{(}1{)}{^}{%}{~}{[}{]}');
  assert.ok(build('x').includes('catch'));
});

check('readVisionConfig: planner hedge / capture / warmup defaults and overrides', () => {
  const c = readVisionConfig({});
  assert.equal(c.plannerTimeoutMs, 12000);
  assert.equal(c.plannerHedgeMs, 2500);
  assert.equal(c.plannerMaxRequests, 3);
  assert.equal(c.plannerThinking, 'low');
  assert.equal(c.fastCapture, true);
  assert.equal(c.warmup, true);
  const o = readVisionConfig({ AURA_PLANNER_HEDGE_MS: '900', AURA_PLANNER_THINKING: 'minimal', AURA_PLANNER_MAX_REQUESTS: '9',
    AURA_JV_FAST_CAPTURE: '0', AURA_JV_WARMUP: '0', AURA_PLANNER_MAX_TOKENS: 'abc' });
  assert.equal(o.plannerHedgeMs, 900);
  assert.equal(o.plannerThinking, 'minimal');
  assert.equal(o.plannerMaxRequests, 3);
  assert.equal(o.fastCapture, false);
  assert.equal(o.warmup, false);
  assert.equal(o.plannerMaxTokens, 2048);
  assert.equal(readVisionConfig({ AURA_PLANNER_THINKING: 'bogus' }).plannerThinking, 'low');
});

check('validatePlan: open_url accepts http(s) only and is never risky', () => {
  const ok = validatePlan({ steps: [{ op: 'open_url', url: ' https://www.google.com/search?q=best phone under 50k ', risky: true, done_when: 'results' }] });
  assert.equal(ok.ok, true);
  const st = ok.plan.steps[0];
  assert.equal(st.url, 'https://www.google.com/search?q=best%20phone%20under%2050k');
  assert.equal(st.risky, undefined);
  for (const bad of ['javascript:alert(1)', 'file:///c:/windows/win.ini', 'ftp://x.com/a', '', 'not a url', 'https://user:pw@evil.com/', 'https://' + 'a'.repeat(2100) + '.com']) {
    const r = validatePlan({ steps: [{ op: 'open_url', url: bad }] });
    assert.equal(r.ok, false, bad.slice(0, 30));
    assert.ok(/step 1/.test(r.error));
  }
  assert.equal(validatePlan({ steps: [{ op: 'open_url' }] }).ok, false);
  assert.equal(isConsequential({ op: 'open_url', url: 'https://x.com/delete-account' }), false);
  assert.equal(describeStep({ op: 'open_url', url: 'https://www.google.com/search?q=a' }), 'open www.google.com');
});

// ── planner hedging with a fake fetch ───────────────────────────────────────
const { hedgedPlan } = require(path.join(__dirname, '..', 'src', 'jev-planner.js'));

function geminiBody(planObj) { return { candidates: [{ content: { parts: [{ text: typeof planObj === 'string' ? planObj : JSON.stringify(planObj) }] } }] }; }
const GOOD_PLAN = { steps: [{ op: 'open_app', app: 'notepad', done_when: '' }] };

// script: array of { delay, status?, body } consumed in call order; the last entry repeats.
function fakeFetch(script) {
  const log = { calls: 0, aborted: 0 };
  const fn = (url, init) => {
    const i = Math.min(log.calls, script.length - 1);
    log.calls++;
    const s = script[i];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const status = s.status || 200;
        resolve({ ok: status >= 200 && status < 300, status, json: async () => s.body });
      }, s.delay || 0);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        log.aborted++;
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    });
  };
  return { fn, log };
}
const hedgeBase = { key: 'k', userText: 'TASK: x', source: 'gemini', model: 'm' };

check('hedgedPlan: slow first request is beaten by the hedge, loser aborted', async () => {
  const f = fakeFetch([{ delay: 600, body: geminiBody(GOOD_PLAN) }, { delay: 10, body: geminiBody(GOOD_PLAN) }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 40, fetchFn: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.requests, 2);
  assert.ok(r.ms < 400, `took ${r.ms}`);
  assert.equal(f.log.aborted, 1);
  assert.equal(r.plan.source, 'gemini');
});

check('hedgedPlan: invalid JSON triggers an immediate replacement (before the hedge delay)', async () => {
  const f = fakeFetch([{ delay: 5, body: geminiBody('{not json') }, { delay: 5, body: geminiBody(GOOD_PLAN) }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 5000, fetchFn: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.requests, 2);
  assert.ok(r.ms < 1000);
});

check('hedgedPlan: invalid plan (bad op) also replaces; max 3 requests then fails', async () => {
  const f = fakeFetch([{ delay: 5, body: geminiBody({ steps: [{ op: 'launch_rocket' }] }) }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 5000, fetchFn: f.fn });
  assert.equal(r.ok, false);
  assert.equal(r.requests, 3);
  assert.equal(f.log.calls, 3);
  assert.ok(/bad op/.test(r.error));
});

check('hedgedPlan: a final 4xx ends immediately with one request', async () => {
  const f = fakeFetch([{ delay: 5, status: 400, body: { error: { message: 'bad request' } } }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 5000, fetchFn: f.fn });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.requests, 1);
});

check('hedgedPlan: 429 and 5xx are retried; the 429 replacement waits out the back-off', async () => {
  const f = fakeFetch([{ delay: 5, status: 429, body: {} }, { delay: 5, status: 503, body: {} }, { delay: 5, body: geminiBody(GOOD_PLAN) }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 5000, retryAfter429Ms: 150, fetchFn: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.requests, 3);
  assert.ok(r.ms >= 140, `429 retry fired too early: ${r.ms}`);
  // a 5xx replacement is immediate
  const g = fakeFetch([{ delay: 5, status: 503, body: {} }, { delay: 5, body: geminiBody(GOOD_PLAN) }]);
  const r2 = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 5000, retryAfter429Ms: 500, fetchFn: g.fn });
  assert.equal(r2.ok, true);
  assert.ok(r2.ms < 300, `5xx retry was delayed: ${r2.ms}`);
});

check('hedgedPlan: 429 back-off is capped by the remaining budget and still finishes', async () => {
  const f = fakeFetch([{ delay: 5, status: 429, body: {} }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 700, hedgeMs: 5000, retryAfter429Ms: 5000, fetchFn: f.fn });
  assert.equal(r.ok, false);
  assert.ok(r.ms < 1500, `took ${r.ms}`);
  assert.ok(r.requests >= 1 && r.requests <= 3);
});

check('hedgedPlan: overall budget aborts every request and reports timeout', async () => {
  const f = fakeFetch([{ delay: 5000, body: geminiBody(GOOD_PLAN) }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 200, hedgeMs: 50, fetchFn: f.fn });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.ok(r.ms < 1000);
  assert.equal(f.log.aborted, f.log.calls);
});

check('hedgedPlan: maxRequests 1 never hedges; external abort cancels', async () => {
  const f = fakeFetch([{ delay: 150, body: geminiBody(GOOD_PLAN) }]);
  const r = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 10, maxRequests: 1, fetchFn: f.fn });
  assert.equal(r.ok, true);
  assert.equal(f.log.calls, 1);
  const g = fakeFetch([{ delay: 5000, body: geminiBody(GOOD_PLAN) }]);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  const r2 = await hedgedPlan({ ...hedgeBase, timeoutMs: 3000, hedgeMs: 5000, signal: ctl.signal, fetchFn: g.fn });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'aborted');
  assert.equal(g.log.aborted, 1);
});

check('runner: open_url step opens the url once through deps.openUrl; failure -> error', async () => {
  const opened = [];
  const plan = planResult([{ op: 'open_url', url: 'https://www.google.com/search?q=phone', done_when: '' }]);
  const h = harness({
    cfg: { uia: false }, plan,
    answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : {}),
    overrides: { openUrl: async (u) => { opened.push(u); return { success: true }; } },
  });
  const r = await runVisionTask('search for phones then stop', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.deepEqual(opened, ['https://www.google.com/search?q=phone']);
  assert.equal(h.calls.confirm, 0);
  const bad = harness({ cfg: { uia: false }, plan, overrides: { openUrl: async () => ({ success: false }) } });
  assert.equal((await runVisionTask('search for phones then stop', bad.deps, bad.cfg)).status, 'error');
});

check('automation app index: parse Get-StartApps lines and look names up', () => {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { Notification: class {} } : orig.call(this, req, ...rest); };
  let auto;
  try { auto = require(path.join(__dirname, '..', 'src', 'automation.js')); } finally { Module._load = orig; }
  const entries = auto.parseAppIndex([
    'WhatsApp||5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
    'Google Chrome||Chrome',
    'Chrome Remote Desktop||Chrome.RemoteDesktop',
    'Notepad||Microsoft.WindowsNotepad_8wekyb3d8bbwe!App',
    'Notepad++||{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe',
    'Uninstall Notepad++||{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\uninstall.exe',
    'Evil||C:\\Windows\\evil.exe',
    'Quote||bad"id',
    'no separator line',
  ].join('\r\n'));
  assert.equal(entries.length, 6); // path ids, quotes and junk lines are dropped
  const hit = (q) => { const e = auto.lookupAppEntry(entries, q); return e && e.name; };
  assert.equal(hit('whatsapp'), 'WhatsApp');
  assert.equal(hit('WhatsApp '), 'WhatsApp');
  assert.equal(hit('chrome'), 'Google Chrome');
  assert.equal(hit('notepad'), 'Notepad');
  assert.equal(hit('the notepad'), 'Notepad');
  assert.equal(hit('uninstall notepad'), 'Uninstall Notepad++');
  assert.equal(hit('nonexistent app'), null);
  assert.equal(hit('x'), null);
  assert.equal(auto.lookupAppEntry(null, 'notepad'), null);
});

check('app index: failed or empty builds are not retried before the refresh interval', async () => {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { Notification: class {} } : orig.call(this, req, ...rest); };
  let auto;
  try { auto = require(path.join(__dirname, '..', 'src', 'automation.js')); } finally { Module._load = orig; }
  const t = auto.__appIndexTest;
  let builds = 0;
  let out = '';
  t.setRunner(async () => { builds++; return { success: true, output: out }; });
  t.reset();
  // before any build exists, a lookup returns null at once and never builds
  assert.equal(await t.find('notepad'), null);
  assert.equal(builds, 0);
  // empty result: one attempt, then no retry on warm or on lookups
  out = '';
  auto.warmAppIndex(); await t.wait();
  assert.equal(builds, 1);
  auto.warmAppIndex(); await t.wait();
  assert.equal(await t.find('notepad'), null);
  assert.equal(builds, 1);
  // a thrown runner is also recorded as an attempt
  t.reset();
  t.setRunner(async () => { builds++; throw new Error('boom'); });
  builds = 0;
  auto.warmAppIndex(); await t.wait();
  auto.warmAppIndex(); await t.wait();
  assert.equal(builds, 1);
  // success: index used, a miss inside the interval does not rebuild
  t.reset();
  builds = 0;
  t.setRunner(async () => { builds++; return { success: true, output: 'Notepad||Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }; });
  auto.warmAppIndex(); await t.wait();
  assert.equal((await t.find('notepad')).name, 'Notepad');
  assert.equal(await t.find('nothing here'), null);
  assert.equal(builds, 1);
  t.setRunner(async () => ({ success: true, output: '' }));
  t.reset();
});

// ── round 3: unchanged-frame skip, done_unconfirmed, continue replans, drag, trivial router ──
const { lumaSignature, sameFrame } = vision;
const { replanTask } = require(path.join(__dirname, '..', 'src', 'jev-planner.js'));

// Capture override whose frame signature comes from sigFn(callIndex); counts captures.
function sigCapture(sigFn) {
  const st = { n: 0 };
  const fn = async () => { st.n++; return { ok: true, jpeg: Buffer.from('jpeg'), width: 1280, height: 720, ms: 5, sig: sigFn(st.n) }; };
  return { fn, st };
}
const flat = (v) => new Uint8Array(48 * 27).fill(v);

check('config: maxReplans default 5, finalPolls and frameSkip flags', () => {
  const c = readVisionConfig({});
  assert.equal(c.maxReplans, 5);
  assert.equal(c.finalPolls, 2);
  assert.equal(c.frameSkip, true);
  assert.equal(readVisionConfig({ AURA_JV_FRAME_SKIP: '0' }).frameSkip, false);
  assert.equal(readVisionConfig({ AURA_JV_MAX_REPLANS: '3' }).maxReplans, 3);
});

check('sameFrame: caret blink is the same screen, a dialog is not', () => {
  const a = flat(200);
  const blink = flat(200); blink[100] = 120; blink[101] = 130; // two cells change
  const dialog = flat(200); for (let i = 0; i < 60; i++) dialog[300 + i] = 40;
  assert.equal(sameFrame(a, blink), true);
  assert.equal(sameFrame(a, dialog), false);
  assert.equal(sameFrame(a, null), false);
  const bgra = Buffer.alloc(48 * 27 * 4, 255);
  assert.equal(lumaSignature(bgra).length, 48 * 27);
  assert.equal(lumaSignature(bgra)[0], 255);
  assert.equal(lumaSignature(Buffer.alloc(8)), null);
});

check('runner: unchanged screen -> second low-visibility answer is not asked again, straight to replan', async () => {
  const cap = sigCapture(() => flat(100));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    replan: { ok: false, error: 'x', ms: 1 },
    answerFn: (q) => (q.target ? groundAnswer({ visible: noul(0.02), target: boxAns(0.4, 0.4, 0.6, 0.6, 0.1) }) : {}),
  });
  const r = await runVisionTask('click something', h.deps, h.cfg);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.jev, 1);
  assert.equal(h.calls.replan, 1);
  assert.ok(cap.st.n >= 2);
});

check('runner: changing screen is asked every time (no skip)', async () => {
  const cap = sigCapture((n) => flat(10 + n * 40));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    replan: { ok: false, error: 'x', ms: 1 },
    answerFn: (q) => (q.target ? groundAnswer({ visible: noul(0.02), target: boxAns(0.4, 0.4, 0.6, 0.6, 0.1) }) : {}),
  });
  const r = await runVisionTask('click something', h.deps, h.cfg);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.jev, 1 + h.cfg.maxPolls);
});

check('runner: frameSkip off asks Jev on every poll', async () => {
  const cap = sigCapture(() => flat(100));
  const h = harness({
    cfg: { uia: false, frameSkip: false },
    overrides: { capture: cap.fn },
    replan: { ok: false, error: 'x', ms: 1 },
    answerFn: (q) => (q.target ? groundAnswer({ visible: noul(0.02), target: boxAns(0.4, 0.4, 0.6, 0.6, 0.1) }) : {}),
  });
  await runVisionTask('click something', h.deps, h.cfg);
  assert.equal(h.calls.jev, 1 + h.cfg.maxPolls);
});

check('runner: unchanged verify polls of an open_app cost one Jev call, then replan', async () => {
  const cap = sigCapture(() => flat(100));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    plan: planResult([{ op: 'open_app', app: 'notepad', done_when: 'Notepad window is open' }, { op: 'hotkey', keys: 'ctrl+n' }]),
    replan: { ok: false, error: 'x', ms: 1 },
    answerFn: (q) => (q.prev_done ? { prev_done: noul(0.02) } : {}),
  });
  const r = await runVisionTask('open notepad and make a new file', h.deps, h.cfg);
  assert.equal(r.status, 'failed');
  assert.equal(h.calls.jev, 1);
  assert.equal(h.calls.replan, 1);
});

check('runner: every step done, task_done low -> done_unconfirmed (ok), two final asks on a changing screen', async () => {
  const cap = sigCapture((n) => flat(10 + n * 40));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.2) } : {}),
  });
  const r = await runVisionTask('focus the address bar then wait', h.deps, h.cfg);
  assert.equal(r.status, 'done_unconfirmed');
  assert.equal(r.ok, true);
  assert.equal(h.calls.jev, 2);
});

check('runner: final on an unchanged screen asks once', async () => {
  const cap = sigCapture(() => flat(100));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.2) } : {}),
  });
  const r = await runVisionTask('focus the address bar then wait', h.deps, h.cfg);
  assert.equal(r.status, 'done_unconfirmed');
  assert.equal(h.calls.jev, 1);
});

check('runner: last step unverified and done low, no replans left -> unverified', async () => {
  const h = harness({
    cfg: { uia: false, maxReplans: 0 },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: 'address bar is focused' }]),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.2), prev_done: noul(0.1) } : {}),
  });
  const r = await runVisionTask('focus the address bar then wait', h.deps, h.cfg);
  assert.equal(r.status, 'unverified');
});

check('runner: done clearly low on a changed screen -> continue replan with screenshot, then done', async () => {
  const seen = [];
  let finals = 0;
  const h = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    replan: (a) => { seen.push(a); return planResult([{ op: 'hotkey', keys: 'ctrl+t', done_when: '' }], 'replan'); },
    answerFn: (q) => { if (q.task_done) { finals++; return { task_done: noul(finals <= 2 ? 0.01 : 0.9) }; } return {}; },
  });
  const r = await runVisionTask('open a tab and focus the bar then wait', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.equal(h.calls.replan, 1);
  assert.equal(seen[0].mode, 'continue');
  assert.equal(seen[0].failed, null);
  assert.ok(Buffer.isBuffer(seen[0].image) && seen[0].image.length > 0);
  assert.equal(seen[0].jev.taskDone, 0.01);
  assert.equal(h.calls.input, 2); // ctrl+l then the continued ctrl+t
});

check('runner: continue replan says complete -> done_unconfirmed; planner failure falls back to the verdict', async () => {
  const done = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    replan: { ok: true, ms: 3, plan: { steps: [], source: 'replan', complete: true } },
    answerFn: (q) => (q.task_done ? { task_done: noul(0.01) } : {}),
  });
  assert.equal((await runVisionTask('focus the address bar then wait', done.deps, done.cfg)).status, 'done_unconfirmed');
  const soft = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    replan: { ok: false, error: 'timeout', ms: 3 },
    answerFn: (q) => (q.task_done ? { task_done: noul(0.01) } : {}),
  });
  assert.equal((await runVisionTask('focus the address bar then wait', soft.deps, soft.cfg)).status, 'done_unconfirmed');
});

check('runner: continue replans share the maxReplans budget', async () => {
  const h = harness({
    cfg: { uia: false, maxReplans: 2 },
    plan: planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }]),
    replan: () => planResult([{ op: 'hotkey', keys: 'ctrl+l', done_when: '' }], 'replan'),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.01) } : {}),
  });
  const r = await runVisionTask('focus the address bar then wait', h.deps, h.cfg);
  assert.equal(r.status, 'done_unconfirmed');
  assert.equal(h.calls.replan, 2);
});

check('final question names the last step and its done_when', () => {
  const b = buildVisionRequest({ task: 'add it to cart', step: null, verify: null, final: true, snap: null, display, cfg,
    lastStep: { op: 'click', target: 'Add to cart button', done_when: 'cart count increases' } });
  const q = b.questions.task_done.instructions;
  assert.ok(q.includes('Add to cart button') && q.includes('cart count increases'));
});

check('log: a verified+grounded observation logs one line with both outcomes', async () => {
  const lines = [];
  const h = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'open_app', app: 'notepad', done_when: 'Notepad is open' }, { op: 'click', target: 'text area', done_when: '' }]),
    overrides: { log: (l) => lines.push(l) },
    answerFn: (q) => {
      if (q.task_done) return { task_done: noul(0.9) };
      if (q.target) return groundAnswer({ prev_done: noul(0.9) });
      return {};
    },
  });
  await runVisionTask('open notepad and click the text area', h.deps, h.cfg);
  const jev = lines.filter(l => /^\[jv\] #\d+ /.test(l));
  const nums = jev.map(l => /#(\d+)/.exec(l)[1]);
  assert.equal(new Set(nums).size, nums.length, 'one line per Jev call');
  assert.ok(jev.some(l => /verified\+box/.test(l)));
});

check('parseTrivialCommand: open <name> only when the app resolves; keys must be real', () => {
  const known = (n) => ['notepad', 'vscode', 'whatsapp'].includes(n.toLowerCase());
  assert.equal(parseTrivialCommand('open vscode project aura', { appKnown: known }), null);
  assert.equal(parseTrivialCommand('open vscode', { appKnown: known }).steps[0].app, 'vscode');
  assert.equal(parseTrivialCommand('open randomthing', { appKnown: known }), null);
  assert.equal(parseTrivialCommand('open randomthing').steps[0].app, 'randomthing'); // no checker: old behaviour
  assert.equal(parseTrivialCommand('open notepad', { appKnown: () => { throw new Error('x'); } }), null);
  assert.equal(parseTrivialCommand('press enter key').steps[0].keys, 'enter');
  assert.equal(parseTrivialCommand('press the big red thing'), null);
  assert.equal(parseTrivialCommand('press f5').steps[0].keys, 'f5');
  assert.equal(parseTrivialCommand('click the first search result link in the middle of the page now'), null);
  assert.equal(parseTrivialCommand('click the Start button').steps[0].target, 'Start button');
});

check('runner: "open vscode project aura" goes to the planner when the app is unknown', async () => {
  const h = harness({
    cfg: { uia: false },
    overrides: { appKnown: (n) => n === 'vscode' },
    plan: planResult([{ op: 'open_app', app: 'vscode', done_when: '' }]),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : {}),
  });
  await runVisionTask('open vscode project aura', h.deps, h.cfg);
  assert.equal(h.calls.plan, 1);
  assert.deepEqual(h.calls.openApp, ['vscode']);
});

check('validatePlan: drag with target + from/to fractions, or two targets', () => {
  const one = validatePlan({ steps: [{ op: 'drag', target: 'white canvas', from: [0.2, 1.4], to: [0.8, 0.5] }] });
  assert.equal(one.ok, true);
  assert.deepEqual(one.plan.steps[0].from, [0.2, 1]);
  assert.deepEqual(one.plan.steps[0].to, [0.8, 0.5]);
  const two = validatePlan({ steps: [{ op: 'drag', target_from: 'file icon', target_to: 'folder' }] });
  assert.equal(two.ok, true);
  assert.equal(two.plan.steps[0].target, undefined);
  const dflt = validatePlan({ steps: [{ op: 'drag', target: 'canvas' }] });
  assert.equal(dflt.ok, true);
  assert.deepEqual(dflt.plan.steps[0].from, [0.25, 0.25]);
  assert.deepEqual(dflt.plan.steps[0].to, [0.75, 0.75]);
  for (const bad of [{ op: 'drag' }, { op: 'drag', target: 'x', from: [0.1, 0.1] }, { op: 'drag', target: 'x', from: [0.1], to: [0.2, 0.2] },
    { op: 'drag', target_from: 'a' }, { op: 'drag', target: 'x', from: ['a', 1], to: [0, 0] }]) {
    assert.equal(validatePlan({ steps: [bad] }).ok, false, JSON.stringify(bad));
  }
  assert.equal(describeStep(two.plan.steps[0]), 'drag "file icon" to "folder"');
});

check('interpret: drag over one area maps from/to inside the box (large boxes allowed)', () => {
  const step = { op: 'drag', target: 'white canvas', from: [0.2, 0.5], to: [0.8, 0.5] };
  const built = buildVisionRequest({ task: 't', step, verify: null, final: false, snap: null, display, cfg });
  assert.ok(built.questions.target && !built.questions.element && built.questions.risky);
  const r = interpretVisionAnswers({ visible: noul(0.9), blocked: noul(0.05), risky: noul(0.1), target: boxAns(0.1, 0.1, 0.9, 0.9, 0.9) }, built, display, cfg);
  assert.equal(r.clickReason, 'drag');
  assert.ok(Math.abs(r.click.nx - 260) < 1e-6 && Math.abs(r.click.ny - 500) < 1e-6);
  assert.ok(Math.abs(r.click.nx2 - 740) < 1e-6 && Math.abs(r.click.ny2 - 500) < 1e-6);
});

check('interpret: drag between two boxes in ONE call', () => {
  const step = { op: 'drag', target_from: 'file icon', target_to: 'folder' };
  const built = buildVisionRequest({ task: 't', step, verify: null, final: false, snap: null, display, cfg });
  assert.ok(built.questions.target && built.questions.target_to);
  assert.equal(JSON.stringify(built.state).split(SCREEN_REF).length - 1, 1);
  const r = interpretVisionAnswers({ visible: noul(0.9), blocked: noul(0.05), risky: noul(0.1), target: boxAns(0.1, 0.1, 0.2, 0.2, 0.9), target_to: boxAns(0.7, 0.7, 0.8, 0.8, 0.9) }, built, display, cfg);
  assert.equal(r.clickReason, 'drag');
  assert.ok(Math.abs(r.click.nx - 150) < 1e-6 && Math.abs(r.click.nx2 - 750) < 1e-6);
  const bad = interpretVisionAnswers({ visible: noul(0.9), blocked: noul(0.05), risky: noul(0.1), target: boxAns(0.1, 0.1, 0.2, 0.2, 0.9), target_to: boxAns(0.7, 0.7, 0.8, 0.8, 0.05) }, built, display, cfg);
  assert.equal(bad.click, null);
});

check('runner: drag step goes through input as one drag action with both points', async () => {
  const plan = planResult([{ op: 'drag', target: 'white canvas', from: [0.2, 0.5], to: [0.8, 0.5], done_when: '' }]);
  const h = harness({
    cfg: { uia: false }, plan,
    answerFn: (q) => (q.task_done ? { task_done: noul(0.9) } : { visible: noul(0.9), blocked: noul(0.05), risky: noul(0.1), target: boxAns(0.1, 0.1, 0.9, 0.9, 0.9) }),
  });
  const r = await runVisionTask('draw a line on the canvas then stop', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.equal(h.calls.input, 1);
  const p = h.calls.inputParams[0];
  assert.equal(p.action, 'drag');
  assert.ok(Math.abs(p.nx - 260) < 1e-6 && Math.abs(p.nx2 - 740) < 1e-6 && Math.abs(p.ny2 - 500) < 1e-6);
});

check('automation: drag script is mouse down, intermediate moves, mouse up', () => {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { Notification: class {} } : orig.call(this, req, ...rest); };
  let auto;
  try { auto = require(path.join(__dirname, '..', 'src', 'automation.js')); } finally { Module._load = orig; }
  const script = auto.__dragScript(100, 200, 300, 400);
  assert.ok(script.indexOf('::LD,') !== -1 && script.indexOf('::LU,') !== -1);
  assert.ok(script.indexOf('::LD,') < script.indexOf('for (') && script.indexOf('for (') < script.indexOf('::LU,'));
  assert.ok(/steps = 20/.test(script));
});

check('replanTask: sends the screenshot as inline image; continue accepts task_complete, fail does not', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => geminiBody({ steps: [], task_complete: true }) };
  };
  const r = await replanTask({ key: 'k', instruction: 'add all pc parts on flipkart', done: ['open flipkart.com'], failed: null,
    screen: null, image: Buffer.from('fakejpeg'), jev: { vis: 0.02, boxConf: 0.1, taskDone: 0.01 }, mode: 'continue',
    model: 'm', timeoutMs: 3000, hedgeMs: Infinity, maxRequests: 1, fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.plan.complete, true);
  const parts = bodies[0].contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(parts[0].inlineData.data, 'base64').toString(), 'fakejpeg');
  assert.ok(/task done 0\.01/.test(parts[1].text) && /direct URLs/.test(parts[1].text) && /at most 5/.test(parts[1].text));
  const bad = await replanTask({ key: 'k', instruction: 'x', done: [], failed: { step: { op: 'click', target: 'a' }, reason: 'target_not_found' },
    screen: null, image: null, mode: 'fail', model: 'm', timeoutMs: 600, hedgeMs: Infinity, maxRequests: 1, fetchFn });
  assert.equal(bad.ok, false);
  assert.ok(!bodies[1].contents[0].parts[0].inlineData);
});


// ── round 4: review fixes ──
const { sameRegion } = vision;
// A flat frame with one cell nudged by `delta` luma levels.
const nudged = (base, col, row, delta) => { const s = flat(base); s[row * 48 + col] = base + delta; return s; };

check('sameRegion: a few-level repaint at the click point is a change; far away it is not', () => {
  const a = flat(100);
  const atClick = nudged(100, 24, 13, 10);   // 10 levels at the screen centre
  const farAway = nudged(100, 2, 2, 10);
  assert.equal(sameFrame(a, atClick), true);               // tolerated by the full-frame check
  assert.equal(sameRegion(a, atClick, 500, 500), false);   // caught around the click
  assert.equal(sameRegion(a, farAway, 500, 500), true);
});

check('runner: toggle that repaints late is NOT treated as unchanged and is not clicked twice', async () => {
  // frame 1 (ground) and 2 (first verify) are identical; frame 3 shows the toggle repainted by a few levels
  const cap = sigCapture((n) => (n <= 2 ? flat(100) : nudged(100, 24, 13, 10)));
  let prevAsked = 0;
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    plan: planResult([{ op: 'click', target: 'dark mode toggle', done_when: 'toggle is on' }, { op: 'hotkey', keys: 'ctrl+s', done_when: '' }]),
    answerFn: (q) => {
      if (q.task_done) return { task_done: noul(0.9) };
      if (q.prev_done) { prevAsked++; return { prev_done: noul(prevAsked === 1 ? 0.1 : 0.9) }; }
      return groundAnswer();
    },
  });
  const r = await runVisionTask('turn on dark mode then save', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.equal(h.calls.inputParams.filter(p => p.action === 'click').length, 1, 'toggle clicked exactly once');
  assert.ok(prevAsked >= 2, 'the repaint was seen by a real Jev call');
  assert.ok(cap.st.n <= 5, 'the click-region check saw the repaint at once, captures ' + cap.st.n);
});

check('runner: a click is retried only after maxPolls real verify answers, even on an unchanged screen', async () => {
  const cap = sigCapture(() => flat(100));
  let prevAsked = 0;
  const atClick = [];
  const h = harness({
    cfg: { uia: false },
    overrides: {
      capture: cap.fn,
      input: async (p) => { if (p.action === 'click') atClick.push(prevAsked); return { success: true }; },
    },
    plan: planResult([{ op: 'click', target: 'checkbox', done_when: 'checkbox is checked' }, { op: 'hotkey', keys: 'ctrl+s', done_when: '' }]),
    replan: { ok: false, error: 'x', ms: 1 },
    answerFn: (q) => {
      if (q.prev_done) prevAsked++;
      return q.task_done ? { task_done: noul(0.9) } : (q.prev_done ? { prev_done: noul(0.1), ...groundAnswer() } : groundAnswer());
    },
  });
  await runVisionTask('tick the checkbox then stop', h.deps, h.cfg);
  assert.equal(atClick.length, 2, 'one click and one retry');
  assert.equal(atClick[0], 0);
  assert.ok(atClick[1] >= h.cfg.maxPolls, 'real verify answers before the retry: ' + atClick[1]);
});

check('runner: last step open_url keeps polling for the launch window before the unchanged break', async () => {
  const cap = sigCapture(() => flat(100));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    plan: planResult([{ op: 'open_url', url: 'https://example.com/', done_when: '' }]),
    answerFn: (q) => (q.task_done ? { task_done: noul(0.01) } : {}),
  });
  h.deps.openUrl = async () => ({ success: true });
  const r = await runVisionTask('open example then stop', h.deps, h.cfg);
  assert.equal(r.status, 'done_unconfirmed');
  assert.equal(h.calls.jev, 1, 'skipped polls cost no Jev call');
  assert.ok(cap.st.n >= Math.floor(h.cfg.appWaitMs / (h.cfg.pollIntervalMs + h.cfg.settleMs)) - 1, 'captures ' + cap.st.n);
  assert.ok(r.ms >= h.cfg.appWaitMs, 'waited the launch window: ' + r.ms);
});

check('runner: skip compares with the frame Jev answered, so slow drift is seen', async () => {
  // +12 levels per frame: each frame is close to the previous one but far from the first answer
  const cap = sigCapture((n) => flat(40 + n * 12));
  const h = harness({
    cfg: { uia: false },
    overrides: { capture: cap.fn },
    plan: planResult([{ op: 'open_app', app: 'notepad', done_when: 'Notepad is open' }, { op: 'hotkey', keys: 'ctrl+n' }]),
    replan: { ok: false, error: 'x', ms: 1 },
    answerFn: (q) => (q.prev_done ? { prev_done: noul(0.02) } : {}),
  });
  await runVisionTask('open notepad and make a new file', h.deps, h.cfg);
  assert.ok(h.calls.jev >= 3, 'jev calls ' + h.calls.jev);
});

check('drag: risky question is asked; recycle/trash/bin count as consequential', () => {
  const one = buildVisionRequest({ task: 't', step: { op: 'drag', target: 'file list', from: [0.1, 0.1], to: [0.9, 0.9] }, verify: null, final: false, snap: null, display, cfg });
  const two = buildVisionRequest({ task: 't', step: { op: 'drag', target_from: 'report.docx', target_to: 'Recycle Bin' }, verify: null, final: false, snap: null, display, cfg });
  assert.ok(one.questions.risky && one.flags.riskyAsked);
  assert.ok(two.questions.risky && two.flags.riskyAsked);
  assert.equal(isConsequential({ op: 'drag', target_from: 'report.docx', target_to: 'Recycle Bin' }), true);
  assert.equal(isConsequential({ op: 'click', target: 'Trash icon' }), true);
  assert.equal(isConsequential({ op: 'click', target: 'binary options menu' }), false);
});

check('runner: risky drag asks for confirmation', async () => {
  const h = harness({
    cfg: { uia: false, confirm: true }, confirmResult: false,
    plan: planResult([{ op: 'drag', target: 'file list', from: [0.1, 0.1], to: [0.9, 0.9], done_when: '' }]),
    answerFn: () => ({ visible: noul(0.9), blocked: noul(0.05), risky: noul(0.9), target: boxAns(0.1, 0.1, 0.5, 0.5, 0.9) }),
  });
  const r = await runVisionTask('move the files then stop', h.deps, h.cfg);
  assert.equal(r.status, 'refused');
  assert.equal(h.calls.input, 0);
});

check('runner: continue replan that drops an unverified last step cannot end ok-confirmed', async () => {
  const h = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'type', text: 'hello', done_when: 'hello is typed in the document' }]),
    replan: planResult([{ op: 'hotkey', keys: 'ctrl+s', done_when: '' }], 'replan'),
    answerFn: (q) => (q.task_done ? { task_done: noul(q.prev_done ? 0.01 : 0.2), prev_done: noul(0.1) } : {}),
  });
  const r = await runVisionTask('type hello in the document then save', h.deps, h.cfg);
  // An unsure final keeps asking the planner, bounded by maxReplans.
  assert.ok(h.calls.replan >= 1 && h.calls.replan <= h.cfg.maxReplans);
  assert.equal(r.status, 'unverified');
});

check('risk check: Enter in a harmless context runs without a dialog; a sending one asks', async () => {
  for (const [risky, wantConfirm] of [[0.1, 0], [0.9, 1]]) {
    const h = harness({
      cfg: { uia: false, finalVerify: false },
      plan: planResult([{ op: 'hotkey', keys: 'enter', done_when: '' }]),
      answerFn: (q) => (q.risky && !q.target ? { risky: noul(risky) } : {}),
    });
    const r = await runVisionTask('press enter to save', h.deps, h.cfg);
    assert.equal(h.calls.confirm, wantConfirm);
    assert.equal(h.calls.jev, 1);           // the one risk question
    assert.equal(r.status, 'done');
  }
});

check('risk check: shift+delete always asks, a failed risk call asks', async () => {
  const hard = harness({ cfg: { uia: false, finalVerify: false }, plan: planResult([{ op: 'hotkey', keys: 'shift+delete', done_when: '' }]) });
  await runVisionTask('delete it for good', hard.deps, hard.cfg);
  assert.equal(hard.calls.confirm, 1);
  assert.equal(hard.calls.jev, 0);
  const broken = harness({
    cfg: { uia: false, finalVerify: false },
    plan: planResult([{ op: 'hotkey', keys: 'enter', done_when: '' }]),
    overrides: { jev: async () => ({ ok: false, status: 500 }) },
  });
  await runVisionTask('press enter', broken.deps, broken.cfg);
  assert.equal(broken.calls.confirm, 1);
});

check('zoom: a small box is refined on a crop and the refined center is clicked', async () => {
  let cropRect = null;
  const h = harness({
    cfg: { uia: false, finalVerify: false },
    plan: planResult([{ op: 'click', target: 'Rectangle shape icon', done_when: '' }]),
    // first call: a 0.02-wide box at 0.33..0.35; zoom call: a slightly shifted box near the crop center
    answerFn: (q, n) => (n === 1
      ? groundAnswer({ target: boxAns(0.33, 0.09, 0.35, 0.12, 0.9) })
      : { visible: noul(0.95), target: boxAns(0.5, 0.45, 0.6, 0.55, 0.9) }),
    overrides: { captureCrop: async (rect) => { cropRect = rect; return { ok: true, jpeg: Buffer.from('crop'), width: 560, height: 560 }; } },
  });
  const r = await runVisionTask('click the rectangle tool in paint', h.deps, h.cfg);
  assert.equal(r.status, 'done');
  assert.ok(cropRect && cropRect.left < 0.33 && cropRect.right > 0.35);
  const p = h.calls.inputParams[0];
  const wantNx = (cropRect.left + 0.55 * (cropRect.right - cropRect.left)) * 1000;
  assert.ok(Math.abs(p.nx - wantNx) < 0.5, `nx ${p.nx} vs ${wantNx}`);
  assert.equal(h.calls.jev, 2);
});

check('zoom: big boxes are not refined; an unsure zoom keeps the first box', async () => {
  let crops = 0;
  const big = harness({
    cfg: { uia: false, finalVerify: false },
    plan: planResult([{ op: 'click', target: 'Canvas', done_when: '' }]),
    answerFn: () => groundAnswer(),
    overrides: { captureCrop: async () => { crops++; return { ok: false }; } },
  });
  await runVisionTask('click the canvas', big.deps, big.cfg);
  assert.equal(crops, 0);
  const unsure = harness({
    cfg: { uia: false, finalVerify: false },
    plan: planResult([{ op: 'click', target: 'tiny icon', done_when: '' }]),
    answerFn: (q, n) => (n === 1 ? groundAnswer({ target: boxAns(0.50, 0.50, 0.52, 0.52, 0.9) }) : { visible: noul(0.1), target: boxAns(0, 0, 0.1, 0.1, 0.9) }),
    overrides: { captureCrop: async () => ({ ok: true, jpeg: Buffer.from('c'), width: 560, height: 560 }) },
  });
  await runVisionTask('click the tiny icon', unsure.deps, unsure.cfg);
  assert.ok(Math.abs(unsure.calls.inputParams[0].nx - 510) < 0.5);
});

check('zoom: a refined center far from the first box keeps the first box; alt+f4 always asks', async () => {
  const h = harness({
    cfg: { uia: false, finalVerify: false },
    plan: planResult([{ op: 'click', target: 'Bold button', done_when: '' }]),
    // first box at 0.50..0.52; zoom answers the crop's far corner (a different control)
    answerFn: (q, n) => (n === 1 ? groundAnswer({ target: boxAns(0.50, 0.50, 0.52, 0.52, 0.9) }) : { visible: noul(0.95), target: boxAns(0.0, 0.0, 0.05, 0.05, 0.9) }),
    overrides: { captureCrop: async (rect) => ({ ok: true, jpeg: Buffer.from('c'), width: 560, height: 560, rect }) },
  });
  await runVisionTask('click bold', h.deps, h.cfg);
  assert.ok(Math.abs(h.calls.inputParams[0].nx - 510) < 0.5);
  const f4 = harness({ cfg: { uia: false, finalVerify: false }, plan: planResult([{ op: 'hotkey', keys: 'alt+f4', done_when: '' }]) });
  await runVisionTask('close the window', f4.deps, f4.cfg);
  assert.equal(f4.calls.confirm, 1);
  assert.equal(f4.calls.jev, 0);
});

check('final: a still splash screen does not end an open_app wait before half the window', async () => {
  let frame = 0;
  const sigs = { A: new Uint8Array(1296).fill(10), B: new Uint8Array(1296).fill(200) };
  const h = harness({
    cfg: { uia: false, appWaitMs: 8000, stableMs: 1200, maxReplans: 0 },
    plan: planResult([{ op: 'open_app', app: 'word', done_when: '' }]),
    answerFn: () => ({ task_done: noul(0.5) }),
    overrides: { capture: async () => { frame++; return { ok: true, jpeg: Buffer.from('j'), width: 1280, height: 720, ms: 1, sig: frame <= 1 ? sigs.A : sigs.B }; } },
  });
  const t0 = h.deps.now();
  await runVisionTask('open word', h.deps, h.cfg);
  assert.ok(h.deps.now() - t0 >= 4000, `ended after ${h.deps.now() - t0}ms`);
});

check('final: a loaded page that holds still ends the launch wait early', async () => {
  let frame = 0;
  const h = harness({
    cfg: { uia: false, appWaitMs: 8000, stableMs: 1200, maxReplans: 0 },
    plan: planResult([{ op: 'open_url', url: 'https://example.com', done_when: '' }]),
    answerFn: () => ({ task_done: noul(0.5) }),
    overrides: {
      openUrl: async () => ({ success: true }),
      // before the action: A; then the page loads (B) and stays B
      capture: async () => { frame++; return { ok: true, jpeg: Buffer.from('j'), width: 1280, height: 720, ms: 1, sig: frame <= 1 ? 'A' : 'B' }; },
    },
  });
  h.deps.capture = h.deps.capture; // keep
  const sigs = { A: new Uint8Array(1296).fill(10), B: new Uint8Array(1296).fill(200) };
  const cap = h.deps.capture;
  h.deps.capture = async () => { const r = await cap(); return { ...r, sig: sigs[r.sig] }; };
  const t0 = h.deps.now();
  const r = await runVisionTask('open example.com', h.deps, h.cfg);
  assert.equal(r.status, 'done_unconfirmed');
  assert.ok(h.deps.now() - t0 < 8000, `took ${h.deps.now() - t0}ms of the 8000ms window`);
});

check('runner: continue replan "complete" with an unverified last step is unverified; null task_done counts as 0', async () => {
  const h = harness({
    cfg: { uia: false },
    plan: planResult([{ op: 'type', text: 'hello', done_when: 'hello is typed' }]),
    replan: { ok: true, ms: 3, plan: { steps: [], source: 'replan', complete: true } },
    answerFn: (q) => (q.task_done ? { task_done: noul(0.01), prev_done: noul(0.1) } : {}),
  });
  assert.equal((await runVisionTask('type hello then stop', h.deps, h.cfg)).status, 'unverified');
});

check('sanitizeText: removes backticks and SCREEN_REF, collapses, caps', () => {
  assert.equal(sanitizeText(`a \`b\` ${SCREEN_REF} c`), 'a b c');
  assert.equal(sanitizeText('x'.repeat(300), 10).length, 10);
});
check('actionSignature: buckets click coords by 20, includes text/keys', () => {
  const a = actionSignature({ op: 'click' }, { nx: 501, ny: 499 });
  const b = actionSignature({ op: 'click' }, { nx: 505, ny: 495 });
  assert.equal(a, b);
  assert.notEqual(actionSignature({ op: 'click' }, { nx: 501, ny: 499 }), actionSignature({ op: 'click' }, { nx: 560, ny: 499 }));
  assert.ok(actionSignature({ op: 'type', text: 'hi' }, null).includes('hi'));
  assert.ok(actionSignature({ op: 'hotkey', keys: 'ctrl+l' }, null).includes('ctrl+l'));
});
check('describeStep: readable, sanitized, no em dash', () => {
  const d = describeStep({ op: 'click', target: 'Send' });
  assert.equal(d, 'click "Send"');
  assert.ok(!d.includes('\u2014'));
});

(async () => {
  let passCount = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passCount++;
      console.log(`  ok - ${name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL - ${name}`);
      console.error(`    ${(e && e.message) || e}`);
    }
  }
  if (failed) {
    console.error(`\n${passCount} passed, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`\n${passCount} checks passed.`);
  console.log('ALL PASS');
})();
