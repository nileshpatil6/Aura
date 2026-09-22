// Thin HTTP client for TypeSafe Jev (/v1/systemone). Main process / plain node only.
// MUST NOT require('electron'). Never include the key in thrown errors or logs.
// Contract: docs/jev-uia/CONTRACT.md section "jev.js".

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

/**
 * @typedef {{ type:'noul', noul:number }} JevNoulAnswer
 * @typedef {{ type:'choice', choice:string, confidence:number, probabilities:Record<string,number> }} JevChoiceAnswer
 * @typedef {{ ok:true, model:string, answers:Record<string, JevNoulAnswer|JevChoiceAnswer>,
 *             usage:{input_tokens:number, output_tokens:number}, ms:number }
 *         | { ok:false, status:number|null, error:string, ms:number }} JevResult
 */

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

    if (!res.ok) {
      // 400 -> {"detail":"<string>"}; 401 -> {"detail":{"error_type","message"}}
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') detail = body.detail;
        else if (body.detail && typeof body.detail.message === 'string') detail = body.detail.message;
      } catch {}
      return { ok: false, status: res.status, error: String(detail).slice(0, 200), ms: Date.now() - start };
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      const ms = Date.now() - start;
      if (e && e.name === 'AbortError') return { ok: false, status: res.status, error: 'timeout', ms };
      return { ok: false, status: res.status, error: 'bad JSON', ms };
    }

    return { ok: true, model: json.model, answers: json.answers, usage: json.usage, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { jevCall, JEV_ENDPOINT, JEV_MODEL };
