// Pure functions for Jev Vision mode: config parsing, plan validation, request
// building, answer interpretation and coordinate mapping. No I/O, no electron,
// no fetch. Unit-testable under plain node (scripts/jev-vision-selftest.js).
// Contract: docs/jev-vision/CONTRACT.md sections 2.1-2.7 and 3.1.

const { describeElement } = require('./jev-step');

// A single screenshot is referenced from the state under this key. T4: it must
// appear exactly once in the request JSON, so every other string is sanitized.
const SCREEN_REF = 'aura_screen_capture_img';

const IMAGE_LIMITS = Object.freeze({
  minSide: 280,
  maxSide: 1568,
  minPixels: 78400,     // 280 * 280
  maxPixels: 2458624,   // 1568 * 1568
});

const DEFAULT_VISION_CFG = Object.freeze({
  model: 'jev-1.14.0',              // AURA_JEV_VISION_MODEL
  transport: 'multipart',           // AURA_JV_TRANSPORT: 'multipart'|'json'
  imgMaxSide: 1280,                 // AURA_JV_IMG_MAX, clamped 280..1568
  jpegQuality: 70,                  // AURA_JV_JPEG_Q, clamped 30..95
  jevTimeoutMs: 6000,               // AURA_JV_TIMEOUT_MS (image calls)
  settleMs: 150,                    // AURA_JV_SETTLE_MS, wait after an action before the next capture
  pollIntervalMs: 300,              // AURA_JV_POLL_MS, wait between verify polls
  appWaitMs: 8000,                  // AURA_JV_APP_WAIT_MS, max verify-poll window after open_app
  maxPolls: 4,                      // AURA_JV_MAX_POLLS, verify/ground polls per step (non open_app)
  uia: true,                        // AURA_JV_UIA ('0' off)
  uiaTimeoutMs: 1500,               // AURA_JV_UIA_TIMEOUT_MS (host kill on timeout, see trap T9)
  uiaGraceMs: 250,                  // wait for UIA after capture finished before going without it
  uiaMaxElements: 80,               // AURA_JV_UIA_MAX
  maxActions: 25,                   // AURA_JV_MAX_ACTIONS
  maxJevCalls: 40,                  // AURA_JV_MAX_CALLS
  maxMs: 120000,                    // AURA_JV_MAX_MS
  maxReplans: 5,                    // AURA_JV_MAX_REPLANS (failure replans and "continue" replans share it)
  sameActionLimit: 3,               // identical action signature executed this many times -> stop/replan
  confirm: true,                    // AURA_JV_CONFIRM ('0' = refuse consequential instead of asking)
  finalVerify: true,                // AURA_JV_FINAL_VERIFY ('0' skips the task_done call)
  finalPolls: 2,                    // AURA_JV_FINAL_POLLS, max task_done calls while the screen keeps changing
  frameSkip: true,                  // AURA_JV_FRAME_SKIP ('0' = always call Jev, even on an unchanged screen)
  plannerModel: 'gemini-3.6-flash', // AURA_PLANNER_MODEL
  plannerTimeoutMs: 12000,          // AURA_PLANNER_TIMEOUT_MS, whole planner budget incl. hedges
  plannerHedgeMs: 2500,             // AURA_PLANNER_HEDGE_MS, start a parallel identical request after this
  plannerMaxRequests: 3,            // AURA_PLANNER_MAX_REQUESTS, hedges plus replacements per plan
  plannerThinking: 'low',           // AURA_PLANNER_THINKING: minimal|low|medium|high
  plannerMaxTokens: 2048,           // AURA_PLANNER_MAX_TOKENS, 256..8192
  fastCapture: true,                // AURA_JV_FAST_CAPTURE ('0' = always use desktopCapturer thumbnails)
  warmup: true,                     // AURA_JV_WARMUP ('0' = no connection/capture/app-index prewarm)
  zoom: true,                       // AURA_JV_ZOOM ('0' = click small targets straight from the first box)
  zoomMaxW: 0.06,                   // AURA_JV_ZOOM_MAX_W, boxes narrower than this (fraction of width) are refined
  zoomMaxH: 0.08,                   // AURA_JV_ZOOM_MAX_H, and shorter than this (fraction of height)
  stableMs: 1200,                   // AURA_JV_STABLE_MS, a launch that changed the screen and then held still this long has loaded
  riskCheck: true,                  // AURA_JV_RISK_CHECK ('0' = always confirm enter-like keys and type+submit)
  thresholds: Object.freeze({
    prevDone: 0.6, taskDone: 0.7, visible: 0.5, boxConf: 0.3, boxMaxArea: 0.25,
    element: 0.7, risky: 0.5, blocked: 0.8,
  }),
});

const CLICK_OPS = ['click', 'double_click', 'right_click'];
const HOTKEY_RE = /^[a-z0-9]+(\+[a-z0-9]+)*$/i;
const CONSEQUENTIAL_RE = /\b(send|delete|remove|erase|recycle|trash|bin|purchase|buy|order|pay|checkout|submit|publish|post|tweet|transfer|uninstall|format|sign ?out|log ?out|shut ?down|restart)\b/i;
const STEP_SOURCES = ['trivial', 'gemini', 'replan'];
const MAX_STEPS = 12;

// Numeric env reader. Unparseable values fall back to the default; `clamp`
// squeezes into range instead, otherwise an out-of-range value is rejected.
function envNumber(env, name, def, opts = {}) {
  const raw = env ? env[name] : undefined;
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  if (opts.clamp) {
    const lo = opts.min !== undefined ? opts.min : -Infinity;
    const hi = opts.max !== undefined ? opts.max : Infinity;
    return Math.round(Math.min(hi, Math.max(lo, n)));
  }
  if (opts.min !== undefined && n < opts.min) return def;
  if (opts.max !== undefined && n > opts.max) return def;
  return opts.integer ? Math.round(n) : n;
}

function envString(env, name, def) {
  const raw = env ? env[name] : undefined;
  if (typeof raw !== 'string') return def;
  const v = raw.trim();
  return v || def;
}

function envBool(env, name, def) {
  const raw = env ? env[name] : undefined;
  if (raw === undefined || raw === null || raw === '') return def;
  return raw !== '0';
}

/**
 * Parse a VisionConfig out of an env object. Never returns NaN or unknown
 * values; garbage falls back to the frozen defaults.
 * @param {Record<string,string>} env
 * @returns {typeof DEFAULT_VISION_CFG}
 */
function readVisionConfig(env = {}) {
  const d = DEFAULT_VISION_CFG;
  const transport = envString(env, 'AURA_JV_TRANSPORT', d.transport);
  return {
    model: envString(env, 'AURA_JEV_VISION_MODEL', d.model),
    transport: transport === 'json' ? 'json' : 'multipart',
    imgMaxSide: envNumber(env, 'AURA_JV_IMG_MAX', d.imgMaxSide, { clamp: true, min: IMAGE_LIMITS.minSide, max: IMAGE_LIMITS.maxSide }),
    jpegQuality: envNumber(env, 'AURA_JV_JPEG_Q', d.jpegQuality, { clamp: true, min: 30, max: 95 }),
    jevTimeoutMs: envNumber(env, 'AURA_JV_TIMEOUT_MS', d.jevTimeoutMs, { min: 1, integer: true }),
    settleMs: envNumber(env, 'AURA_JV_SETTLE_MS', d.settleMs, { min: 0, integer: true }),
    pollIntervalMs: envNumber(env, 'AURA_JV_POLL_MS', d.pollIntervalMs, { min: 0, integer: true }),
    appWaitMs: envNumber(env, 'AURA_JV_APP_WAIT_MS', d.appWaitMs, { min: 0, integer: true }),
    maxPolls: envNumber(env, 'AURA_JV_MAX_POLLS', d.maxPolls, { min: 0, integer: true }),
    uia: envBool(env, 'AURA_JV_UIA', d.uia),
    uiaTimeoutMs: envNumber(env, 'AURA_JV_UIA_TIMEOUT_MS', d.uiaTimeoutMs, { min: 1, integer: true }),
    uiaGraceMs: envNumber(env, 'AURA_JV_GRACE_MS', d.uiaGraceMs, { min: 0, integer: true }),
    uiaMaxElements: envNumber(env, 'AURA_JV_UIA_MAX', d.uiaMaxElements, { min: 0, integer: true }),
    maxActions: envNumber(env, 'AURA_JV_MAX_ACTIONS', d.maxActions, { min: 1, integer: true }),
    maxJevCalls: envNumber(env, 'AURA_JV_MAX_CALLS', d.maxJevCalls, { min: 1, integer: true }),
    // Clamped to 140 s: the renderer pill watchdog gives up at 150 s.
    maxMs: Math.min(140000, envNumber(env, 'AURA_JV_MAX_MS', d.maxMs, { min: 1, integer: true })),
    maxReplans: envNumber(env, 'AURA_JV_MAX_REPLANS', d.maxReplans, { min: 0, integer: true }),
    sameActionLimit: envNumber(env, 'AURA_JV_SAME_ACTION_LIMIT', d.sameActionLimit, { min: 1, integer: true }),
    confirm: envBool(env, 'AURA_JV_CONFIRM', d.confirm),
    finalVerify: envBool(env, 'AURA_JV_FINAL_VERIFY', d.finalVerify),
    finalPolls: envNumber(env, 'AURA_JV_FINAL_POLLS', d.finalPolls, { clamp: true, min: 1, max: 5 }),
    frameSkip: envBool(env, 'AURA_JV_FRAME_SKIP', d.frameSkip),
    plannerModel: envString(env, 'AURA_PLANNER_MODEL', d.plannerModel),
    plannerTimeoutMs: envNumber(env, 'AURA_PLANNER_TIMEOUT_MS', d.plannerTimeoutMs, { min: 1, integer: true }),
    plannerHedgeMs: envNumber(env, 'AURA_PLANNER_HEDGE_MS', d.plannerHedgeMs, { min: 0, integer: true }),
    plannerMaxRequests: envNumber(env, 'AURA_PLANNER_MAX_REQUESTS', d.plannerMaxRequests, { clamp: true, min: 1, max: 3 }),
    plannerThinking: ['minimal', 'low', 'medium', 'high'].indexOf(envString(env, 'AURA_PLANNER_THINKING', d.plannerThinking)) !== -1
      ? envString(env, 'AURA_PLANNER_THINKING', d.plannerThinking) : d.plannerThinking,
    plannerMaxTokens: envNumber(env, 'AURA_PLANNER_MAX_TOKENS', d.plannerMaxTokens, { clamp: true, min: 256, max: 8192 }),
    fastCapture: envBool(env, 'AURA_JV_FAST_CAPTURE', d.fastCapture),
    warmup: envBool(env, 'AURA_JV_WARMUP', d.warmup),
    zoom: envBool(env, 'AURA_JV_ZOOM', d.zoom),
    zoomMaxW: envNumber(env, 'AURA_JV_ZOOM_MAX_W', d.zoomMaxW, { min: 0, max: 1 }),
    zoomMaxH: envNumber(env, 'AURA_JV_ZOOM_MAX_H', d.zoomMaxH, { min: 0, max: 1 }),
    stableMs: envNumber(env, 'AURA_JV_STABLE_MS', d.stableMs, { min: 0, integer: true }),
    riskCheck: envBool(env, 'AURA_JV_RISK_CHECK', d.riskCheck),
    thresholds: d.thresholds,
  };
}

/** True when every side is in 280..1568 and the pixel count is in range. */
function validateImageDims(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h)) return false;
  if (w < IMAGE_LIMITS.minSide || w > IMAGE_LIMITS.maxSide) return false;
  if (h < IMAGE_LIMITS.minSide || h > IMAGE_LIMITS.maxSide) return false;
  const px = w * h;
  return px >= IMAGE_LIMITS.minPixels && px <= IMAGE_LIMITS.maxPixels;
}

/**
 * Fit a source frame inside the API limits, preserving aspect. The long side is
 * never upscaled unless the short side would fall below minSide; if the result
 * still violates the limits the frame is rejected (null), never resized.
 * @returns {{width:number,height:number}|null}
 */
function fitImageSize(srcW, srcH, maxSide) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) return null;
  const cap = Math.min(
    Number.isFinite(maxSide) ? maxSide : IMAGE_LIMITS.maxSide,
    IMAGE_LIMITS.maxSide,
  );
  const longest = Math.max(srcW, srcH);
  const short = Math.min(srcW, srcH);

  let scale = Math.min(1, cap / longest);
  if (short * scale < IMAGE_LIMITS.minSide) scale = IMAGE_LIMITS.minSide / short;

  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  if (!validateImageDims(width, height)) return null;
  return { width, height };
}

function collapse(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * Make a string safe to embed in state/questions. Removes backticks and every
 * SCREEN_REF occurrence (T4), collapses whitespace, then caps length.
 */
function sanitizeText(s, maxLen = 200) {
  let out = String(s == null ? '' : s);
  out = out.split('`').join('');
  out = out.split(SCREEN_REF).join('');
  out = collapse(out);
  return out.slice(0, maxLen);
}

// Trim + collapse newlines for planner strings. `text` keeps backticks (it is
// typed verbatim), target/done_when get them stripped.
function cleanString(v) {
  return collapse(v);
}

function cleanTarget(v) {
  return collapse(v).split('`').join('');
}

function isClickOp(op) {
  return CLICK_OPS.indexOf(op) !== -1;
}

const MAX_URL_LEN = 2000;

// [x, y] fractions inside a box, each clamped to 0..1; null when not two finite numbers.
function fractionPair(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = Number(v[0]);
  const b = Number(v[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const c = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  return [c(a), c(b)];
}

/** Normalized href for an http(s) URL, or null. Anything else (file:, javascript:, ...) is rejected. */
function parseHttpUrl(raw) {
  const text = collapse(raw);
  if (!text || text.length > MAX_URL_LEN) return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return u.href;
}

/**
 * Validate a raw planner plan. Nothing is dropped silently: any invalid step
 * fails the whole plan with the step index in the error. Steps past 12 are
 * truncated (allowed).
 * @returns {{ok:true, plan:object}|{ok:false, error:string}}
 */
function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) {
    return { ok: false, error: 'plan: steps array required' };
  }
  const source = STEP_SOURCES.indexOf(raw.source) !== -1 ? raw.source : 'gemini';
  const steps = [];

  for (let idx = 0; idx < raw.steps.length && steps.length < MAX_STEPS; idx++) {
    const rawStep = raw.steps[idx];
    const at = `step ${idx + 1}`;
    if (!rawStep || typeof rawStep !== 'object') return { ok: false, error: `${at}: not an object` };

    const op = typeof rawStep.op === 'string' ? rawStep.op : '';
    if (['click', 'double_click', 'right_click', 'drag', 'type', 'hotkey', 'scroll', 'open_app', 'open_url', 'wait'].indexOf(op) === -1) {
      return { ok: false, error: `${at}: bad op "${op}"` };
    }

    const step = { op };
    if (rawStep.target !== undefined) step.target = cleanTarget(rawStep.target);
    if (rawStep.done_when !== undefined) step.done_when = cleanTarget(rawStep.done_when);
    // open_url is never risky: the URL is only opened, nothing is submitted.
    if (rawStep.risky !== undefined && op !== 'open_url') step.risky = rawStep.risky === true;

    if (isClickOp(op) && !step.target) return { ok: false, error: `${at}: target required for ${op}` };

    if (op === 'drag') {
      const tf = rawStep.target_from !== undefined ? cleanTarget(rawStep.target_from) : '';
      const tt = rawStep.target_to !== undefined ? cleanTarget(rawStep.target_to) : '';
      if (tf || tt) {
        if (!tf || !tt) return { ok: false, error: `${at}: drag needs both target_from and target_to` };
        delete step.target;
        step.target_from = tf;
        step.target_to = tt;
      } else {
        if (!step.target) return { ok: false, error: `${at}: drag needs a target (or target_from and target_to)` };
        const noPoints = (rawStep.from === undefined || (Array.isArray(rawStep.from) && !rawStep.from.length)) &&
          (rawStep.to === undefined || (Array.isArray(rawStep.to) && !rawStep.to.length));
        // No points at all means "drag across the area" (a shape tool: corner to corner).
        const from = noPoints ? [0.25, 0.25] : fractionPair(rawStep.from);
        const to = noPoints ? [0.75, 0.75] : fractionPair(rawStep.to);
        if (!from || !to) return { ok: false, error: `${at}: drag needs from and to as [x,y] fractions` };
        step.from = from;
        step.to = to;
      }
    } else if (op === 'type') {
      const text = cleanString(rawStep.text);
      if (text.length < 1 || text.length > 500) return { ok: false, error: `${at}: text must be 1..500 chars` };
      step.text = text;
      if (rawStep.submit !== undefined) step.submit = rawStep.submit === true;
      if (rawStep.clear !== undefined) step.clear = rawStep.clear === true;
    } else if (op === 'hotkey') {
      const keys = cleanString(rawStep.keys);
      if (!HOTKEY_RE.test(keys) || keys.length > 40) return { ok: false, error: `${at}: bad keys "${keys}"` };
      step.keys = keys;
    } else if (op === 'scroll') {
      const dir = rawStep.direction === 'up' ? 'up' : 'down';
      step.direction = dir;
      let amount = 5;
      if (rawStep.amount !== undefined) {
        const n = Number(rawStep.amount);
        amount = Number.isFinite(n) ? Math.min(15, Math.max(1, Math.round(n))) : 5;
      }
      step.amount = amount;
    } else if (op === 'open_url') {
      const url = parseHttpUrl(rawStep.url);
      if (!url) return { ok: false, error: `${at}: open_url needs an http or https url` };
      step.url = url;
    } else if (op === 'open_app') {
      const app = cleanString(rawStep.app);
      if (!app) return { ok: false, error: `${at}: app required for open_app` };
      step.app = app;
    } else if (op === 'wait') {
      let seconds = 1;
      if (rawStep.seconds !== undefined) {
        const n = Number(rawStep.seconds);
        seconds = Number.isFinite(n) ? Math.min(5, Math.max(0.2, n)) : 1;
      }
      step.seconds = seconds;
    }

    if (step.done_when !== undefined && step.done_when.length > 200) {
      step.done_when = step.done_when.slice(0, 200);
    }
    steps.push(step);
  }

  if (steps.length < 1) return { ok: false, error: 'plan: at least one step required' };
  return { ok: true, plan: { steps, source } };
}

// Strip quoted segments before looking for clause separators, so an app name
// like "Bob and Alice" is not mistaken for two clauses.
function isSingleClause(text) {
  const stripped = String(text).replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|`[^`]*`/g, ' ');
  if (/[,;&]/.test(stripped)) return false;
  if (/\b(and|then|after)\b/i.test(stripped)) return false;
  return true;
}

function normalizeKeys(text) {
  return String(text)
    .replace(/\bplus\b/gi, '+')
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const NAMED_KEYS = new Set(['ctrl', 'control', 'shift', 'alt', 'win', 'windows', 'enter', 'return', 'esc', 'escape', 'tab', 'space',
  'backspace', 'delete', 'del', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'insert',
  'printscreen', 'capslock', 'menu', 'plus', 'minus']);

// Every token is a single character, a named key or F1..F24.
function isKnownKeyCombo(keys) {
  const parts = String(keys).split('+');
  return parts.length > 0 && parts.every(p => p.length === 1 || NAMED_KEYS.has(p) || /^f([1-9]|1\d|2[0-4])$/.test(p));
}

/**
 * Cheap pre-router for single-clause commands. Returns a Plan(source 'trivial')
 * or null when the command needs the Gemini planner. Anything with unknown
 * trailing words goes to the planner instead of being guessed: "open X" only
 * shortcuts when `opts.appKnown(name)` says the app resolves (when no checker
 * is given any name is accepted), a click target is at most 8 words, and press
 * accepts only real key names.
 * @param {string} text
 * @param {{appKnown?: (name:string)=>boolean}} [opts]
 * @returns {{steps:object[],source:string}|null}
 */
function parseTrivialCommand(text, opts = {}) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || !isSingleClause(raw)) return null;

  let m = /^(?:open|launch|start)\s+(.+)$/i.exec(raw);
  if (m) {
    const app = cleanString(m[1]);
    if (!app) return null;
    if (typeof opts.appKnown === 'function') {
      let known = false;
      try { known = !!opts.appKnown(app); } catch { known = false; }
      if (!known) return null;
    }
    return { steps: [{ op: 'open_app', app, done_when: '' }], source: 'trivial' };
  }

  m = /^(double[- ]click|right[- ]click|click|tap)\s+(?:on\s+)?(?:the\s+)?(.+)$/i.exec(raw);
  if (m) {
    const verb = m[1].toLowerCase().replace(/\s+/g, '-');
    const op = verb === 'double-click' ? 'double_click' : verb === 'right-click' ? 'right_click' : 'click';
    const target = cleanTarget(m[2]);
    if (!target || target.split(' ').length > 8) return null;
    return { steps: [{ op, target, done_when: '' }], source: 'trivial' };
  }

  m = /^press\s+(.+)$/i.exec(raw);
  if (m) {
    const keys = normalizeKeys(m[1].replace(/\s+(keys?|button)$/i, ''));
    if (HOTKEY_RE.test(keys) && keys.length <= 40 && isKnownKeyCombo(keys)) {
      return { steps: [{ op: 'hotkey', keys, done_when: '' }], source: 'trivial' };
    }
    return null;
  }

  m = /^type\s+"([^"]*)"$/i.exec(raw) || /^type\s+“([^”]*)”$/.exec(raw);
  if (m) {
    const lit = cleanString(m[1]);
    if (lit.length < 1 || lit.length > 500) return null;
    return { steps: [{ op: 'type', text: lit, done_when: '' }], source: 'trivial' };
  }

  m = /^scroll\s+(up|down)$/i.exec(raw);
  if (m) {
    return { steps: [{ op: 'scroll', direction: m[1].toLowerCase(), amount: 5, done_when: '' }], source: 'trivial' };
  }

  return null;
}

/**
 * True when the step is likely hard to undo. `risky` always wins; a `type`
 * without `submit` is never consequential.
 */
function isConsequential(step) {
  if (step.risky === true) return true;
  if (step.op === 'type' && step.submit !== true) return false;
  const hay = [step.target, step.target_from, step.target_to, step.text, step.app].filter(Boolean).join(' ');
  return CONSEQUENTIAL_RE.test(hay);
}

/**
 * A hotkey that MAY confirm or destroy: ends in enter/delete/del, or is
 * ctrl+enter, alt+f4, shift+delete. Whether it actually does depends on the
 * screen (Enter in a Save dialog is harmless, Enter in a chat sends), so the
 * runner asks Jev before confirming; see needsRiskCheck.
 */
function isRiskyHotkey(keys) {
  const parts = String(keys || '').toLowerCase().split('+').filter(Boolean);
  if (!parts.length) return false;
  const last = parts[parts.length - 1];
  // automation.js maps return and kp_enter to {ENTER} too.
  if (['enter', 'return', 'kp_enter', 'delete', 'del'].includes(last)) return true;
  const norm = parts.join('+');
  return norm === 'ctrl+enter' || norm === 'alt+f4' || norm === 'shift+delete';
}

/** Can destroy work whatever the screen shows (permanent delete, close discarding edits): always confirmed. */
function isHardRiskyHotkey(keys) {
  const norm = String(keys || '').toLowerCase().split('+').filter(Boolean).join('+');
  return norm === 'shift+delete' || norm === 'shift+del' || norm === 'alt+f4';
}

/**
 * Steps whose effect depends on what is focused: an enter-like key, or typing
 * with submit. The runner asks Jev about the current screen before deciding
 * whether to confirm, instead of confirming every Enter.
 */
function needsRiskCheck(step) {
  if (!step) return false;
  if (step.op === 'hotkey') return isRiskyHotkey(step.keys) && !isHardRiskyHotkey(step.keys);
  return step.op === 'type' && step.submit === true;
}

/** One noul on the current screen: would this key press / submit do something hard to undo? */
function buildRiskCheckRequest(task, step) {
  const what = step.op === 'type'
    ? `typing "${sanitizeText(step.text, 80)}" and pressing Enter`
    : `pressing ${sanitizeText(step.keys, 40)}`;
  return {
    state: { screenshot: SCREEN_REF, task: sanitizeText(task, 500) },
    questions: {
      risky: {
        type: 'noul',
        instructions: `The next action is ${what} in the window that has focus in \`screenshot\`. ` +
          'Would that send a message or email, post or publish something, place an order or pay, ' +
          'delete files or data, overwrite or replace an existing file, or discard unsaved changes? ' +
          'Saving a NEW file, confirming an open dialog, running a search, adding a new line or moving between fields is NOT risky.',
      },
    },
    flags: { verify: false, ground: false, final: false, riskyAsked: true },
  };
}

/**
 * Small boxes (toolbar icons) are where a 1280px screenshot is least precise.
 * Returns the crop to re-ask Jev on, as fractions of the display, or null when
 * the box is big enough. The crop is about 8x the box, square in pixels, kept on screen.
 */
function zoomRectFor(box, display, cfg) {
  if (!box) return null;
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  if (!(bw > 0 && bh > 0) || bw >= cfg.zoomMaxW || bh >= cfg.zoomMaxH) return null;
  const W = display.physW;
  const H = display.physH;
  const side = Math.min(0.5 * H, Math.max(0.18 * H, 8 * Math.max(bw * W, bh * H)));
  const hw = side / 2 / W;
  const hh = side / 2 / H;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const left = Math.min(Math.max(0, cx - hw), 1 - 2 * hw);
  const top = Math.min(Math.max(0, cy - hh), 1 - 2 * hh);
  return { left, top, right: left + 2 * hw, bottom: top + 2 * hh };
}

/** Visible + box on the zoomed crop, worded like the full-screen ground question. */
function buildZoomRequest(step) {
  const target = sanitizeText(step.target, 200);
  return {
    state: { screenshot: SCREEN_REF },
    questions: {
      visible: { type: 'noul', instructions: `Is ${target} visible in \`screenshot\`?` },
      target: { type: 'box', instructions: `Locate ${target} in \`screenshot\`. Box only that control, tightly.` },
    },
  };
}

/** A box answered on the crop, mapped back to whole-display fractions. */
function mapZoomBox(rect, box) {
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  return {
    left: rect.left + box.left * w,
    right: rect.left + box.right * w,
    top: rect.top + box.top * h,
    bottom: rect.top + box.bottom * h,
    confidence: box.confidence,
  };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url || ''); }
}

/** Short human description used in progress events, state.step and logs. */
function describeStep(step) {
  if (!step || !step.op) return '';
  const t = step.target ? sanitizeText(step.target, 80) : '';
  switch (step.op) {
    case 'click': return `click "${t}"`;
    case 'double_click': return `double-click "${t}"`;
    case 'drag':
      if (step.target_from) return `drag "${sanitizeText(step.target_from, 60)}" to "${sanitizeText(step.target_to, 60)}"`;
      return `drag on "${t}"`;
    case 'right_click': return `right-click "${t}"`;
    case 'type': {
      const txt = sanitizeText(step.text, 40);
      return t ? `click "${t}" then type "${txt}"` : `type "${txt}"`;
    }
    case 'hotkey': return `press ${sanitizeText(step.keys, 40)}`;
    case 'scroll': return `scroll ${step.direction || 'down'}`;
    case 'open_app': return `open ${sanitizeText(step.app, 80)}`;
    case 'open_url': return `open ${sanitizeText(hostOf(step.url), 80)}`;
    case 'wait': return `wait ${step.seconds}s`;
    default: return step.op;
  }
}

function rectCenterInside(rect, display) {
  if (!Array.isArray(rect) || rect.length < 4) return false;
  const [x, y, w, h] = rect;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return false;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return cx >= display.physX && cx < display.physX + display.physW &&
    cy >= display.physY && cy < display.physY + display.physH;
}

// Eligible = name or aid non-empty AND center inside the primary physical rect.
// First `maxN`, but the focused element is kept even beyond the cap.
function eligibleElements(snap, display, maxN) {
  if (!snap || !Array.isArray(snap.elements) || maxN <= 0) return [];
  const eligible = snap.elements.filter(el => (el.name || el.aid) && rectCenterInside(el.rect, display));
  const kept = eligible.slice(0, maxN);
  const focusedId = snap.focused && snap.focused.id;
  if (focusedId && !kept.some(e => e.id === focusedId)) {
    const f = eligible.find(e => e.id === focusedId);
    if (f) {
      if (kept.length >= maxN) kept[kept.length - 1] = f;
      else kept.push(f);
    }
  }
  return kept;
}

/** A step needs a target grounded when it clicks, or types/scolls into a named field. */
function stepNeedsGround(step) {
  if (!step) return false;
  if (isClickOp(step.op) || step.op === 'drag') return true;
  if ((step.op === 'type' || step.op === 'scroll') && !!step.target) return true;
  return false;
}

/**
 * Build the single Jev image request for the current iteration.
 * @param {{task:string, step:object|null, verify:object|null, final:boolean,
 *          snap:object|null, display:object, cfg:object}} ctx
 */
function buildVisionRequest(ctx) {
  const { task, step, verify, final, snap, display, cfg } = ctx;
  const questions = {};
  const elementMap = {};
  const state = { screenshot: SCREEN_REF, task: sanitizeText(task, 500) };

  const verifyQ = !!(verify && verify.done_when);
  const ground = stepNeedsGround(step);
  const clickFamily = !!(step && isClickOp(step.op));

  if (ground) state.step = describeStep(step);

  if (verifyQ) {
    questions.prev_done = {
      type: 'noul',
      instructions: `Looking at \`screenshot\`, is this true: ${sanitizeText(verify.done_when, 200)}`,
    };
  }

  const isDrag = !!(step && step.op === 'drag');
  const twoBox = isDrag && !!step.target_from;
  let dragSpec = null;

  if (ground && isDrag) {
    // One Jev call locates everything the drag needs: either one area (the
    // from/to fractions are applied inside its box) or two boxes.
    if (twoBox) {
      const a = sanitizeText(step.target_from, 200);
      const b = sanitizeText(step.target_to, 200);
      questions.visible = {
        type: 'noul',
        instructions: `Are both ${a} and ${b} visible and not covered in \`screenshot\`?`,
      };
      questions.target = { type: 'box', instructions: `Locate ${a} in \`screenshot\`. Box only that control, tightly.` };
      questions.target_to = { type: 'box', instructions: `Locate ${b} in \`screenshot\`. Box only that control, tightly.` };
    } else {
      const target = sanitizeText(step.target, 200);
      questions.visible = {
        type: 'noul',
        instructions: `Is ${target} visible and not covered in \`screenshot\`?`,
      };
      questions.target = { type: 'box', instructions: `Locate ${target} in \`screenshot\`. Box the whole area.` };
      dragSpec = { from: step.from, to: step.to };
    }
    questions.blocked = {
      type: 'noul',
      instructions: 'Is an unexpected dialog, error, sign-in or permission prompt, or loading screen covering `screenshot`?',
    };
    const dragWhat = twoBox ? `${sanitizeText(step.target_from, 120)} onto ${sanitizeText(step.target_to, 120)}` : sanitizeText(step.target, 200);
    questions.risky = {
      type: 'noul',
      instructions: `Would dragging ${dragWhat} delete, send, buy, publish, move to the recycle bin or do something hard to undo?`,
    };
  } else if (ground) {
    const target = sanitizeText(step.target, 200);
    questions.visible = {
      type: 'noul',
      instructions: `Is ${target} visible and not covered in \`screenshot\`?`,
    };
    questions.target = {
      type: 'box',
      instructions: `Locate ${target} in \`screenshot\`. Box only that control, tightly.`,
    };
    const eligible = eligibleElements(snap, display, cfg.uiaMaxElements);
    if (eligible.length >= 1) {
      const criteria = {};
      for (const el of eligible) {
        criteria[el.id] = 'click ' + sanitizeText(describeElement(el), 200);
        elementMap[el.id] = el;
      }
      criteria.none = `none of these is ${target}`;
      questions.element = {
        type: 'choice',
        instructions: `Which listed element is ${target} as seen in \`screenshot\`?`,
        criteria,
      };
    }
    questions.blocked = {
      type: 'noul',
      instructions: 'Is an unexpected dialog, error, sign-in or permission prompt, or loading screen covering `screenshot`?',
    };
    if (clickFamily) {
      questions.risky = {
        type: 'noul',
        instructions: `Would clicking ${target} send, delete, buy, pay, publish or do something hard to undo?`,
      };
    } else if (step.op === 'type' && step.submit === true) {
      questions.risky = {
        type: 'noul',
        instructions: `Would typing into ${target} and pressing Enter send a message or email, post, order, pay or delete something? ` +
          'Running a search or saving a file is NOT risky.',
      };
    }
  }

  if (final) {
    // Lenient on purpose: the question names the last action and what it should
    // have produced, so a finished task is not judged against the bare instruction.
    const last = ctx.lastStep;
    let tail = '';
    if (last) {
      tail = ` The last action was: ${sanitizeText(describeStep(last), 120)}.`;
      if (last.done_when) tail += ` It should have produced: ${sanitizeText(last.done_when, 160)}.`;
      tail += ' Answer yes if the screen shows the result of the requested action.';
    }
    questions.task_done = {
      type: 'noul',
      instructions: `Judging only by \`screenshot\`, has the request \`${state.task}\` been carried out?${tail}`,
    };
  }

  if (Object.keys(questions).length === 0) {
    // Callers only build a request when there is something to ask (2.4).
    throw new Error('buildVisionRequest: no questions to ask');
  }

  return {
    state,
    questions,
    elementMap,
    ref: SCREEN_REF,
    flags: { verify: verifyQ, ground, final: !!final, riskyAsked: !!questions.risky, drag: isDrag, drag2: twoBox },
    dragSpec,
  };
}

/** Center of a normalized [0,1] box as nx/ny in 0..999 (not rounded). */
function boxCenterToNormalized(box) {
  const nx = ((box.left + box.right) / 2) * 1000;
  const ny = ((box.top + box.bottom) / 2) * 1000;
  return { nx: Math.min(999, Math.max(0, nx)), ny: Math.min(999, Math.max(0, ny)) };
}

/** Element center in normalized display space; null when outside [0,1000). */
function elementCenterToNormalized(el, display) {
  if (!el || !Array.isArray(el.rect)) return null;
  const [x, y, w, h] = el.rect;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const nx = ((x + w / 2 - display.physX) / display.physW) * 1000;
  const ny = ((y + h / 2 - display.physY) / display.physH) * 1000;
  if (!(nx >= 0 && nx < 1000 && ny >= 0 && ny < 1000)) return null;
  return { nx, ny };
}

/** Normalized point -> physical pixels. Logging / probe only. */
function normalizedToPhysical(point, display) {
  return {
    x: Math.round(display.physX + (point.nx / 1000) * display.physW),
    y: Math.round(display.physY + (point.ny / 1000) * display.physH),
  };
}

function readNoul(answers, key, asked) {
  if (!asked) return null;
  const a = answers && answers[key];
  if (!a || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul)) return { bad: true };
  return a.noul;
}

function parseBoxAnswer(answers, asked, cfg, key = 'target', maxArea = cfg.thresholds.boxMaxArea) {
  if (!asked) return { box: null, boxReject: null };
  const a = answers && answers[key];
  if (!a || a.type !== 'box' || !a.box) return { box: null, boxReject: 'invalid' };
  const { top, bottom, left, right } = a.box;
  const vals = [top, bottom, left, right];
  if (!vals.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return { box: null, boxReject: 'invalid' };
  if (!(left < right) || !(top < bottom)) return { box: null, boxReject: 'invalid' };
  if (typeof a.confidence !== 'number' || !Number.isFinite(a.confidence)) return { box: null, boxReject: 'invalid' };

  const box = { left, top, right, bottom, confidence: a.confidence };
  const area = (right - left) * (bottom - top);
  if (area > maxArea) return { box, boxReject: 'too_large' };
  if (a.confidence < cfg.thresholds.boxConf) return { box, boxReject: 'low_conf' };
  return { box, boxReject: null };
}

function parseElementAnswer(answers, built, cfg) {
  if (!built.flags.ground || !built.questions.element) return null;
  const a = answers && answers.element;
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string' ||
      typeof a.confidence !== 'number' || !Number.isFinite(a.confidence)) {
    return { bad: true };
  }
  if (a.choice === 'none') return null;
  if (!(a.choice in built.elementMap)) return null;
  if (a.confidence < cfg.thresholds.element) return null;
  return { id: a.choice, conf: a.confidence };
}

// Element center (normalized) inside the box expanded by 25% of its size.
function insideExpandedBox(point, box) {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const l = box.left - 0.25 * w;
  const r = box.right + 0.25 * w;
  const t = box.top - 0.25 * h;
  const b = box.bottom + 0.25 * h;
  const nx = point.nx / 1000;
  const ny = point.ny / 1000;
  return nx >= l && nx <= r && ny >= t && ny <= b;
}

/**
 * Interpret Jev answers against what was asked. ok:false only when a question
 * that was ASKED has the wrong shape.
 * @param {object} answers JevResult.answers
 * @param {object} built VisionBuilt
 * @param {object} display DisplayInfo
 * @param {object} cfg VisionConfig
 */
function interpretVisionAnswers(answers, built, display, cfg) {
  const asked = built.flags;
  const prevDone = readNoul(answers, 'prev_done', asked.verify);
  const taskDone = readNoul(answers, 'task_done', asked.final);
  const visible = readNoul(answers, 'visible', asked.ground);
  const blocked = readNoul(answers, 'blocked', asked.ground);
  const risky = readNoul(answers, 'risky', asked.riskyAsked);

  const base = {
    ok: true,
    prevDone: null, taskDone: null, visible: null, blocked: null, risky: null,
    box: null, boxReject: null, element: null, click: null, clickReason: 'no_target',
  };

  if ([prevDone, taskDone, visible, blocked, risky].some(v => v && v.bad)) {
    return { ...base, ok: false, reason: 'bad_answer' };
  }

  // A drag over an area (a canvas, a slider track) may box far more than a control.
  const { box, boxReject } = parseBoxAnswer(answers, asked.ground, cfg, 'target',
    asked.drag && !asked.drag2 ? 0.95 : undefined);
  const element = parseElementAnswer(answers, built, cfg);
  if (element && element.bad) return { ...base, ok: false, reason: 'bad_answer' };

  const out = {
    ...base,
    prevDone, taskDone, visible, blocked, risky,
    box, boxReject, element: element || null,
  };

  if (!asked.ground) return out;

  if (visible !== null && visible < cfg.thresholds.visible) {
    out.clickReason = 'not_visible';
    return out;
  }

  const usableBox = box && !boxReject ? box : null;

  if (asked.drag) {
    let p1 = null;
    let p2 = null;
    if (asked.drag2) {
      const second = parseBoxAnswer(answers, true, cfg, 'target_to');
      if (usableBox && second.box && !second.boxReject) {
        p1 = boxCenterToNormalized(usableBox);
        p2 = boxCenterToNormalized(second.box);
      } else if (!out.boxReject && second.boxReject) {
        out.boxReject = 'to_' + second.boxReject;
      }
    } else if (usableBox && built.dragSpec) {
      const at = (f) => ({
        nx: Math.min(999, Math.max(0, (usableBox.left + f[0] * (usableBox.right - usableBox.left)) * 1000)),
        ny: Math.min(999, Math.max(0, (usableBox.top + f[1] * (usableBox.bottom - usableBox.top)) * 1000)),
      });
      p1 = at(built.dragSpec.from);
      p2 = at(built.dragSpec.to);
    }
    if (p1 && p2) {
      out.click = { source: 'box', nx: p1.nx, ny: p1.ny, nx2: p2.nx, ny2: p2.ny };
      out.clickReason = 'drag';
    }
    return out;
  }

  const el = element || null;
  const elCenter = el ? elementCenterToNormalized(built.elementMap[el.id], display) : null;

  if (el && elCenter && usableBox) {
    if (insideExpandedBox(elCenter, usableBox)) {
      out.element = { id: el.id, conf: el.conf };
      out.click = { source: 'element', elementId: el.id, nx: elCenter.nx, ny: elCenter.ny };
      out.clickReason = 'element_agrees';
    } else {
      const c = boxCenterToNormalized(usableBox);
      out.element = { id: el.id, conf: el.conf };
      out.click = { source: 'box', nx: c.nx, ny: c.ny };
      out.clickReason = 'element_box_disagree';
    }
    return out;
  }
  if (el && elCenter) {
    out.element = { id: el.id, conf: el.conf };
    out.click = { source: 'element', elementId: el.id, nx: elCenter.nx, ny: elCenter.ny };
    out.clickReason = 'element';
    return out;
  }
  if (usableBox) {
    const c = boxCenterToNormalized(usableBox);
    out.click = { source: 'box', nx: c.nx, ny: c.ny };
    out.clickReason = 'box';
    return out;
  }
  out.clickReason = 'no_target';
  return out;
}

/** Deterministic identity of an action, used for the repeat guard. */
function actionSignature(step, click) {
  const parts = [step.op];
  if (click) parts.push(`@${Math.round(click.nx / 20)},${Math.round(click.ny / 20)}`);
  if (click && click.nx2 !== undefined) parts.push(`>${Math.round(click.nx2 / 20)},${Math.round(click.ny2 / 20)}`);
  if (step.op === 'type') parts.push(step.text || '');
  if (step.op === 'hotkey') parts.push(step.keys || '');
  if (step.op === 'open_app') parts.push(step.app || '');
  if (step.op === 'open_url') parts.push(step.url || '');
  if (step.op === 'scroll') parts.push(`${step.direction || 'down'}:${step.amount || 5}`);
  return parts.join('|');
}

// Cheap picture of a frame for "did anything change" checks: a 48x27 luma grid.
// `bgra` is a 48x27 bitmap (Electron nativeImage.resize().toBitmap()).
const SIG_W = 48;
const SIG_H = 27;
function lumaSignature(bgra) {
  const n = SIG_W * SIG_H;
  if (!bgra || bgra.length < n * 4) return null;
  const sig = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sig[i] = (bgra[o + 2] * 77 + bgra[o + 1] * 150 + bgra[o] * 29) >> 8;
  }
  return sig;
}

/**
 * True when two signatures show the same screen. A blinking caret or a ticking
 * clock moves a few cells by a few levels; real changes (page load, dialog,
 * typed text) move many or a lot, so only a handful of mildly different cells
 * still count as unchanged.
 */
// Full-sensitivity check of the cells around a point (nx, ny in 0..999): any cell
// moving more than a few levels counts as a change (a toggle or checkbox repaint
// is only a few cells and a few levels, which sameFrame deliberately tolerates).
function sameRegion(a, b, nx, ny, pad = 0.08, cellDelta = 6) {
  if (!a || !b || a.length !== b.length || a.length !== SIG_W * SIG_H) return false;
  const cx = nx / 1000;
  const cy = ny / 1000;
  const c0 = Math.max(0, Math.floor((cx - pad) * SIG_W));
  const c1 = Math.min(SIG_W - 1, Math.ceil((cx + pad) * SIG_W));
  const r0 = Math.max(0, Math.floor((cy - pad) * SIG_H));
  const r1 = Math.min(SIG_H - 1, Math.ceil((cy + pad) * SIG_H));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * SIG_W + c;
      if (Math.abs(a[i] - b[i]) > cellDelta) return false;
    }
  }
  return true;
}

function sameFrame(a, b, maxCells = 4, cellDelta = 16) {
  if (!a || !b || a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > cellDelta && ++changed > maxCells) return false;
  }
  return true;
}

module.exports = {
  lumaSignature,
  sameFrame,
  sameRegion,
  SIG_W,
  SIG_H,
  DEFAULT_VISION_CFG,
  readVisionConfig,
  IMAGE_LIMITS,
  fitImageSize,
  validateImageDims,
  SCREEN_REF,
  sanitizeText,
  validatePlan,
  parseTrivialCommand,
  isConsequential,
  isRiskyHotkey,
  isHardRiskyHotkey,
  needsRiskCheck,
  buildRiskCheckRequest,
  zoomRectFor,
  buildZoomRequest,
  mapZoomBox,
  parseBoxAnswer,
  parseHttpUrl,
  describeStep,
  buildVisionRequest,
  interpretVisionAnswers,
  boxCenterToNormalized,
  elementCenterToNormalized,
  normalizedToPhysical,
  actionSignature,
  // Re-exported so the runner can stay on the single "./jev-vision" require.
  describeElement,
  stepNeedsGround,
  isClickOp,
  CLICK_OPS,
};
