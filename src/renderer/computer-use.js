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

class ComputerUseAgent {
  constructor({ onStep, onLog }) {
    this.onStep = onStep || (() => {});
    this.onLog = onLog || (() => {});
    this.aborted = false;
  }

  abort() { this.aborted = true; }

  async _post(apiKey, body, attempt = 0) {
    const res = await fetch(CU_ENDPOINT(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
  async run({ apiKey, goal, maxSteps = 12, maxMs = 90000 }) {
    this.aborted = false;
    if (!apiKey) throw new Error('No Gemini API key — set one in the dashboard Settings tab.');
    const deadline = Date.now() + maxMs;

    const contents = [{
      role: 'user',
      parts: [{ text: `Task: ${goal}\n\nObserve the screenshot below and take the next single UI action.` }],
    }];

    let lastSummary = '';

    for (let step = 0; step < maxSteps; step++) {
      if (this.aborted) return 'Cancelled.';
      if (Date.now() > deadline) {
        return `Stopped after ${Math.round(maxMs / 1000)}s time limit. ${lastSummary || ''}`.trim();
      }

      // Capture clean screenshot (all Aura windows hidden by action mode)
      const b64 = await window.electronAPI.takeScreenshotClean();
      if (!b64) throw new Error('Screenshot failed');

      // Strip earlier screenshots — keep only the latest to control request size
      for (const c of contents) {
        if (c.parts) c.parts = c.parts.filter(p => !p.inlineData);
      }

      contents.push({
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }],
      });

      const body = {
        systemInstruction: { parts: [{ text: CU_SYSTEM_PROMPT }] },
        contents,
        tools: this._buildTools(),
        generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
      };

      const resp = await this._post(apiKey, body);
      const cand = resp.candidates?.[0];
      const parts = cand?.content?.parts || [];
      // Preserve the WHOLE part (including thoughtSignature) so we can echo it back
      const fcPart = parts.find(p => p.functionCall);
      const fc = fcPart?.functionCall;
      const txt = parts.find(p => p.text)?.text;

      if (txt) {
        this.onLog(txt.slice(0, 160));
        if (/^\s*DONE:/i.test(txt)) {
          return txt.replace(/^\s*DONE:\s*/i, '').slice(0, 200);
        }
      }

      if (!fc) {
        return txt || lastSummary || 'Stopped (no action returned).';
      }

      const args = fc.args || {};

      // Gemini 3.x may attach a safety_decision requiring human approval.
      // Surface it and stop rather than silently auto-confirming.
      const safety = args.safety_decision;
      if (safety && safety.decision === 'require_confirmation') {
        const why = safety.explanation || 'Action needs user confirmation.';
        this.onLog(`⚠ Halted for safety: ${why}`);
        return `Stopped — needs your confirmation: ${why}`;
      }

      // Push the model's turn back into history — KEEP thoughtSignature
      contents.push({ role: 'model', parts: [fcPart] });

      if (args.intent) this.onLog(`· ${args.intent}`);
      this.onStep({ action: fc.name, args });
      const result = await this._executeAction(fc.name, args);
      lastSummary = `${fc.name}: ${result}`;

      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: fc.name,
            response: { url: 'aura://desktop', output: result },
          },
        }],
      });
    }

    return `Stopped after ${maxSteps} steps.`;
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
