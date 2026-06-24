// Computer-use agent — Gemini 3 Flash with built-in computer_use tool.
// Per the Gemini 3 docs: "Gemini 3 Pro and Gemini 3 Flash support Computer Use.
// Unlike the 2.5 series, you don't need to use a separate model."

const CU_MODEL = 'gemini-3-flash-preview';
const CU_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${CU_MODEL}:generateContent?key=${key}`;

const CU_SYSTEM_PROMPT = `You are Aura's precision computer-use specialist operating a Windows 11 desktop.

Given a screenshot + a high-level goal, return exactly ONE function call representing the next single UI action.

COORDINATES: normalized 0-999. (0,0) = top-left of the screenshot, (999,999) = bottom-right. Aim for the visual CENTER of the target element.

CLICK PRECISION:
- Text fields → click inside the field (not on its border)
- Buttons → center of the button label or icon
- Small UI (taskbar, system tray, close buttons) → measure carefully, prefer the literal pixel center
- Menu items → click on the text label, not the row edge

WINDOWS DESKTOP CONTEXT:
- This is the local Windows desktop, NOT a web browser
- To launch an app: key_combination 'win' to open Start, then type_text_at the app name and press_enter
- Use key_combination for Alt+Tab, Win+D, Ctrl+C, Ctrl+V, F5, etc.
- Don't call open_web_browser / navigate / search / go_back / go_forward — they are no-ops here

WORKFLOW:
- One atomic action per turn. Do not narrate.
- After typing into a search/URL field, use press_enter=true in type_text_at.
- If a step takes a moment (app opening, page loading), call wait_5_seconds, then continue.
- If you cannot make progress (target not visible, system frozen), output plain text starting with DONE: <reason>.
- When the goal is fully accomplished, output plain text starting with DONE: <one-sentence summary>.`;

class ComputerUseAgent {
  constructor({ onStep, onLog }) {
    this.onStep = onStep || (() => {});
    this.onLog = onLog || (() => {});
    this.aborted = false;
  }

  abort() { this.aborted = true; }

  async _post(apiKey, body) {
    const res = await fetch(CU_ENDPOINT(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Computer Use API ${res.status}: ${txt.slice(0, 300)}`);
    }
    return res.json();
  }

  // Built-in computer_use tool; excluded browser-only actions.
  _buildTools() {
    return [{
      computerUse: {
        environment: 'ENVIRONMENT_BROWSER',
        excludedPredefinedFunctions: [
          'open_web_browser',
          'navigate',
          'search',
          'go_back',
          'go_forward',
        ],
      },
    }];
  }

  // Single-shot computer-use loop. Returns summary.
  async run({ apiKey, goal, maxSteps = 12 }) {
    this.aborted = false;
    const contents = [{
      role: 'user',
      parts: [{ text: `Task: ${goal}\n\nObserve the screenshot below and take the next single UI action.` }],
    }];

    let lastSummary = '';

    for (let step = 0; step < maxSteps; step++) {
      if (this.aborted) return 'Cancelled.';

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
        generationConfig: {
          thinkingConfig: { thinkingLevel: 'low' },
        },
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

      // Push the model's turn back into history — KEEP thoughtSignature
      contents.push({ role: 'model', parts: [fcPart] });

      this.onStep({ action: fc.name, args: fc.args || {} });
      const result = await this._executeAction(fc.name, fc.args || {});
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
    switch (name) {
      case 'click_at':
        await api.computerAction({ action: 'click', nx: args.x, ny: args.y });
        return `clicked (${args.x},${args.y})`;
      case 'double_click_at':
        await api.computerAction({ action: 'double_click', nx: args.x, ny: args.y });
        return `double-clicked (${args.x},${args.y})`;
      case 'right_click_at':
        await api.computerAction({ action: 'right_click', nx: args.x, ny: args.y });
        return `right-clicked (${args.x},${args.y})`;
      case 'type_text_at':
        if (args.x != null && args.y != null) {
          await api.computerAction({ action: 'click', nx: args.x, ny: args.y });
          await new Promise(r => setTimeout(r, 200));
        }
        if (args.clear_before_typing) {
          await api.computerAction({ action: 'key', key: 'ctrl+a' });
          await api.computerAction({ action: 'key', key: 'delete' });
        }
        await api.computerAction({ action: 'type', text: args.text || '' });
        if (args.press_enter) {
          await api.computerAction({ action: 'key', key: 'enter' });
        }
        return `typed "${(args.text || '').slice(0, 40)}"`;
      case 'hover_at':
        await api.computerAction({ action: 'move', nx: args.x, ny: args.y });
        return `hovered (${args.x},${args.y})`;
      case 'scroll_document':
      case 'scroll_at': {
        const dir = (args.direction || 'down').toLowerCase();
        const mag = Math.max(1, Math.min(10, args.magnitude || 3));
        await api.computerAction({
          action: dir === 'up' ? 'scroll_up' : 'scroll_down',
          nx: args.x ?? 500,
          ny: args.y ?? 500,
          clicks: mag,
        });
        return `scrolled ${dir} ${mag}`;
      }
      case 'key_combination':
        await api.computerAction({ action: 'key', key: args.keys || 'enter' });
        return `pressed ${args.keys}`;
      case 'drag_and_drop':
        await api.computerAction({
          action: 'drag',
          nx: args.x, ny: args.y,
          nx2: args.destination_x, ny2: args.destination_y,
        });
        return 'dragged';
      case 'wait_5_seconds':
        await new Promise(r => setTimeout(r, 5000));
        return 'waited 5s';
      case 'open_web_browser':
      case 'navigate':
      case 'search':
      case 'go_back':
      case 'go_forward':
        return `${name} is browser-only and not supported on Windows desktop`;
      default:
        return `unknown action: ${name}`;
    }
  }
}

window.ComputerUseAgent = ComputerUseAgent;
