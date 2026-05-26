// Gemini 2.5 Computer Use client (REST). Specialist model for precise UI actions.
// Normalized coords (0-999) -> pixel coords -> Win32 mouse_event via main process.

const CU_MODEL = 'gemini-2.5-computer-use-preview-10-2025';
const CU_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${CU_MODEL}:generateContent?key=${key}`;

const SYSTEM_PROMPT = `You are an expert Windows computer-use agent. Given a screenshot and a goal, output the next single UI action to make progress toward the goal. Use precise normalized coordinates (0-999). Prefer fewer, decisive steps. When the goal is fully achieved, respond with done_done().`;

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

  _buildTools() {
    return [{
      computerUse: {
        environment: 'ENVIRONMENT_BROWSER',
      },
    }, {
      functionDeclarations: [{
        name: 'done_done',
        description: 'Signal that the goal has been fully accomplished. Call this when no further actions are needed.',
        parameters: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING', description: 'Brief summary of what was accomplished.' },
          },
        },
      }],
    }];
  }

  // Run a single-shot computer-use loop for a goal. Returns summary string.
  async run({ apiKey, goal, maxSteps = 12 }) {
    this.aborted = false;
    const contents = [{
      role: 'user',
      parts: [{ text: `Goal: ${goal}\n\nObserve the screenshot and take the next action. When done, call done_done with a short summary.` }],
    }];

    for (let step = 0; step < maxSteps; step++) {
      if (this.aborted) return 'Cancelled.';

      // Capture fresh screenshot
      const b64 = await window.electronAPI.takeScreenshotClean();
      if (!b64) throw new Error('Screenshot failed');

      // Trim earlier screenshots to keep request size manageable — keep only the
      // most recent inlineData while preserving the text/functionCall/functionResponse trail.
      for (const c of contents) {
        if (c.parts) {
          c.parts = c.parts.filter(p => !p.inlineData);
        }
      }

      contents.push({
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }],
      });

      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: this._buildTools(),
        generationConfig: { temperature: 0.2 },
      };

      const resp = await this._post(apiKey, body);
      const cand = resp.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const fc = parts.find(p => p.functionCall)?.functionCall;
      const txt = parts.find(p => p.text)?.text;

      if (txt) this.onLog(txt);

      if (!fc) {
        this.onLog('No function call returned, stopping.');
        return txt || 'Stopped (no action).';
      }

      // Echo function call back into contents
      contents.push({ role: 'model', parts: [{ functionCall: fc }] });

      if (fc.name === 'done_done') {
        const summary = fc.args?.summary || 'Done.';
        this.onStep({ action: 'done', summary });
        return summary;
      }

      this.onStep({ action: fc.name, args: fc.args || {} });
      const result = await this._executeAction(fc.name, fc.args || {});

      // Send function response back
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: fc.name,
            response: { output: result },
          },
        }],
      });
    }

    return `Stopped after ${maxSteps} steps.`;
  }

  async _executeAction(name, args) {
    switch (name) {
      case 'click_at':
        await window.electronAPI.computerAction({ action: 'click', nx: args.x, ny: args.y });
        return 'clicked';
      case 'type_text_at':
        if (args.x != null && args.y != null) {
          await window.electronAPI.computerAction({ action: 'click', nx: args.x, ny: args.y });
          await new Promise(r => setTimeout(r, 250));
        }
        if (args.clear_before_typing) {
          await window.electronAPI.computerAction({ action: 'key', key: 'ctrl+a' });
          await window.electronAPI.computerAction({ action: 'key', key: 'delete' });
        }
        await window.electronAPI.computerAction({ action: 'type', text: args.text || '' });
        if (args.press_enter) {
          await window.electronAPI.computerAction({ action: 'key', key: 'enter' });
        }
        return 'typed';
      case 'hover_at':
        await window.electronAPI.computerAction({ action: 'move', nx: args.x, ny: args.y });
        return 'hovered';
      case 'scroll_at':
      case 'scroll_document': {
        const dir = (args.direction || 'down').toLowerCase();
        const mag = Math.max(1, Math.min(10, args.magnitude || 3));
        await window.electronAPI.computerAction({
          action: dir === 'up' ? 'scroll_up' : 'scroll_down',
          nx: args.x ?? 500,
          ny: args.y ?? 500,
          clicks: mag,
        });
        return 'scrolled';
      }
      case 'key_combination':
        await window.electronAPI.computerAction({ action: 'key', key: args.keys || 'enter' });
        return 'keys pressed';
      case 'drag_and_drop':
        await window.electronAPI.computerAction({
          action: 'drag',
          nx: args.x, ny: args.y,
          nx2: args.destination_x, ny2: args.destination_y,
        });
        return 'dragged';
      case 'wait_5_seconds':
        await new Promise(r => setTimeout(r, 5000));
        return 'waited';
      case 'navigate':
      case 'search':
      case 'go_back':
      case 'go_forward':
      case 'open_web_browser':
        return 'browser actions are out of scope for this desktop agent';
      default:
        return `unknown action: ${name}`;
    }
  }
}

window.ComputerUseAgent = ComputerUseAgent;
