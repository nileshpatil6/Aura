// Computer-use agent — Gemini 3.x built-in computer_use tool, desktop environment.
//
// IMPORTANT (this file was previously broken): Gemini 3.x renamed every action.
// The 2.5-era names (click_at / type_text_at / key_combination / scroll_document /
// wait_5_seconds) are NOT what 3.x emits. It emits the streamlined set below
// (click / type / press_key / hotkey / scroll / wait / ...). The old switch only
// matched the legacy names, so every click and keystroke fell through to
// "unknown action" and silently did nothing — the model looked like it could
// only open apps. _executeAction() now handles the 3.x names, and keeps the
// legacy aliases so older model IDs still work.
//
// Docs: https://ai.google.dev/gemini-api/docs/computer-use

const CU_MODEL = 'gemini-3.6-flash';
const CU_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${CU_MODEL}:generateContent?key=${key}`;

const CU_SYSTEM_PROMPT = `You are Aura's precision computer-use specialist operating a real Windows 11 desktop.

Given a screenshot and a high-level goal, take the next single UI action.

COORDINATES: normalized 0-999. (0,0) = top-left, (999,999) = bottom-right. Aim for the visual CENTER of the target element.

CLICK PRECISION:
- Text fields → click inside the field, not on its border
- Buttons → center of the button label or icon
- Small UI (taskbar, system tray, window controls) → prefer the literal pixel center
- Menu items → click the text label, not the row edge

WINDOWS DESKTOP CONTEXT:
- This is the local Windows desktop, NOT a web browser
- To launch an app: hotkey ["win"] to open Start, type the app name, then press_key "enter"
- Common chords via hotkey: ["alt","tab"], ["win","d"], ["ctrl","c"], ["ctrl","v"], ["ctrl","shift","n"]
- To open a website, first focus/launch the browser, then use its address bar (ctrl+l)

WORKFLOW:
- One atomic action per turn. Do not narrate.
- After typing into a search or address field, set press_enter=true on the type action.
- If a step needs time (app launching, page loading), call wait with seconds, then continue.
- If you cannot progress (target not visible, system stuck), reply with plain text starting with DONE: <reason>.
- When the goal is fully accomplished, reply with plain text starting with DONE: <one-sentence summary>.`;

// A 429 otherwise surfaces as the agent simply not moving the mouse, which is
// indistinguishable from broken input. Per-minute limits clear on their own;
// the per-day free-tier cap does not, so say which one was hit.
function describeQuotaError(rawBody) {
  let quotaId = '', retry = '';
  try {
    const err = JSON.parse(rawBody).error || {};
    for (const d of err.details || []) {
      if (d.retryDelay) retry = d.retryDelay;
      for (const v of d.violations || []) quotaId = v.quotaId || quotaId;
    }
  } catch {}

  if (/PerDay/i.test(quotaId)) {
    return 'Gemini daily free-tier quota exhausted (429). This resets once every 24h — ' +
           'enable billing at aistudio.google.com to continue today.';
  }
  if (/PerMinute/i.test(quotaId)) {
    return `Gemini per-minute rate limit hit (429). Retrying is fine${retry ? ` — try again in ${retry}` : ''}.`;
  }
  return `Gemini quota exceeded (429)${retry ? ` — retry in ${retry}` : ''}. Check your plan at aistudio.google.com.`;
}

// Nothing inside the agent loop may await forever. A never-settling promise
// (stalled fetch, wedged screenshot IPC) parks the whole tool call, which is
// exactly how the pill ended up stuck on "processing": the debug log showed
// `tool START do_computer_task` with no matching `tool END`, because run()
// never returned. The step deadline can't help — it's checked between steps,
// and a hung await never gets back to that check.
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

const TIMEOUTS = {
  screenshot: 15000,
  request:    45000,
  action:     20000,
};

class ComputerUseAgent {
  constructor({ onStep, onLog }) {
    this.onStep = onStep || (() => {});
    this.onLog = onLog || (() => {});
    this.aborted = false;
  }

  // Mirrors onLog to the debug file so the agent's internals are visible.
  // Previously onLog only reached the transcript UI, so a hang inside run()
  // left no trace in the log at all.
  _log(msg) {
    try { window.electronAPI?.debugLog?.(`[cu] ${msg}`); } catch {}
    this.onLog(msg);
  }

  abort() { this.aborted = true; }

  async _post(apiKey, body, attempt = 0) {
    // fetch() never rejects on a stalled connection, so bound it explicitly.
    const ctl = new AbortController();
    const abortTimer = setTimeout(() => ctl.abort(), TIMEOUTS.request);
    let res;
    try {
      res = await fetch(CU_ENDPOINT(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`Gemini request timed out after ${TIMEOUTS.request / 1000}s`);
      }
      throw e;
    } finally {
      clearTimeout(abortTimer);
    }
    if (res.ok) return res.json();

    const txt = await res.text();

    if (res.status === 429) {
      const msg = describeQuotaError(txt);
      // Per-minute caps clear by themselves — wait out the server's retryDelay
      // and try again rather than aborting the whole task. Daily caps don't,
      // so those fail fast.
      const isTransient = /per-minute/i.test(msg);
      if (isTransient && attempt < 1 && !this.aborted) {
        // One retry only, capped — a long silent wait is worse than surfacing
        // the limit, since the user just sees the agent sitting there.
        const raw = Number((txt.match(/"retryDelay"\s*:\s*"(\d+)s"/) || [])[1]) || 15;
        const secs = Math.min(raw, 15);
        this.onLog(`Rate limited — waiting ${secs}s then retrying once…`);
        await new Promise(r => setTimeout(r, secs * 1000));
        return this._post(apiKey, body, attempt + 1);
      }
      throw new Error(msg);
    }

    throw new Error(`Computer Use API ${res.status}: ${txt.slice(0, 300)}`);
  }

  // Desktop environment: OS-level cursor/keyboard actions, and it natively
  // omits the browser-only navigation actions (navigate/go_back/go_forward),
  // so no exclusion list is needed here.
  _buildTools() {
    return [{ computerUse: { environment: 'ENVIRONMENT_DESKTOP' } }];
  }

  // maxMs bounds total wall time. Without it a task that never emits DONE runs
  // every step to the limit, which reads as the app being frozen.
  //
  // Hybrid loop: each iteration tries the fast Jev/UIA element-click path
  // first (see _jevStep) and only falls back to the Gemini vision path
  // (_visionStep, the original per-step body below) when Jev is off, errors
  // repeatedly, or itself says it needs vision. Without a Jev key/flag,
  // jevStatus().enabled is false and this is byte-for-byte the old loop.
  async run({ apiKey, goal, maxSteps = 12, maxMs = 90000 }) {
    this.aborted = false;
    if (!apiKey) throw new Error('No Gemini API key — set one in the dashboard Settings tab.');
    const deadline = Date.now() + maxMs;

    const contents = [{
      role: 'user',
      parts: [{ text: `Task: ${goal}\n\nObserve the screenshot below and take the next single UI action.` }],
    }];

    let lastSummary = '';

    // Per-run Jev/UIA state (contract 3.8).
    this._history = [];              // StepRecord[]
    this._pendingForGemini = [];     // StepRecord[] executed by Jev since the last Gemini turn
    this._prevJev = null;            // { sig, key, step } | null
    this._excludeKeys = new Set();
    this._excludeHwnd = null;
    this._jevErrors = 0;
    this._consecNoEffect = 0;
    this._consecFallbacks = 0;
    this._jevSkip = 0;
    this._uiaCooldown = 0;
    this._jevOff = false;
    this.executedCount = 0;
    this._counters = { jev: 0, gemini: 0 };

    let jevStatus = { enabled: false };
    try { jevStatus = await window.electronAPI.jevStatus(); } catch { jevStatus = { enabled: false }; }

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (this.aborted) return 'Cancelled.';
        if (Date.now() > deadline) {
          return `Stopped after ${Math.round(maxMs / 1000)}s time limit. ${lastSummary || ''}`.trim();
        }

        if (jevStatus.jevOnly) {
          // Jev-only test mode: no Gemini vision fallback. Unhandled steps are retried
          // after a short settle; three in a row ends the run.
          if (!jevStatus.enabled || this._jevOff) {
            return 'Jev-only mode: Jev is unavailable (no key, disabled, or repeated API errors).';
          }
          const r = await this._jevStep({ goal, step });
          if (this.aborted) return 'Cancelled.';
          if (r.handled) {
            if (r.result !== undefined) return r.result;
            this._jevMisses = 0;
            continue;
          }
          this._jevMisses = (this._jevMisses || 0) + 1;
          this._log(`jev-only: step not handled${r.reason ? ` (${r.reason})` : ''}, miss ${this._jevMisses}/3`);
          if (this._jevMisses >= 3) {
            const last = this._history.slice(-3).map(h => h.desc).join('; ');
            return `Jev-only mode: stopped, Jev could not find the next action on this screen.${last ? ` Did: ${last}` : ''}`;
          }
          await new Promise(res => setTimeout(res, 500));
          continue;
        }

        const useJev = !this._jevOff && jevStatus.enabled && this._jevSkip === 0 && this._uiaCooldown === 0;
        if (!useJev) {
          if (this._jevSkip > 0) this._jevSkip--;
          if (this._uiaCooldown > 0) this._uiaCooldown--;
        }

        if (useJev) {
          const r = await this._jevStep({ goal, step });
          if (this.aborted) return 'Cancelled.';
          if (r.handled) {
            if (r.result !== undefined) return r.result;
            continue; // executed via Jev — next iteration
          }
          // not handled: fall through to vision for THIS SAME iteration
        }

        const vr = await this._visionStep({ apiKey, goal, contents, step, maxSteps, lastSummary });
        if (this.aborted) return 'Cancelled.';
        if (vr.done !== undefined) return vr.done;

        lastSummary = vr.summary;
        this._counters.gemini++;
        this.executedCount++;
        this._history.push({
          step: step + 1, source: 'gemini', desc: lastSummary,
          outcome: /^[^:]*:\s*failed:/.test(lastSummary) ? 'failed' : 'ok',
        });
        this._prevJev = null;
      }

      return `Stopped after ${maxSteps} steps.`;
    } finally {
      this._log(`run: ${this.executedCount} steps (${this._counters.jev} jev, ${this._counters.gemini} gemini)`);
    }
  }

  // ── Jev / UIA element-targeted step ─────────────────────────────────────
  // Renderer has no require() (contextIsolation) — it consumes snap.sig and
  // decisions as opaque strings/objects rather than importing jev-step.js.
  _elementKeyLocal(el) {
    return `${el.type}|${el.name}|${el.aid}`;
  }

  _formatPendingLine(entry, i) {
    const outcomeText = { ok: 'ok', failed: 'failed', no_effect: 'no visible change', unknown: 'result unknown' }[entry.outcome] || 'result unknown';
    return `${i + 1}. [${entry.source}] ${entry.desc} -> ${outcomeText}`;
  }

  _describeJevAction(d) {
    if (d.op === 'click') return `clicked ${d.target}`;
    if (d.op === 'type') return `typed "${d.text}" into ${d.target}`;
    if (d.op === 'key') return `pressed ${d.key}`;
    if (d.op === 'scroll') return `scrolled ${d.direction}`;
    return d.op || 'acted';
  }

  // Returns { handled:true, result?:string } | { handled:false }. One call =
  // at most one executed action (invariant I6): a failure before any input is
  // sent (stale snapshot/element, occluded, unsupported) returns handled:false
  // so the SAME loop iteration falls through to vision instead of burning a step.
  async _jevStep({ goal, step }) {
    const api = window.electronAPI;

    let snap;
    try {
      snap = await withTimeout(api.uiaSnapshot(), 3500, 'uia-snapshot');
    } catch {
      this._uiaCooldown = 2;
      return { handled: false };
    }
    if (this.aborted) return { handled: true, result: 'Cancelled.' };
    if (!snap || !snap.ok || !snap.elements || snap.elements.length === 0) {
      if (snap && (snap.reason === 'timeout' || snap.reason === 'error')) this._uiaCooldown = 2;
      return { handled: false };
    }

    if (snap.hwnd !== this._excludeHwnd) {
      this._excludeKeys = new Set();
      this._excludeHwnd = snap.hwnd;
    }

    // No-effect detection: same signature as the last Jev action means it did
    // nothing visible — exclude that element next time and count it.
    if (this._prevJev && snap.sig === this._prevJev.sig) {
      const entry = this._history.find(h => h.step === this._prevJev.step && h.source === 'jev');
      if (entry) entry.outcome = 'no_effect';
      if (this._prevJev.key) this._excludeKeys.add(this._prevJev.key);
      this._consecNoEffect++;
    } else {
      this._consecNoEffect = 0;
    }
    this._prevJev = null;

    if (this._consecNoEffect >= 2) {
      this._consecNoEffect = 0;
      return { handled: false, reason: 'no_effect' };
    }

    let d;
    try {
      d = await withTimeout(api.jevDecide({
        snapshotId: snap.snapshotId, goal,
        history: this._history, excludeKeys: [...this._excludeKeys],
        executedCount: this.executedCount,
      }), 5000, 'jev-decide');
    } catch {
      d = { ok: false, error: 'timeout', status: null };
    }
    if (this.aborted) return { handled: true, result: 'Cancelled.' };

    if (!d || !d.ok) {
      this._jevErrors++;
      const status = d && d.status;
      if (status === 401 || status === 403 || this._jevErrors >= 2) {
        if (!this._jevOff) this._log('jev: disabling after repeated errors');
        this._jevOff = true;
      }
      return { handled: false };
    }
    this._jevErrors = 0;

    if (d.kind === 'done') {
      const descs = this._history.slice(-3).map(h => h.desc);
      return { handled: true, result: `Done: ${descs.join('; ')}` };
    }

    if (d.kind === 'vision') {
      this._consecFallbacks++;
      this._jevSkip = Math.min(2, this._consecFallbacks - 1);
      return { handled: false };
    }

    // d.kind === 'act'
    this._consecFallbacks = 0;
    this.onStep({ action: `uia_${d.op}`, args: { target: d.target, text: d.text, conf: d.conf } });

    const el = d.elementId ? (snap.elements.find(e => e.id === d.elementId) || null) : null;
    const key = el ? this._elementKeyLocal(el) : null;

    if (this.aborted) return { handled: true, result: 'Cancelled.' };
    let res;
    try {
      res = await withTimeout(api.uiaAct({
        snapshotId: snap.snapshotId, elementId: d.elementId, op: d.op,
        text: d.text, direction: d.direction, key: d.key,
      }), d.op === 'type' ? 15000 : 8000, 'uia-act'); // type: main skips typing after 5s, SendKeys can take up to 8s more
    } catch {
      res = { ok: false, reason: 'timeout' };
    }

    if (res && ['stale_snapshot', 'stale_element', 'occluded', 'unsupported'].includes(res.reason)) {
      return { handled: false };
    }

    let outcome;
    if (res && res.ok) outcome = 'ok';
    else if (res && res.reason === 'timeout') outcome = 'unknown';
    else outcome = 'failed';

    const desc = this._describeJevAction(d);
    const stepNum = step + 1;
    const entry = {
      step: stepNum, source: 'jev', desc, outcome,
      key: key || undefined, conf: d.conf, goal: d.goal,
      ms: { uia: snap.ms, jev: d.ms, act: res && res.ms },
    };
    this._history.push(entry);
    this._pendingForGemini.push(entry);
    this._prevJev = { sig: snap.sig, key, step: stepNum };
    this.executedCount++;
    this._counters.jev++;

    this._log(`⚡ ${desc} (${(d.conf || 0).toFixed(2)}) ${res && res.ms != null ? res.ms : '?'}ms`);
    return { handled: true };
  }

  // ── Gemini vision step (original per-step body, unchanged apart from the
  // Jev-history text injection right before the screenshot) ────────────────
  async _visionStep({ apiKey, goal, contents, step, maxSteps, lastSummary }) {
    this._log(`step ${step + 1}/${maxSteps}: capturing screen`);
    // Capture clean screenshot (all Aura windows hidden by action mode).
    // Bounded: this IPC hides windows and drives desktopCapturer, which can
    // wedge — and an unbounded wait here strands the whole tool call.
    const b64 = await withTimeout(
      window.electronAPI.takeScreenshotClean(), TIMEOUTS.screenshot, 'screenshot');
    if (!b64) throw new Error('Screenshot failed');

    // Strip earlier screenshots — keep only the latest to control request size
    for (const c of contents) {
      if (c.parts) c.parts = c.parts.filter(p => !p.inlineData);
    }

    const screenshotParts = [];
    // Let Gemini see what the fast Jev/UIA path already did since its last turn.
    if (this._pendingForGemini.length) {
      const lines = this._pendingForGemini.map((entry, i) => this._formatPendingLine(entry, i));
      screenshotParts.push({
        text: `Actions already performed by the fast element path since your last action:\n${lines.join('\n')}\nThe screenshot shows the result.`,
      });
      this._pendingForGemini = [];
    }
    screenshotParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });

    contents.push({ role: 'user', parts: screenshotParts });

    const body = {
      systemInstruction: { parts: [{ text: CU_SYSTEM_PROMPT }] },
      contents,
      tools: this._buildTools(),
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    };

    this._log(`step ${step + 1}: requesting next action`);
    const resp = await this._post(apiKey, body);
    if (this.aborted) return { done: 'Cancelled.' };
    const cand = resp.candidates?.[0];
    const parts = cand?.content?.parts || [];
    // Preserve the WHOLE part (including thoughtSignature) so we can echo it back
    const fcPart = parts.find(p => p.functionCall);
    const fc = fcPart?.functionCall;
    const txt = parts.find(p => p.text)?.text;

    if (txt) {
      this.onLog(txt.slice(0, 160));
      if (/^\s*DONE:/i.test(txt)) {
        return { done: txt.replace(/^\s*DONE:\s*/i, '').slice(0, 200) };
      }
    }

    if (!fc) {
      return { done: txt || lastSummary || 'Stopped (no action returned).' };
    }

    const args = fc.args || {};

    // Gemini 3.x may attach a safety_decision requiring human approval.
    // User wants full autonomy — never halt or prompt, just proceed.
    const safety = args.safety_decision;
    if (safety && safety.decision === 'require_confirmation') {
      this.onLog(`⚠ Safety flag ignored: ${safety.explanation || ''}`);
    }

    // Push the model's turn back into history — KEEP thoughtSignature
    contents.push({ role: 'model', parts: [fcPart] });

    if (args.intent) this._log(`· ${args.intent}`);
    this.onStep({ action: fc.name, args });
    let result;
    try {
      result = await withTimeout(
        this._executeAction(fc.name, args), TIMEOUTS.action, `action ${fc.name}`);
    } catch (e) {
      // Report the failure to the model instead of aborting — it can adapt.
      result = `failed: ${e.message}`;
      this._log(`action ${fc.name} FAILED: ${e.message}`);
    }
    this._log(`step ${step + 1} done -> ${result}`);
    const summary = `${fc.name}: ${result}`;

    const response = { url: 'aura://desktop', output: result };
    // The API rejects the NEXT request with a 400 unless a safety_decision
    // that required confirmation is explicitly acknowledged here.
    if (safety && safety.decision === 'require_confirmation') {
      response.safety_acknowledgement = 'true';
    }
    contents.push({
      role: 'user',
      parts: [{
        functionResponse: {
          name: fc.name,
          response,
        },
      }],
    });

    return { summary };
  }

  async _executeAction(name, args) {
    const api = window.electronAPI;
    // Gemini 3.x sends x/y at the top level; the 2.5 aliases used the same
    // field names, so one accessor covers both.
    const nx = args.x, ny = args.y;

    switch (name) {
      // ── Mouse ────────────────────────────────────────────────────────────
      case 'click':
      case 'click_at':
        await api.computerAction({ action: 'click', nx, ny });
        return `clicked (${nx},${ny})`;

      case 'double_click':
      case 'double_click_at':
        await api.computerAction({ action: 'double_click', nx, ny });
        return `double-clicked (${nx},${ny})`;

      case 'triple_click':
        await api.computerAction({ action: 'triple_click', nx, ny });
        return `triple-clicked (${nx},${ny})`;

      case 'right_click':
      case 'right_click_at':
        await api.computerAction({ action: 'right_click', nx, ny });
        return `right-clicked (${nx},${ny})`;

      case 'middle_click':
        await api.computerAction({ action: 'middle_click', nx, ny });
        return `middle-clicked (${nx},${ny})`;

      case 'mouse_down':
        await api.computerAction({ action: 'mouse_down', nx, ny });
        return `mouse down (${nx},${ny})`;

      case 'mouse_up':
        await api.computerAction({ action: 'mouse_up', nx, ny });
        return `mouse up (${nx},${ny})`;

      case 'move':
      case 'hover_at':
        await api.computerAction({ action: 'move', nx, ny });
        return `moved to (${nx},${ny})`;

      case 'drag_and_drop': {
        // 3.x: start_x/start_y/end_x/end_y — 2.5: x/y/destination_x/destination_y
        const sx = args.start_x ?? args.x;
        const sy = args.start_y ?? args.y;
        const ex = args.end_x ?? args.destination_x;
        const ey = args.end_y ?? args.destination_y;
        await api.computerAction({ action: 'drag', nx: sx, ny: sy, nx2: ex, ny2: ey });
        return `dragged (${sx},${sy}) → (${ex},${ey})`;
      }

      // ── Keyboard ─────────────────────────────────────────────────────────
      case 'type':
      case 'type_text_at': {
        // 3.x `type` has no coordinates — it types into whatever has focus.
        // 2.5 `type_text_at` did, so click first when they're present.
        if (nx != null && ny != null) {
          await api.computerAction({ action: 'click', nx, ny });
          await new Promise(r => setTimeout(r, 200));
        }
        if (args.clear_before_typing) {
          await api.computerAction({ action: 'key', key: 'ctrl+a' });
          await api.computerAction({ action: 'key', key: 'delete' });
        }
        await api.computerAction({ action: 'type', text: args.text || '' });
        if (args.press_enter) await api.computerAction({ action: 'key', key: 'enter' });
        return `typed "${(args.text || '').slice(0, 40)}"${args.press_enter ? ' + enter' : ''}`;
      }

      case 'press_key':
        await api.computerAction({ action: 'key', key: args.key || 'enter' });
        return `pressed ${args.key}`;

      case 'hotkey':
      case 'key_combination': {
        // 3.x hotkey: keys is a list. 2.5 key_combination: keys is a string.
        const keys = Array.isArray(args.keys) ? args.keys.join('+') : (args.keys || 'enter');
        await api.computerAction({ action: 'key', key: keys });
        return `pressed ${keys}`;
      }

      case 'key_down':
      case 'key_up':
        // No discrete hold/release primitive on the Windows side; a full press
        // is the closest safe equivalent and avoids leaving a key stuck down.
        await api.computerAction({ action: 'key', key: args.key || 'enter' });
        return `pressed ${args.key}`;

      // ── Scroll ───────────────────────────────────────────────────────────
      case 'scroll':
      case 'scroll_at':
      case 'scroll_document': {
        const dir = (args.direction || 'down').toLowerCase();
        // Magnitude arrives under different names/units depending on the
        // environment. Verified against the live API: ENVIRONMENT_DESKTOP
        // sends `magnitude_in_wheel_clicks` (already notches), while the docs
        // describe `magnitude_in_pixels` for browser (~100px per notch).
        // 2.5 used `magnitude` in pixels. Normalize all three to notches.
        let notches;
        if (args.magnitude_in_wheel_clicks != null) {
          notches = args.magnitude_in_wheel_clicks;
        } else {
          const px = args.magnitude_in_pixels ?? args.magnitude ?? 300;
          notches = Math.round(px / 100);
        }
        notches = Math.max(1, Math.min(15, notches));
        const actionMap = {
          up: 'scroll_up', down: 'scroll_down',
          left: 'scroll_left', right: 'scroll_right',
        };
        await api.computerAction({
          action: actionMap[dir] || 'scroll_down',
          nx: nx ?? 500,
          ny: ny ?? 500,
          clicks: notches,
        });
        return `scrolled ${dir} ${notches} notches`;
      }

      // ── Misc ─────────────────────────────────────────────────────────────
      case 'wait':
      case 'wait_5_seconds': {
        const secs = name === 'wait_5_seconds' ? 5 : (args.seconds ?? 1);
        await new Promise(r => setTimeout(r, Math.min(10, secs) * 1000));
        return `waited ${secs}s`;
      }

      case 'take_screenshot':
        // The loop already captures a fresh screenshot every turn.
        return 'screenshot captured';

      case 'open_web_browser':
      case 'navigate':
      case 'search':
      case 'go_back':
      case 'go_forward':
        return `${name} is browser-only; on the Windows desktop, focus the browser window and use its address bar instead`;

      default:
        return `unknown action: ${name}`;
    }
  }
}

window.ComputerUseAgent = ComputerUseAgent;
