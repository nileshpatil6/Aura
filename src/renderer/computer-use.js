// Computer-use agent powered by Gemini 2.5 Computer Use (the dedicated specialist).
// Per Google docs: Gemini 3.5 Flash does NOT support computer-use; this is the model.
// Uses normalized 0-999 coords; downstream automation converts to physical pixels.

const CU_MODEL = 'gemini-2.5-computer-use-preview-10-2025';
const CU_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${CU_MODEL}:generateContent?key=${key}`;

const SYSTEM_PROMPT = `You are Aura's precision computer-use specialist operating a Windows 11 desktop UI.

YOUR JOB: given a screenshot + a goal, decide the SINGLE next UI action that makes progress toward the goal. Return exactly one function call.

COORDINATE SYSTEM: all coordinates are normalized to a 0-999 grid. (0,0) is the top-left, (999,999) the bottom-right of the screenshot. Look carefully at the screenshot and target the exact center of the element to click.

CLICK PRECISION RULES:
- Target the visual CENTER of an element, not its edge
- For text fields: click slightly inside the field, not on its border
- For buttons: center of the button text or icon
- For small icons (taskbar, system tray, close buttons): be especially careful — measure carefully
- For menu items: click the text label, not the row's edge
- For window title bars or close buttons: aim center
- When in doubt, hover first or use keyboard shortcuts (key_combination)

OPERATIONAL RULES:
- Make ONE atomic action per turn. Do not narrate.
- This is a Windows DESKTOP, not a web browser. Do NOT call open_web_browser, navigate, search, go_back, go_forward — they are no-ops here. Use key_combination (e.g. 'win', 'win+d') or click_at to launch apps and interact with the OS.
- For app launching, use key_combination with 'win' to open Start, then type the app name and press 'enter'.
- After typing into a search/URL field, use the press_enter=true option of type_text_at to submit.
- If a step takes a moment (page loading, app opening), call wait_5_seconds, then check again.
- Be decisive: do not endlessly hover or scroll. If you cannot proceed, stop.`;

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

  // Exclude browser-only actions that don't apply to a Windows desktop, so the
  // model is forced to use click_at / type_text_at / key_combination instead.
  _buildTools() {
    return [
      {
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
      },
    ];
  }

  // Single-shot computer-use loop. Returns summary.
  async run({ apiKey, goal, maxSteps = 12 }) {
    this.aborted = false;
    const contents = [{
      role: 'user',
      parts: [{ text: `Task: ${goal}\n\nObserve the screenshot below and take the next single UI action. When the task is fully done OR cannot proceed, output the action result as plain text starting with DONE: <summary>.` }],
    }];

    let lastSummary = '';

    for (let step = 0; step < maxSteps; step++) {
      if (this.aborted) return 'Cancelled.';

      // Capture clean screenshot (Aura windows hidden)
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
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: this._buildTools(),
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
      };

      const resp = await this._post(apiKey, body);
      const cand = resp.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const fc = parts.find(p => p.functionCall)?.functionCall;
      const txt = parts.find(p => p.text)?.text;

      if (txt) {
        this.onLog(txt.slice(0, 160));
        if (/^\s*DONE:/i.test(txt)) {
          return txt.replace(/^\s*DONE:\s*/i, '').slice(0, 200);
        }
      }

      if (!fc) {
        // No action and no DONE marker — model gave up
        return txt || lastSummary || 'Stopped (no action returned).';
      }

      // Push the model's turn into history
      contents.push({ role: 'model', parts: [{ functionCall: fc }] });

      this.onStep({ action: fc.name, args: fc.args || {} });
      const result = await this._executeAction(fc.name, fc.args || {});
      lastSummary = `${fc.name}: ${result}`;

      // Push the function response back (URL is required by the schema; we pass a sentinel)
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
      // Browser-only actions are excluded; if model returns one anyway, no-op safely
      case 'open_web_browser':
      case 'navigate':
      case 'search':
      case 'go_back':
      case 'go_forward':
        return `${name} is not supported in desktop mode; ignored`;
      default:
        return `unknown action: ${name}`;
    }
  }
}

window.ComputerUseAgent = ComputerUseAgent;
