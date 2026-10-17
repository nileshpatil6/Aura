// Gemini text planner for Jev Vision mode. Turns one instruction into a
// validated Plan (or the remaining steps after a failure). No electron, no key
// logging. Contract: docs/jev-vision/CONTRACT.md section 2.3 and 3.4.

const { validatePlan, describeStep } = require('./jev-vision');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = [
  'You plan Windows 11 desktop actions for an automation agent. You output JSON only.',
  '',
  'Each step has an "op" and its fields:',
  '- click / double_click / right_click: "target" (short, unique visual description of the control).',
  '- drag: press, move and release the mouse. Either "target" (an area, e.g. "the white drawing canvas") with "from" and "to" as [x,y] fractions 0..1 inside that area (from [0.2,0.8] to [0.8,0.8] is a horizontal line near the bottom; when both are left out the drag goes from [0.25,0.25] to [0.75,0.75], which is right for dragging out a shape), or "target_from" and "target_to" (two controls, e.g. a file icon and a folder). Use it to draw shapes, move sliders, drag and drop. A shape needs one drag per stroke, each with its own from and to: a house is a square (four drags: top [0.3,0.5]->[0.7,0.5], right [0.7,0.5]->[0.7,0.9], bottom [0.7,0.9]->[0.3,0.9], left [0.3,0.9]->[0.3,0.5]) plus a roof (two drags meeting at [0.5,0.25]).',
  '- type: "text" (the exact literal to type, copied from the user instruction or required to complete it, e.g. a URL, a search query), optional "target" (the field to click first), optional "submit" (press Enter after), optional "clear" (Ctrl+A before typing).',
  '- hotkey: "keys" as lowercase tokens joined by + (for example "ctrl+l", "enter", "win+d"). Only letters, digits and key names (enter, tab, esc, f5, up...); never punctuation keys such as a backtick.',
  '- scroll: optional "direction" ("up" or "down", default down) and optional "amount" (1..15, default 5).',
  '- open_app: "app" (the application name).',
  '- open_url: "url" (a full http or https address). Chrome is the default browser, so this opens the page there.',
  '- wait: "seconds" (0.2..5).',
  '',
  'Every step may carry "done_when": a short description of what is VISIBLE after the step succeeds, or "" when the step cannot be checked visually. Every step may carry "risky": true for send, delete, buy, pay, publish or submit actions.',
  '',
  'Rules:',
  '- Prefer open_app to launch applications.',
  '- To open a website or run a web search use ONE open_url step, never open_app plus typing. A search becomes https://www.google.com/search?q=<url-encoded query>. "open chrome and search for X" is a single open_url step, followed only by the clicks the task still needs. Do not mark open_url risky.',
  '- Targets are short unique visual descriptions, for example "blue Send button at the bottom right of the compose window".',
  '- Put any exact text that must be typed in "text", never paraphrase it.',
  '- done_when describes visible state, never a key press or a file operation.',
  '- Mark risky true for send, delete, buy, pay, publish, post or submit forms.',
  '- At most 12 steps. Keep it minimal.',
  '- You will be asked again, with a screenshot, once these steps have run. For open-ended tasks plan only the next concrete steps (a short list is fine); do not guess what the screen will look like afterwards.',
  '- Prefer direct URLs over clicking: site search URLs such as https://www.flipkart.com/search?q=<query>, https://www.amazon.in/s?k=<query>, https://www.youtube.com/results?search_query=<query>.',
  '- Output JSON only: {"steps":[ ... ]}.',
].join('\n');

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['click', 'double_click', 'right_click', 'drag', 'type', 'hotkey', 'scroll', 'open_app', 'open_url', 'wait'] },
          target: { type: 'string' },
          target_from: { type: 'string' },
          target_to: { type: 'string' },
          from: { type: 'array', items: { type: 'number' }, description: 'drag start as [x,y] fractions 0..1 inside the target area; give a different point for every stroke' },
          to: { type: 'array', items: { type: 'number' }, description: 'drag end as [x,y] fractions 0..1 inside the target area' },
          text: { type: 'string' },
          keys: { type: 'string' },
          app: { type: 'string' },
          url: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'integer' },
          seconds: { type: 'number' },
          submit: { type: 'boolean' },
          clear: { type: 'boolean' },
          done_when: { type: 'string' },
          risky: { type: 'boolean' },
        },
        required: ['op'],
      },
    },
  },
  required: ['steps'],
};

// Replans may declare the task finished (no more steps) after looking at the screen.
const REPLAN_SCHEMA = {
  ...PLAN_SCHEMA,
  properties: { ...PLAN_SCHEMA.properties, task_complete: { type: 'boolean' } },
};

// Strip markdown fences; the model occasionally wraps JSON even when asked not to.
function stripFences(text) {
  let t = String(text == null ? '' : text).trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

function promptText(parts) {
  return parts.filter(Boolean).join('\n');
}

function firstErrorMessage(json) {
  const msg = json && json.error && json.error.message;
  return typeof msg === 'string' ? msg.slice(0, 200) : '';
}

/**
 * One generateContent call. Never throws; errors carry the HTTP status and the
 * first 200 chars of the API message (never the URL or the key). No retry here:
 * hedgedPlan below owns retries and hedging.
 * @returns {Promise<{ok:true, text:string, ms:number}|{ok:false, error:string, status?:number, ms:number}>}
 */
async function geminiGenerate({ key, model, userText, timeoutMs, signal, thinkingLevel = 'low', maxOutputTokens = 2048, fetchFn = fetch,
                                 imageJpeg = null, schema = PLAN_SCHEMA }) {
  const start = Date.now();
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [
      ...(imageJpeg && imageJpeg.length ? [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from(imageJpeg).toString('base64') } }] : []),
      { text: userText },
    ] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.2,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel },
    },
  });

  if (signal && signal.aborted) return { ok: false, error: 'aborted', ms: 0 };
  if (timeoutMs <= 0) return { ok: false, error: 'timeout', ms: 0 };

  // Own timer plus the external signal; the timer stays armed through the body read.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const relay = () => ctl.abort();
  if (signal) signal.addEventListener('abort', relay, { once: true });

  try {
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
        signal: ctl.signal,
      });
    } catch (e) {
      const ms = Date.now() - start;
      if (signal && signal.aborted) return { ok: false, error: 'aborted', ms };
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { ok: false, error: 'timeout', ms };
      return { ok: false, error: 'request failed', ms };
    }

    if (!res.ok) {
      let msg = '';
      try { msg = firstErrorMessage(await res.json()); } catch {}
      const error = `HTTP ${res.status}${msg ? ' ' + msg : ''}`.slice(0, 260);
      return { ok: false, error, status: res.status, ms: Date.now() - start };
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      const ms = Date.now() - start;
      if (signal && signal.aborted) return { ok: false, error: 'aborted', ms };
      if (e && e.name === 'AbortError') return { ok: false, error: 'timeout', ms };
      return { ok: false, error: 'bad JSON', status: res.status, ms };
    }

    const parts = (json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts) || [];
    const text = parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
    if (!text) return { ok: false, error: 'no plan text', status: res.status, ms: Date.now() - start };
    return { ok: true, text, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

function parseAndValidate(text, source, allowComplete) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    return { ok: false, error: 'planner returned invalid JSON' };
  }
  // "Nothing more to do": only when the caller can act on it (continue replans).
  if (allowComplete && parsed && parsed.task_complete === true && (!Array.isArray(parsed.steps) || parsed.steps.length === 0)) {
    return { ok: true, plan: { steps: [], source, complete: true } };
  }
  return validatePlan({ ...parsed, source });
}

const MIN_REQUEST_MS = 400; // do not start a request with less budget than this

/**
 * Hedged planner request. Starts request #1; if no VALID plan has arrived by
 * `hedgeMs` an identical request #2 starts in parallel. The first valid plan
 * wins and the others are aborted. An invalid answer or a retryable failure
 * (network, timeout, 5xx) triggers a replacement at once; a 429 waits
 * `retryAfter429Ms` first (capped by the remaining budget). Never more than
 * `maxRequests` requests, never past `timeoutMs` in total. 4xx other than 429
 * are final (bad key or request), so they end the run immediately.
 * @returns {Promise<{ok:true, plan:object, ms:number, requests:number}|{ok:false, error:string, status?:number, ms:number, requests:number}>}
 */
function hedgedPlan({ key, userText, source, model, timeoutMs, hedgeMs, maxRequests = 3, signal,
                      thinkingLevel, maxOutputTokens, fetchFn, retryAfter429Ms = 1000,
                      imageJpeg = null, allowComplete = false }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const ctls = new Set();
    let started = 0;
    let pending = 0;
    let delayed = 0; // replacement requests waiting out a 429 back-off
    const retryTimers = new Set();
    let done = false;
    let hedgeTimer = null;
    let budgetTimer = null;
    let last = null;

    function onAbort() { finish({ ok: false, error: 'aborted' }); }

    function finish(res) {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      clearTimeout(budgetTimer);
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
      if (signal) signal.removeEventListener('abort', onAbort);
      for (const c of ctls) { try { c.abort(); } catch {} }
      ctls.clear();
      resolve({ ...res, ms: Date.now() - start, requests: started });
    }

    function launch() {
      if (done || started >= maxRequests) return false;
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining < MIN_REQUEST_MS) return false;
      started++;
      pending++;
      const ctl = new AbortController();
      ctls.add(ctl);
      geminiGenerate({ key, model, userText, timeoutMs: remaining, signal: ctl.signal,
                       thinkingLevel, maxOutputTokens, fetchFn, imageJpeg,
                       schema: allowComplete ? REPLAN_SCHEMA : PLAN_SCHEMA }).then((gen) => {
        pending--;
        ctls.delete(ctl);
        if (done) return;
        let failure = gen;
        if (gen.ok) {
          const v = parseAndValidate(gen.text, source, allowComplete);
          if (v.ok) { finish({ ok: true, plan: v.plan }); return; }
          failure = { ok: false, error: v.error };
        }
        last = { error: failure.error, status: failure.status };
        if (failure.status && failure.status !== 429 && failure.status < 500) {
          finish({ ok: false, ...last });
          return;
        }
        if (failure.status === 429 && retryAfter429Ms > 0) {
          // Rate limited: back off before the replacement, but never past the budget.
          const wait = Math.max(0, Math.min(retryAfter429Ms, timeoutMs - (Date.now() - start) - MIN_REQUEST_MS));
          delayed++;
          const t = setTimeout(() => {
            retryTimers.delete(t);
            delayed--;
            if (done) return;
            if (!launch() && pending === 0 && delayed === 0) finish({ ok: false, ...last });
          }, wait);
          retryTimers.add(t);
          return;
        }
        if (!launch() && pending === 0 && delayed === 0) finish({ ok: false, ...last });
      });
      return true;
    }

    if (signal) {
      if (signal.aborted) { finish({ ok: false, error: 'aborted' }); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    budgetTimer = setTimeout(() => finish({ ok: false, ...(last || { error: 'timeout' }) }), timeoutMs);
    if (Number.isFinite(hedgeMs) && hedgeMs >= 0 && maxRequests > 1) {
      hedgeTimer = setTimeout(() => { launch(); }, hedgeMs);
    }
    launch();
  });
}

function plannerOpts(o) {
  return {
    hedgeMs: o.hedgeMs === undefined ? 2500 : o.hedgeMs,
    maxRequests: o.maxRequests === undefined ? 3 : o.maxRequests,
    thinkingLevel: o.thinkingLevel,
    maxOutputTokens: o.maxOutputTokens,
    fetchFn: o.fetchFn,
  };
}

/**
 * Plan a whole task from one instruction.
 * @returns {Promise<{ok:true, plan:object, ms:number, requests:number}|{ok:false, error:string, status?:number, ms:number, requests:number}>}
 */
async function planTask({ key, instruction, model, timeoutMs, signal, ...opts }) {
  const userText = promptText([
    'TASK:',
    instruction,
    '',
    'Return the full ordered list of steps to complete TASK.',
  ]);
  return hedgedPlan({ key, userText, source: 'gemini', model, timeoutMs, signal, ...plannerOpts(opts) });
}

/**
 * Replan from the current point. Returns REMAINING steps only. With `image` (the
 * current screenshot as JPEG) Gemini sees what the user sees; `mode: 'continue'`
 * means every planned step already ran and the task is not confirmed done, so
 * the planner may also answer {"steps":[],"task_complete":true}.
 * @param {{ key:string, instruction:string, done:string[],
 *           failed:{step:object, reason:string}|null,
 *           screen:{title:string, process:string, elements:string[]}|null,
 *           image?:Buffer|null, jev?:{vis?:number, boxConf?:number, prevDone?:number, taskDone?:number}|null,
 *           mode?:'fail'|'continue',
 *           model:string, timeoutMs:number, signal:AbortSignal }} req
 */
async function replanTask({ key, instruction, done, failed, screen, image, jev, mode, model, timeoutMs, signal, ...opts }) {
  const hasImage = !!(image && image.length);
  const fmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : null);
  const lines = ['TASK:', instruction, ''];
  lines.push('STEPS ALREADY COMPLETED:');
  if (done && done.length) for (const d of done) lines.push(`- ${d}`);
  else lines.push('(none)');
  lines.push('');
  if (failed && failed.step) {
    lines.push(`THE STEP THAT FAILED: ${describeStep(failed.step)}`);
    lines.push(`FAILURE REASON: ${failed.reason || 'unknown'}`);
    lines.push('');
  } else if (mode === 'continue') {
    lines.push('All planned steps have run, but the task is not confirmed complete.');
    lines.push('');
  }
  if (jev) {
    const bits = [];
    if (fmt(jev.vis) !== null) bits.push(`target visibility ${fmt(jev.vis)}`);
    if (fmt(jev.boxConf) !== null) bits.push(`locator confidence ${fmt(jev.boxConf)}`);
    if (fmt(jev.prevDone) !== null) bits.push(`last step verified ${fmt(jev.prevDone)}`);
    if (fmt(jev.taskDone) !== null) bits.push(`task done ${fmt(jev.taskDone)}`);
    if (bits.length) {
      lines.push(`THE VISION CHECKER SAID (0 = no, 1 = yes): ${bits.join(', ')}.`);
      lines.push('');
    }
  }
  if (screen) {
    lines.push(`CURRENT WINDOW: "${screen.title || ''}" (process: ${screen.process || ''})`);
    if (screen.elements && screen.elements.length) {
      lines.push('VISIBLE ELEMENTS:');
      for (const e of screen.elements.slice(0, 30)) lines.push(`- ${e}`);
    }
    lines.push('');
  }
  if (hasImage) {
    lines.push('The attached image is the screen right now.');
    lines.push('Describe each click target by the text, label or icon that is visible on this screen, not by what you expect to see.');
  }
  lines.push('Prefer direct URLs (for example https://www.flipkart.com/search?q=<query>, https://www.amazon.in/s?k=<query>) over clicking search results or menus.');
  lines.push('Return ONLY the next steps needed to finish TASK, at most 5. Do not repeat completed steps. You will be asked again after these run.');
  if (mode === 'continue') {
    lines.push('First check the screenshot: if TASK is already visibly complete, return exactly {"steps":[],"task_complete":true}.');
  }

  return hedgedPlan({
    key, userText: lines.join('\n'), source: 'replan', model, timeoutMs, signal,
    imageJpeg: hasImage ? image : null, allowComplete: mode === 'continue',
    ...plannerOpts(opts),
  });
}

module.exports = { planTask, replanTask, hedgedPlan, SYSTEM_PROMPT, PLAN_SCHEMA, REPLAN_SCHEMA };
