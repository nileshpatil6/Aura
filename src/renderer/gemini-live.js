console.log('[Aura] gemini-live.js: parse start');
const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.1-flash-live-preview';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const SYSTEM_PROMPT = `You are Aura, a powerful Windows desktop AI assistant (like a smarter Siri). You can control the computer using tools.

CAPABILITIES:
- open_application: Open any app (WhatsApp, Chrome, Spotify, VS Code, Notepad, Settings, etc.)
- run_command: Execute PowerShell for anything else — set volume, brightness, manage files, get weather, create files, control media, search files, manage processes, send emails via Outlook, etc.
- search_web: Open a Google search or specific URL in the browser
- show_notification: Show a Windows toast notification
- get_system_info: Get time/date, battery, memory, disk, running processes, IP, clipboard
- capture_screen: See what's on the user's screen
- do_computer_task: For ANY UI interaction (clicking, typing into fields, scrolling, navigating). Pass a clear goal in plain English; a precision vision specialist handles the actual pixel clicks reliably. Always prefer this over guessing coordinates yourself.
- press_key: Press a single key or hotkey instantly (no vision needed). Use for hotkeys only.
- clipboard: Read or write the clipboard. Use when user says "copy that", "what's in my clipboard", "paste this".
- media_control: play_pause/next/prev/stop for Spotify, YouTube etc.
- set_volume / set_brightness: numeric control with feedback
- window_action: focus/minimize_all/close a window by name
- power_action: lock or sleep the PC
- run_macro: execute a saved macro by name (user defined these in the dashboard)

WHEN TO USE TOOLS vs ANSWER DIRECTLY:
- Answer directly from your knowledge for: general questions, explanations, definitions, math, coding help, advice, history, science, language, recommendations, and anything you already know. Do NOT call any tool for these.
- Only call search_web when the user explicitly says "search for X", "open X website", "look up X online", or needs truly live data you cannot know (current stock price, today's weather, live sports scores, breaking news).
- Only call capture_screen when the user asks "what's on my screen", "can you see my screen", or you need to see the screen to complete a task.
- Only call open_application when the user says "open X" or "launch X".
- Only call run_command / get_system_info when the user asks about their specific system state.

AUTONOMOUS MULTI-STEP BEHAVIOR:
- For complex on-screen tasks like "open chrome and search cats" or "click the submit button", call do_computer_task with the full goal in plain English. A precision vision specialist will handle clicking and typing for you. Don't try to guess pixel coordinates yourself.
- For simple OS actions, prefer the dedicated tool (open_application for launching apps, search_web for the browser, run_command for shell tasks).
- Combine tools when natural — open the app first, then hand the UI work to do_computer_task.
- Keep spoken responses short — one or two sentences max.`;

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'capture_screen',
      description: 'Captures a screenshot of the screen so you can see and analyse what the user is looking at.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'open_application',
      description: 'Opens any installed application on Windows by name. Works for any app: WhatsApp, Chrome, Spotify, VS Code, Notepad, Calculator, Settings, Discord, Teams, Zoom, Steam, etc.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description: 'App name to open, e.g. "whatsapp", "chrome", "spotify", "vscode", "settings"',
          },
          url: {
            type: 'STRING',
            description: 'Optional URL to open in the browser instead of a local app',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'run_command',
      description: 'Executes a PowerShell command for any Windows automation task not covered by other tools. Examples: set volume, adjust brightness, list files, create/delete files, get weather, control media playback, manage startup apps, get wifi password, send notifications, restart/shutdown, etc. The command output is returned to you.',
      parameters: {
        type: 'OBJECT',
        properties: {
          command: {
            type: 'STRING',
            description: 'PowerShell command to execute. Can be multi-line.',
          },
          label: {
            type: 'STRING',
            description: 'One short phrase describing what this command does, shown to the user while executing.',
          },
        },
        required: ['command', 'label'],
      },
    },
    {
      name: 'search_web',
      description: 'Opens a web search or URL in the default browser.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'Search query (e.g. "weather today") or full URL (e.g. "https://github.com")',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'show_notification',
      description: 'Shows a Windows toast notification to the user.',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Notification title' },
          message: { type: 'STRING', description: 'Notification body text' },
        },
        required: ['title', 'message'],
      },
    },
    {
      name: 'get_system_info',
      description: 'Gets system information. Use before answering questions about the system.',
      parameters: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            description: 'One of: time, battery, volume, processes, disk, memory, wifi, clipboard, ip',
          },
        },
        required: ['type'],
      },
    },
    {
      name: 'do_computer_task',
      description: 'Delegate a UI task to the precision computer-use specialist. Use this for ANY task that needs clicking, typing into fields, scrolling to find things, or interacting with on-screen elements. Give a clear high-level goal — the specialist will plan and execute steps with pixel-accurate clicks using a dedicated vision model.',
      parameters: {
        type: 'OBJECT',
        properties: {
          goal: {
            type: 'STRING',
            description: 'High-level goal in plain English. Examples: "Click the search bar in Chrome and type cats", "Open the file menu and click Save", "Scroll down to find the submit button and click it".',
          },
        },
        required: ['goal'],
      },
    },
    {
      name: 'press_key',
      description: 'Press a single key or key combination instantly (no vision needed). Use for hotkeys only — for clicking or typing into fields, use do_computer_task instead.',
      parameters: {
        type: 'OBJECT',
        properties: {
          key: { type: 'STRING', description: 'Key name. Examples: enter, tab, escape, ctrl+c, ctrl+v, ctrl+a, ctrl+z, f5, win+d' },
        },
        required: ['key'],
      },
    },
    {
      name: 'clipboard',
      description: 'Read or write the system clipboard.',
      parameters: {
        type: 'OBJECT',
        properties: {
          op:   { type: 'STRING', description: 'read or write' },
          text: { type: 'STRING', description: 'Text to write (for op=write)' },
        },
        required: ['op'],
      },
    },
    {
      name: 'media_control',
      description: 'Control media playback for Spotify, YouTube, etc. via global media keys.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', description: 'play_pause, next, prev, stop, vol_up, vol_down, mute' },
        },
        required: ['action'],
      },
    },
    {
      name: 'set_volume',
      description: 'Set system volume to a specific percentage (0-100).',
      parameters: {
        type: 'OBJECT',
        properties: { percent: { type: 'NUMBER', description: '0 to 100' } },
        required: ['percent'],
      },
    },
    {
      name: 'set_brightness',
      description: 'Set display brightness to a percentage (0-100). Laptops only.',
      parameters: {
        type: 'OBJECT',
        properties: { percent: { type: 'NUMBER', description: '0 to 100' } },
        required: ['percent'],
      },
    },
    {
      name: 'window_action',
      description: 'Focus a window by app name, minimize everything, or close an app.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', description: 'focus, minimize_all, close' },
          name:   { type: 'STRING', description: 'App name for focus/close (e.g. "chrome", "spotify")' },
        },
        required: ['action'],
      },
    },
    {
      name: 'power_action',
      description: 'Lock the screen or put the PC to sleep.',
      parameters: {
        type: 'OBJECT',
        properties: { action: { type: 'STRING', description: 'lock, sleep' } },
        required: ['action'],
      },
    },
    {
      name: 'run_macro',
      description: 'Run a saved macro by name. Macros are user-defined automation goals from the dashboard.',
      parameters: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING', description: 'Macro name as shown in the dashboard.' } },
        required: ['name'],
      },
    },
  ],
}];

class GeminiLive {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.ws = null;
    this.audioCtx = null;
    this.sourceNode = null;
    this.processor = null;
    this.stream = null;
    this.audioQueue = [];
    this.isPlaying = false;
    this.nextPlayTime = 0;
    this.connected = false;
    this._pendingTools = new Set();
  }

  // Diagnostics -> %APPDATA%/aura/aura-debug.log
  _log(...args) {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try { window.electronAPI?.debugLog?.(`[live] ${line}`); } catch {}
    console.log('[live]', ...args);
  }

  float32ToInt16Base64(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(int16.buffer);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  base64ToFloat32(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768.0;
    return f32;
  }

  enqueueAudio(b64) {
    const samples = this.base64ToFloat32(b64);
    this.audioQueue.push(samples);
    this.callbacks.onStateChange('speaking');
    if (!this.isPlaying) this._playNext();
  }

  _playNext() {
    if (!this.audioCtx || this.audioQueue.length === 0) {
      this.isPlaying = false;
      if (this.connected && this.audioQueue.length === 0) {
        this.callbacks.onStateChange('listening');
      }
      return;
    }
    this.isPlaying = true;
    const samples = this.audioQueue.shift();
    const buf = this.audioCtx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.audioCtx.destination);
    const now = this.audioCtx.currentTime;
    const start = Math.max(now, this.nextPlayTime);
    src.start(start);
    this.nextPlayTime = start + buf.duration;
    src.onended = () => this._playNext();
  }

  async startRecording() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    }
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: INPUT_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this._muted) return;
      const data = e.inputBuffer.getChannelData(0);
      const b64 = this.float32ToInt16Base64(data);
      this.ws.send(JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: b64 },
        },
      }));
    };

    this.sourceNode.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  stopRecording() {
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
  }

  async connect() {
    if (this.connected) return;
    console.log('[Aura] connect() called');
    // Prefer electron-store (shared with dashboard), fall back to localStorage
    let apiKey = '';
    try {
      apiKey = await window.electronAPI?.storeGet('settings', 'apiKey') || '';
      console.log('[Aura] storeGet settings.apiKey:', apiKey ? `(${apiKey.length} chars, starts ${apiKey.slice(0,6)}…)` : '(empty)');
    } catch (e) { console.warn('[Aura] storeGet failed:', e); }
    if (!apiKey) {
      apiKey = localStorage.getItem('gemini_api_key') || '';
      console.log('[Aura] fallback localStorage gemini_api_key:', apiKey ? '(found)' : '(empty)');
    }
    if (!apiKey) throw new Error('NO_API_KEY');
    // Pull voice preference too
    let voice = 'Aoede';
    try { voice = (await window.electronAPI?.storeGet('settings', 'voice')) || 'Aoede'; } catch {}
    this._voice = voice;
    this.callbacks.onStateChange('listening');

    // Compose personalized system prompt FIRST so handlers are ready before WS opens.
    let personalPrompt = SYSTEM_PROMPT;
    try {
      const mem = await window.electronAPI?.storeGet('memory') || {};
      const macros = await window.electronAPI?.storeGet('automations') || [];
      const recent = (await window.electronAPI?.storeGet('history') || []).slice(-6);
      const extra = [];
      if (mem.name) extra.push(`USER'S NAME: ${mem.name} — call them by this when natural.`);
      if (mem.notes?.length) extra.push(`USER NOTES:\n${mem.notes.join('\n')}`);
      if (macros.length) extra.push(`SAVED MACROS (callable via run_macro): ${macros.map(m => `"${m.name}" — ${m.goal}`).join(' | ')}`);
      if (recent.length) {
        extra.push('RECENT CONVERSATION (for context):\n' + recent.map(m => `${m.role}: ${m.text}`).join('\n'));
      }
      if (extra.length) personalPrompt += '\n\n' + extra.join('\n\n');
    } catch {}

    console.log('[Aura] Opening WS to', WS_BASE);
    console.log('[Aura] Using model:', MODEL);
    const ws = new WebSocket(`${WS_BASE}?key=${apiKey}`);
    this.ws = ws;

    // Promise that resolves when the setup-complete message arrives
    const setupPromise = new Promise((resolve, reject) => {
      this._setupResolve = resolve;
      this._setupReject = reject;
    });
    // Safety: don't hang forever — surface as a visible error
    const setupTimeout = setTimeout(() => {
      if (this._setupReject) {
        const readyState = ws.readyState;
        const stateMap = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
        const msg = `Setup timeout (8s). WS state: ${stateMap[readyState] || readyState}. Likely cause: invalid key, model rejected, or firewall.`;
        console.error('[Aura]', msg);
        this._setupReject(new Error(msg));
        this._setupReject = null; this._setupResolve = null;
      }
    }, 8000);

    ws.onopen = () => {
      const setupMsg = {
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: this._voice || 'Aoede' },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: personalPrompt }],
          },
          tools: TOOLS,
        },
      };
      console.log('[Aura] WS opened. Sending setup:', JSON.stringify(setupMsg).slice(0, 400) + '…');
      ws.send(JSON.stringify(setupMsg));
    };

    ws.onmessage = async (event) => {
      let raw;
      if (event.data instanceof Blob) {
        raw = await event.data.text();
      } else {
        raw = event.data;
      }

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Log the SHAPE of every message — this is what reveals whether the model
      // ever replies after a tool response, and whether turnComplete arrives.
      const sc0 = msg.serverContent;
      this._log('recv', JSON.stringify({
        keys: Object.keys(msg),
        turnComplete: sc0?.turnComplete,
        interrupted: sc0?.interrupted,
        hasModelTurn: !!sc0?.modelTurn,
        partKinds: (sc0?.modelTurn?.parts || []).map(p => (p.inlineData ? 'audio' : p.text ? 'text' : 'other')),
        toolCalls: (msg.toolCall?.functionCalls || []).map(c => c.name),
        pendingTools: [...this._pendingTools],
      }));

      if (msg.error) {
        this.callbacks.onError(`Gemini error: ${msg.error.message || JSON.stringify(msg.error)}`);
        if (this._setupReject) { this._setupReject(new Error(msg.error.message || 'setup failed')); this._setupReject = null; this._setupResolve = null; }
        return;
      }

      if (msg.setupComplete) {
        console.log('Setup complete, starting mic...');
        this.connected = true;
        this.callbacks.onStateChange('listening');
        await this.startRecording();
        this.callbacks.onReady?.();
        if (this._setupResolve) { this._setupResolve(); this._setupResolve = null; this._setupReject = null; }
        return;
      }

      if (msg.serverContent) {
        const sc = msg.serverContent;
        if (sc.interrupted) {
          this.audioQueue = [];
          this.isPlaying = false;
          this.nextPlayTime = 0;
          this.callbacks.onStateChange('listening');
          return;
        }
        if (sc.modelTurn) {
          const parts = sc.modelTurn.parts || [];
          for (const part of parts) {
            if (part.inlineData) this.enqueueAudio(part.inlineData.data);
            if (part.text) this.callbacks.onTranscript(part.text);
          }
        }
        if (sc.turnComplete) {
          // Only defer to _playNext() when audio is genuinely still queued —
          // otherwise the state must be released here.
          if (this.audioQueue.length === 0 && !this.isPlaying) {
            this.callbacks.onStateChange('listening');
          } else {
            this._log('turnComplete while audio still playing — _playNext will release state',
              { queued: this.audioQueue.length, isPlaying: this.isPlaying });
          }
        }
      }

      if (msg.toolCall) {
        const calls = msg.toolCall.functionCalls || [];
        this._log('toolCall received', calls.map(c => c.name));
        this.callbacks.onStateChange('thinking');
        const t0 = Date.now();
        await Promise.all(calls.map(call => this._dispatchTool(call)));
        this._log(`all tool calls finished in ${Date.now() - t0}ms; awaiting model reply`,
          { pendingTools: [...this._pendingTools] });
      }
    };

    ws.onerror = (e) => {
      console.error('[Aura] WS error event:', e);
      this.callbacks.onError('Connection error — check API key and internet.');
      this.connected = false;
      if (this._setupReject) { this._setupReject(new Error('WS error')); this._setupReject = null; this._setupResolve = null; }
    };

    ws.onclose = (event) => {
      console.warn('[Aura] WS closed. code:', event.code, 'reason:', event.reason || '(none)', 'wasClean:', event.wasClean);
      this.connected = false;
      if (event.code !== 1000 && event.code !== 1001) {
        this.callbacks.onError(`Disconnected (${event.code}): ${event.reason || 'Check API key or network.'}`);
      }
      if (this._setupReject) {
        this._setupReject(new Error(`Closed (${event.code}): ${event.reason || 'see console'}`));
        this._setupReject = null; this._setupResolve = null;
      }
    };

    // Wait for setupComplete before returning from connect()
    try {
      await setupPromise;
    } finally {
      clearTimeout(setupTimeout);
    }
  }

  async _dispatchTool(call) {
    const { id, name, args = {} } = call;
    this._pendingTools.add(name);
    const _t0 = Date.now();
    this._log(`tool START ${name}`, JSON.stringify(args).slice(0, 200));
    try {
      // Hard ceiling so no tool can strand the session. The individual awaits
      // inside are bounded too; this is the last line of defence for anything
      // unforeseen. Computer use legitimately runs longest, hence the split.
      const cap = name === 'do_computer_task' ? 120000 : 45000;
      let capTimer;
      const capped = new Promise((_, reject) => {
        capTimer = setTimeout(
          () => reject(new Error(`${name} exceeded ${cap / 1000}s ceiling`)), cap);
      });
      try {
        return await Promise.race([this._dispatchToolInner(call), capped]);
      } finally {
        clearTimeout(capTimer);
      }
    } catch (err) {
      this._log(`tool ERROR ${name}: ${err.message}`);
      // Always answer the model — an unanswered toolCall leaves the turn open
      // and the UI parked in 'thinking'.
      try { this._sendToolResponse(id, name, { success: false, output: err.message }); } catch {}
      try { this.callbacks.onStateChange('listening'); } catch {}
    } finally {
      this._pendingTools.delete(name);
      this._log(`tool END ${name} after ${Date.now() - _t0}ms`);
    }
  }

  async _dispatchToolInner(call) {
    const { id, name, args = {} } = call;
    // Log activity
    try {
      const kind = (name === 'do_computer_task' || name === 'press_key') ? 'click'
                 : (name === 'run_command') ? 'command'
                 : 'system';
      const summary = name + ': ' + JSON.stringify(args).slice(0, 140);
      window.electronAPI?.storePush('activity', { kind, summary });
    } catch {}

    try {
      let result;

      if (name === 'capture_screen') {
        result = await this._toolCaptureScreen(id);
        return; // capture_screen sends its own responses
      } else if (name === 'open_application') {
        this.callbacks.onTranscript(`Opening ${args.name}…`);
        result = await window.electronAPI.openApp(args.name, args.url || '');
      } else if (name === 'run_command') {
        this.callbacks.onTranscript(`Running: ${args.label}…`);
        result = await window.electronAPI.runPowerShell(args.command);
      } else if (name === 'search_web') {
        this.callbacks.onTranscript(`Searching: ${args.query}…`);
        result = await window.electronAPI.searchWeb(args.query);
      } else if (name === 'show_notification') {
        result = await window.electronAPI.showNotification(args.title, args.message);
      } else if (name === 'get_system_info') {
        result = await window.electronAPI.getSystemInfo(args.type);
      } else if (name === 'do_computer_task') {
        this.callbacks.onTranscript(`Computer task: ${args.goal}…`);
        // Read from electron-store first — that's where the dashboard Settings
        // tab saves the key. This previously only checked localStorage, which is
        // empty for anyone who set their key via Settings, so every voice-driven
        // computer task failed with an unauthorized request.
        let apiKey = '';
        try { apiKey = await window.electronAPI?.storeGet('settings', 'apiKey') || ''; } catch {}
        if (!apiKey) apiKey = localStorage.getItem('gemini_api_key') || '';
        const agent = new window.ComputerUseAgent({
          onStep: (s) => this.callbacks.onActivity?.({ kind: 'cu_step', ...s }),
          onLog:  (m) => this.callbacks.onTranscript(`  · ${m}`),
        });
        this._cuAgent = agent;
        try {
          const summary = await agent.run({ apiKey, goal: args.goal, maxSteps: 15 });
          result = { success: true, output: summary };
        } catch (err) {
          result = { success: false, output: err.message };
        }
        this._cuAgent = null;
        this._sendToolResponse(id, name, result);
        await this._sendAutoScreenshot();
        return;
      } else if (name === 'press_key') {
        this.callbacks.onTranscript(`Pressing ${args.key}…`);
        result = await window.electronAPI.computerAction({ action: 'key', key: args.key });
      } else if (name === 'clipboard') {
        if (args.op === 'read') {
          result = await window.electronAPI.readClipboard();
        } else if (args.op === 'write') {
          result = await window.electronAPI.writeClipboard(args.text || '');
        } else {
          result = { success: false, output: 'unknown clipboard op' };
        }
      } else if (name === 'media_control') {
        this.callbacks.onTranscript(`Media: ${args.action}…`);
        result = await window.electronAPI.mediaControl(args.action);
      } else if (name === 'set_volume') {
        this.callbacks.onTranscript(`Volume → ${args.percent}%`);
        result = await window.electronAPI.setVolume(args.percent);
      } else if (name === 'set_brightness') {
        this.callbacks.onTranscript(`Brightness → ${args.percent}%`);
        result = await window.electronAPI.setBrightness(args.percent);
      } else if (name === 'window_action') {
        if (args.action === 'focus')        result = await window.electronAPI.focusWindow(args.name);
        else if (args.action === 'minimize_all') result = await window.electronAPI.minimizeAll();
        else if (args.action === 'close')   result = await window.electronAPI.closeApp(args.name);
        else result = { success: false, output: 'unknown window action' };
      } else if (name === 'power_action') {
        if (args.action === 'lock')  result = await window.electronAPI.lockScreen();
        else if (args.action === 'sleep') result = await window.electronAPI.sleepPc();
        else result = { success: false, output: 'unknown power action' };
      } else if (name === 'run_macro') {
        const macros = await window.electronAPI.storeGet('automations') || [];
        const m = macros.find(x => x.name?.toLowerCase() === (args.name || '').toLowerCase());
        if (!m) {
          result = { success: false, output: `No macro named "${args.name}"` };
        } else {
          this.callbacks.onTranscript(`Running macro: ${m.name}…`);
          // Re-dispatch as do_computer_task with the macro's goal
          await this._dispatchTool({ id, name: 'do_computer_task', args: { goal: m.goal } });
          return;
        }
      } else {
        result = { success: false, output: `Unknown tool: ${name}` };
      }

      this._sendToolResponse(id, name, result);
    } catch (err) {
      console.error('Tool error:', name, err);
      this._sendToolResponse(id, name, { success: false, output: err.message });
    }
  }

  _sendToolResponse(id, name, result) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Socket died while the tool was running — don't strand the UI in 'thinking'.
      this._log(`toolResponse SKIPPED for ${name} — socket not open (readyState=${this.ws?.readyState})`);
      this.callbacks.onStateChange('idle');
      return;
    }
    this._log(`toolResponse sent for ${name}`, JSON.stringify(result).slice(0, 160));
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{
          id,
          name,
          response: {
            success: result.success !== false,
            output: result.output || 'Done',
          },
        }],
      },
    }));
  }

  async _toolCaptureScreen(callId) {
    const b64 = await window.electronAPI.takeScreenshot();
    this._sendToolResponse(callId, 'capture_screen', {
      success: !!b64,
      output: b64 ? 'screenshot_ready' : 'no_screen_found',
    });
    if (b64) {
      this.ws.send(JSON.stringify({
        realtimeInput: {
          video: { mimeType: 'image/jpeg', data: b64 },
        },
      }));
    }
  }

  async _sendAutoScreenshot() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const b64 = await window.electronAPI.takeScreenshot();
    if (!b64) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        video: { mimeType: 'image/jpeg', data: b64 },
      },
    }));
  }

  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.callbacks.onError('Not connected to Gemini. Please reopen the assistant.');
      return;
    }
    this.callbacks.onUserText(text);
    this.callbacks.onStateChange('thinking');
    // Persist to history
    try { window.electronAPI?.storePush('history', { role: 'user', text }); } catch {}
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }

  mute()   { this._muted = true; }
  unmute() { this._muted = false; }

  disconnect() {
    this._log('disconnect()');
    this.stopRecording();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.audioQueue = [];
    this.isPlaying = false;
    this.nextPlayTime = 0;
    this.connected = false;
  }

  startVisualizer(callback) {
    if (!this.stream) return null;
    const actx = new AudioContext();
    const analyser = actx.createAnalyser();
    analyser.fftSize = 64;
    const src = actx.createMediaStreamSource(this.stream);
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const bars = Array.from({ length: 20 }, (_, i) => {
        const idx = Math.floor((i / 20) * data.length);
        return Math.max(4, (data[idx] / 255) * 36);
      });
      callback(bars);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); src.disconnect(); actx.close(); };
  }
}

window.GeminiLive = GeminiLive;
console.log('[Aura] gemini-live.js: registered window.GeminiLive');
