// Thin HTTP client for TypeSafe Jev (/v1/systemone). Main process / plain node only.
// MUST NOT require('electron'). Never include the key in thrown errors or logs.
// Contract: docs/jev-uia/CONTRACT.md section "jev.js" and
// docs/jev-vision/CONTRACT.md section 2.8.
//
// Two transports share this file:
//   - jevCall: text-only JSON (unchanged), used by jev-decide.
//   - jevCallImages: text + one or more screenshots, used by vision mode.

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const DANGER_HEADER = 'TypeSafe-Danger-Zone-Images';

/**
 * @typedef {{ type:'noul', noul:number }} JevNoulAnswer
 * @typedef {{ type:'choice', choice:string, confidence:number, probabilities:Record<string,number> }} JevChoiceAnswer
 * @typedef {{ type:'box', box:{top:number,bottom:number,left:number,right:number}, confidence:number }} JevBoxAnswer
 * @typedef {{ ok:true, model:string, answers:Record<string, JevNoulAnswer|JevChoiceAnswer|JevBoxAnswer>,
 *             usage:{input_tokens:number, output_tokens:number}, ms:number }
 *         | { ok:false, status:number|null, error:string, ms:number }} JevResult
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn a non-ok response into a JevResult error, reading the detail body the
 * API uses (400 -> {detail:"..."}, 401 -> {detail:{message:"..."}}).
 */
async function errorFromResponse(res, start) {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (typeof body.detail === 'string') detail = body.detail;
    else if (body.detail && typeof body.detail.message === 'string') detail = body.detail.message;
  } catch {}
  return { ok: false, status: res.status, error: String(detail).slice(0, 200), ms: Date.now() - start };
}

/** Shared ok-response handling: parse JSON or map a bad/aborted body. */
async function okFromResponse(res, start, extSignal) {
  try {
    const json = await res.json();
    return { ok: true, model: json.model, answers: json.answers, usage: json.usage, ms: Date.now() - start };
  } catch (e) {
    const ms = Date.now() - start;
    if (extSignal && extSignal.aborted) return { ok: false, status: null, error: 'aborted', ms };
    if (e && e.name === 'AbortError') return { ok: false, status: res.status, error: 'timeout', ms };
    return { ok: false, status: res.status, error: 'bad JSON', ms };
  }
}

/**
 * One stateless Jev call. Never throws; all failures map to { ok:false }.
 * @param {{ key:string, state:string, questions:object, timeoutMs?:number, model?:string }} req
 * @returns {Promise<JevResult>}
 */
async function jevCall({ key, state, questions, timeoutMs = 4000, model = JEV_MODEL }) {
  const start = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  // The timer stays armed for the WHOLE call, not just until headers arrive:
  // a server that sends headers promptly but stalls the body would otherwise
  // leave res.json() awaiting forever with nothing left to abort it, hanging
  // the jev-decide IPC handler past its own timeout (violates I3). Clearing
  // it only in `finally`, after every await, keeps the same abort signal live
  // through the body read too.
  try {
    let res;
    try {
      res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state, questions }),
        signal: ctl.signal,
      });
    } catch (e) {
      const ms = Date.now() - start;
      if (e && e.name === 'AbortError') return { ok: false, status: null, error: 'timeout', ms };
      return { ok: false, status: null, error: 'request failed', ms };
    }

    // await keeps the timer armed through the body read (see comment above)
    if (!res.ok) return await errorFromResponse(res, start);
    return await okFromResponse(res, start);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the request body + headers for an image call. Pure, no network.
 * @param {{ model:string, state:object, questions:object,
 *           images:Array<{ref:string, part:string, buffer:Buffer, format:'jpeg'|'png'}>,
 *           transport?:'multipart'|'json' }} req
 * @returns {{ body: FormData|string, headers: Record<string,string> }}
 */
function buildJevHttpBody({ model, state, questions, images = [], transport = 'multipart' }) {
  const mimeFor = (format) => (format === 'png' ? 'image/png' : 'image/jpeg');

  if (transport === 'json') {
    const assets = {};
    for (const img of images) {
      assets[img.ref] = { type: 'image', format: img.format, data_base64: img.buffer.toString('base64') };
    }
    return {
      body: JSON.stringify({ model, state, questions, assets }),
      headers: { 'Content-Type': 'application/json', [DANGER_HEADER]: 'true' },
    };
  }

  // Multipart: the JSON payload goes in a `request` part and each image rides
  // as its own file part. Never set Content-Type by hand (T7: it kills the
  // boundary fetch generates).
  // The server requires `request` to be the FIRST part, so it is appended
  // before the image parts.
  const assets = {};
  for (const img of images) {
    assets[img.ref] = { type: 'image', format: img.format, part: img.part };
  }
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model, state, questions, assets })], { type: 'application/json' }));
  for (const img of images) {
    form.append(img.part, new Blob([img.buffer], { type: mimeFor(img.format) }), `${img.part}.${img.format}`);
  }
  return { body: form, headers: { [DANGER_HEADER]: 'true' } };
}

/**
 * Jev call carrying screenshots. Never throws. Retries once on 429/529 if time
 * remains. External `signal` abort -> error 'aborted'; own timer -> 'timeout'.
 * @param {{ key:string, model?:string, state:object, questions:object,
 *           images:Array<object>, transport?:'multipart'|'json', timeoutMs?:number,
 *           signal?:AbortSignal }} req
 * @returns {Promise<JevResult>}
 */
async function jevCallImages({ key, model = JEV_MODEL, state, questions, images, transport = 'multipart', timeoutMs = 6000, signal }) {
  const start = Date.now();
  let attempt = 0;

  while (true) {
    if (signal && signal.aborted) return { ok: false, status: null, error: 'aborted', ms: Date.now() - start };
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) return { ok: false, status: null, error: 'timeout', ms: Date.now() - start };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), remaining);
    const relay = () => ctl.abort();
    if (signal) signal.addEventListener('abort', relay, { once: true });

    const { body, headers } = buildJevHttpBody({ model, state, questions, images, transport });

    try {
      let res;
      try {
        res = await fetch(JEV_ENDPOINT, {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${key}` },
          body,
          signal: ctl.signal,
        });
      } catch (e) {
        const ms = Date.now() - start;
        if (signal && signal.aborted) return { ok: false, status: null, error: 'aborted', ms };
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { ok: false, status: null, error: 'timeout', ms };
        return { ok: false, status: null, error: 'request failed', ms };
      }

      if (res.status === 429 || res.status === 529) {
        let retryAfter = 0;
        try { retryAfter = Number(res.headers.get('retry-after')) || 0; } catch {}
        try { await res.text(); } catch {}

        attempt++;
        const status = res.status;
        if (attempt > 1) return { ok: false, status, error: `HTTP ${status}`, ms: Date.now() - start };
        // Retry-After only counts when it is short; otherwise the 300ms floor.
        const wait = Math.max(300, retryAfter > 0 && retryAfter <= 2 ? retryAfter * 1000 : 0);
        if (signal && signal.aborted) return { ok: false, status: null, error: 'aborted', ms: Date.now() - start };
        if (timeoutMs - (Date.now() - start) <= wait) {
          return { ok: false, status, error: `HTTP ${status}`, ms: Date.now() - start };
        }
        await sleep(wait);
        continue;
      }

      if (!res.ok) return await errorFromResponse(res, start);
      return await okFromResponse(res, start, signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }
}

module.exports = { jevCall, jevCallImages, buildJevHttpBody, JEV_ENDPOINT, JEV_MODEL };
