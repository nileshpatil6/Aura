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
  '- type: "text" (the exact literal to type, copied from the user instruction or required to complete it, e.g. a URL, a search query), optional "target" (the field to click first), optional "submit" (press Enter after), optional "clear" (Ctrl+A before typing).',
  '- hotkey: "keys" as lowercase tokens joined by + (for example "ctrl+l", "enter", "win+d").',
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
          op: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'hotkey', 'scroll', 'open_app', 'open_url', 'wait'] },
          target: { type: 'string' },
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
async function geminiGenerate({ key, model, userText, timeoutMs, signal, thinkingLevel = 'low', maxOutputTokens = 2048, fetchFn = fetch }) {
  const start = Date.now();
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PLAN_SCHEMA,
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

function parseAndValidate(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    return { ok: false, error: 'planner returned invalid JSON' };
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
                      thinkingLevel, maxOutputTokens, fetchFn, retryAfter429Ms = 1000 }) {
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
                       thinkingLevel, maxOutputTokens, fetchFn }).then((gen) => {
        pending--;
        ctls.delete(ctl);
        if (done) return;
        let failure = gen;
        if (gen.ok) {
          const v = parseAndValidate(gen.text, source);
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
 * Replan from the current point. Returns REMAINING steps only.
 * @param {{ key:string, instruction:string, done:string[],
 *           failed:{step:object, reason:string},
 *           screen:{title:string, process:string, elements:string[]}|null,
 *           model:string, timeoutMs:number, signal:AbortSignal }} req
 */
async function replanTask({ key, instruction, done, failed, screen, model, timeoutMs, signal, ...opts }) {
  const lines = ['TASK:', instruction, ''];
  lines.push('STEPS ALREADY COMPLETED:');
  if (done && done.length) for (const d of done) lines.push(`- ${d}`);
  else lines.push('(none)');
  lines.push('');
  if (failed && failed.step) {
    lines.push(`THE STEP THAT FAILED: ${describeStep(failed.step)}`);
    lines.push(`FAILURE REASON: ${failed.reason || 'unknown'}`);
    lines.push('');
  }
  if (screen) {
    lines.push(`CURRENT WINDOW: "${screen.title || ''}" (process: ${screen.process || ''})`);
    if (screen.elements && screen.elements.length) {
      lines.push('VISIBLE ELEMENTS:');
      for (const e of screen.elements.slice(0, 30)) lines.push(`- ${e}`);
    }
    lines.push('');
  }
  lines.push('Return ONLY the remaining steps needed to finish TASK. Do not repeat completed steps.');

  return hedgedPlan({ key, userText: lines.join('\n'), source: 'replan', model, timeoutMs, signal, ...plannerOpts(opts) });
}

module.exports = { planTask, replanTask, hedgedPlan, SYSTEM_PROMPT, PLAN_SCHEMA };
