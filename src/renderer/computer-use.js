// Computer-use agent powered by Gemini 3.5 Flash (state-of-the-art at OSWorld-Verified 78.4%).
// Uses standard function calling with normalized 0-999 coordinates.
// Normalized coords -> physical pixels via main process (Win32 mouse_event).

const CU_MODEL = 'gemini-3.5-flash';
const CU_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${CU_MODEL}:generateContent?key=${key}`;

const SYSTEM_PROMPT = `You are Aura's precision computer-use agent operating a Windows desktop.

INPUT: a screenshot of the current screen + the user's high-level goal.
OUTPUT: exactly one function call representing the next single action.

COORDINATE SYSTEM: all coordinates are NORMALIZED to a 0-999 grid where (0,0) is the top-left and (999,999) is the bottom-right of the screenshot. Look carefully at the screenshot and pick precise coordinates.

RULES:
- Make ONE atomic action per turn (click, type, scroll, hover, key combo, drag).
- Prefer the highest-confidence target. If unsure, hover first or scroll to reveal more.
- After typing into a field, press_enter inside type_text_at when submission is expected.
- When the goal is fully accomplished, call done_done with a brief one-sentence summary. Do not keep acting after success.
- If you cannot make progress (target not visible, system unresponsive), call done_done with summary="cannot proceed: <reason>".
- Never click coordinates blindly. Always reference what you see in the screenshot.`;

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
      functionDeclarations: [
        {
          name: 'click_at',
          description: 'Left-click at a precise location on screen.',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER', description: 'X coordinate (0-999)' },
              y: { type: 'NUMBER', description: 'Y coordinate (0-999)' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'double_click_at',
          description: 'Double-click at a precise location.',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'right_click_at',
          description: 'Right-click at a precise location to open a context menu.',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'type_text_at',
          description: 'Click into a text field at (x,y) then type text. Optionally clear first and/or press Enter to submit.',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER', description: 'X coordinate of the field (0-999)' },
              y: { type: 'NUMBER', description: 'Y coordinate of the field (0-999)' },
              text: { type: 'STRING', description: 'Text to type' },
              clear_before_typing: { type: 'BOOLEAN', description: 'Select all + delete before typing' },
              press_enter: { type: 'BOOLEAN', description: 'Press Enter after typing to submit' },
            },
            required: ['text'],
          },
        },
        {
          name: 'hover_at',
          description: 'Move the mouse to (x,y) without clicking, e.g. to reveal a tooltip or hover menu.',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'scroll_at',
          description: 'Scroll the wheel at (x,y). Use direction up/down and magnitude 1-10.',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
              direction: { type: 'STRING', description: 'up or down' },
              magnitude: { type: 'NUMBER', description: 'Number of wheel ticks (1-10, default 3)' },
            },
            required: ['x', 'y', 'direction'],
          },
        },
        {
          name: 'key_combination',
          description: 'Press a key or key combination. Use this for hotkeys, Enter, Tab, Escape, Ctrl+C/V/A/Z, F-keys, arrow keys, win+d, alt+tab, etc.',
          parameters: {
            type: 'OBJECT',
            properties: {
              keys: { type: 'STRING', description: 'Key or combo. Examples: enter, tab, escape, ctrl+a, ctrl+c, alt+tab, win+d, f5' },
            },
            required: ['keys'],
          },
        },
        {
          name: 'drag_and_drop',
          description: 'Click-and-hold at start (x,y) and release at destination (dx,dy).',
          parameters: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
              destination_x: { type: 'NUMBER' },
              destination_y: { type: 'NUMBER' },
            },
            required: ['x', 'y', 'destination_x', 'destination_y'],
          },
        },
        {
          name: 'wait',
          description: 'Pause for some seconds, e.g. while a page loads or an app launches.',
          parameters: {
            type: 'OBJECT',
            properties: {
              seconds: { type: 'NUMBER', description: 'Seconds to wait (1-10)' },
            },
            required: ['seconds'],
          },
        },
        {
          name: 'done_done',
          description: 'Call this when the goal has been fully accomplished OR cannot proceed. After this, no further actions will be taken.',
          parameters: {
            type: 'OBJECT',
            properties: {
              summary: { type: 'STRING', description: 'One sentence describing what was accomplished (or why progress stopped).' },
            },
            required: ['summary'],
          },
        },
      ],
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
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 0 },
        },
      };

      const resp = await this._post(apiKey, body);
      const cand = resp.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const fc = parts.find(p => p.functionCall)?.functionCall;
      const txt = parts.find(p => p.text)?.text;

      if (txt) this.onLog(txt);

      if (!fc) {
        this.onLog('No action returned, stopping.');
        return txt || 'Stopped (no action).';
      }

      contents.push({ role: 'model', parts: [{ functionCall: fc }] });

      if (fc.name === 'done_done') {
        const summary = fc.args?.summary || 'Done.';
        this.onStep({ action: 'done', summary });
        return summary;
      }

      this.onStep({ action: fc.name, args: fc.args || {} });
      const result = await this._executeAction(fc.name, fc.args || {});

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
      case 'double_click_at':
        await window.electronAPI.computerAction({ action: 'double_click', nx: args.x, ny: args.y });
        return 'double-clicked';
      case 'right_click_at':
        await window.electronAPI.computerAction({ action: 'right_click', nx: args.x, ny: args.y });
        return 'right-clicked';
      case 'type_text_at':
        if (args.x != null && args.y != null) {
          await window.electronAPI.computerAction({ action: 'click', nx: args.x, ny: args.y });
          await new Promise(r => setTimeout(r, 220));
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
      case 'scroll_at': {
        const dir = (args.direction || 'down').toLowerCase();
        const mag = Math.max(1, Math.min(10, args.magnitude || 3));
        await window.electronAPI.computerAction({
          action: dir === 'up' ? 'scroll_up' : 'scroll_down',
          nx: args.x ?? 500,
          ny: args.y ?? 500,
          clicks: mag,
        });
        return 'scrolled ' + dir;
      }
      case 'key_combination':
        await window.electronAPI.computerAction({ action: 'key', key: args.keys || 'enter' });
        return 'pressed ' + (args.keys || 'enter');
      case 'drag_and_drop':
        await window.electronAPI.computerAction({
          action: 'drag',
          nx: args.x, ny: args.y,
          nx2: args.destination_x, ny2: args.destination_y,
        });
        return 'dragged';
      case 'wait': {
        const sec = Math.max(1, Math.min(10, args.seconds || 2));
        await new Promise(r => setTimeout(r, sec * 1000));
        return `waited ${sec}s`;
      }
      default:
        return `unknown action: ${name}`;
    }
  }
}

window.ComputerUseAgent = ComputerUseAgent;
