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
  '- wait: "seconds" (0.2..5).',
  '',
  'Every step may carry "done_when": a short description of what is VISIBLE after the step succeeds, or "" when the step cannot be checked visually. Every step may carry "risky": true for send, delete, buy, pay, publish or submit actions.',
  '',
  'Rules:',
  '- Prefer open_app to launch applications.',
  '- To open a URL in a browser use hotkey ctrl+l, then type the URL with submit true.',
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
          op: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'hotkey', 'scroll', 'open_app', 'wait'] },
          target: { type: 'string' },
          text: { type: 'string' },
          keys: { type: 'string' },
          app: { type: 'string' },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * first 200 chars of the API message (never the URL or the key). Retries once
 * on 429 when at least 3s of the budget remain.
 * @returns {Promise<{ok:true, text:string, ms:number}|{ok:false, error:string, status?:number, ms:number}>}
 */
async function geminiGenerate({ key, model, userText, timeoutMs, signal }) {
  const start = Date.now();
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PLAN_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: 'low' },
    },
  });

  let attempt = 0;
  while (true) {
    if (signal && signal.aborted) return { ok: false, error: 'aborted', ms: Date.now() - start };
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) return { ok: false, error: 'timeout', ms: Date.now() - start };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), remaining);
    const relay = () => ctl.abort();
    if (signal) signal.addEventListener('abort', relay, { once: true });

    try {
      let res;
      try {
        res = await fetch(url, {
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

      if (res.status === 429 && attempt === 0 && timeoutMs - (Date.now() - start) >= 3000) {
        try { await res.text(); } catch {}
        attempt++;
        await sleep(1000);
        continue;
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
}

function parseAndValidate(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    return { ok: false, error: 'planner returned invalid JSON' };
  }
  const res = validatePlan({ ...parsed, source });
  return res;
}

/**
 * Plan a whole task from one instruction.
 * @returns {Promise<{ok:true, plan:object, ms:number}|{ok:false, error:string, status?:number, ms:number}>}
 */
async function planTask({ key, instruction, model, timeoutMs, signal }) {
  const userText = promptText([
    'TASK:',
    instruction,
    '',
    'Return the full ordered list of steps to complete TASK.',
  ]);
  const gen = await geminiGenerate({ key, model, userText, timeoutMs, signal });
  if (!gen.ok) return { ok: false, error: gen.error, status: gen.status, ms: gen.ms };
  const res = parseAndValidate(gen.text, 'gemini');
  if (!res.ok) return { ok: false, error: res.error, ms: gen.ms };
  return { ok: true, plan: res.plan, ms: gen.ms };
}

/**
 * Replan from the current point. Returns REMAINING steps only.
 * @param {{ key:string, instruction:string, done:string[],
 *           failed:{step:object, reason:string},
 *           screen:{title:string, process:string, elements:string[]}|null,
 *           model:string, timeoutMs:number, signal:AbortSignal }} req
 */
async function replanTask({ key, instruction, done, failed, screen, model, timeoutMs, signal }) {
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

  const gen = await geminiGenerate({ key, model, userText: lines.join('\n'), timeoutMs, signal });
  if (!gen.ok) return { ok: false, error: gen.error, status: gen.status, ms: gen.ms };
  const res = parseAndValidate(gen.text, 'replan');
  if (!res.ok) return { ok: false, error: res.error, ms: gen.ms };
  return { ok: true, plan: res.plan, ms: gen.ms };
}

module.exports = { planTask, replanTask, SYSTEM_PROMPT, PLAN_SCHEMA };
