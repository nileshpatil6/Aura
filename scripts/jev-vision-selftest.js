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
    cfg: { uia: false },
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
