const GEMINI_API_KEY = 'REMOVED_API_KEY';
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const MODEL = 'models/gemini-3.1-flash-live-preview';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const SYSTEM_PROMPT = `You are a powerful Windows desktop AI assistant (like a smarter Siri). You can control the computer using tools.

CAPABILITIES:
- open_application: Open any app (WhatsApp, Chrome, Spotify, VS Code, Notepad, Settings, etc.)
- run_command: Execute PowerShell for anything else — set volume, brightness, manage files, get weather, create files, control media, search files, manage processes, send emails via Outlook, etc.
- search_web: Open a Google search or specific URL in the browser
- show_notification: Show a Windows toast notification
- get_system_info: Get time/date, battery, memory, disk, running processes, IP, clipboard
- capture_screen: See what's on the user's screen

BEHAVIOR:
- Be concise and action-first. When asked to do something, call the tool immediately, then confirm briefly.
- For open_application, pass the plain app name (e.g. "whatsapp", "spotify", "chrome").
- For run_command, write clean PowerShell. The output comes back to you — use it to respond accurately.
- If a task needs multiple steps, chain tool calls.
- Never say you can't do something without trying run_command first.
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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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
    this.callbacks.onStateChange('listening');

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      console.log('WS open, sending setup...');
      ws.send(JSON.stringify({
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Aoede' },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          tools: TOOLS,
        },
      }));
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

      if (msg.error) {
        this.callbacks.onError(`Gemini error: ${msg.error.message || JSON.stringify(msg.error)}`);
        return;
      }

      if (msg.setupComplete) {
        console.log('Setup complete, starting mic...');
        this.connected = true;
        this.callbacks.onStateChange('listening');
        await this.startRecording();
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
        if (sc.turnComplete && this.audioQueue.length === 0 && !this.isPlaying) {
          this.callbacks.onStateChange('listening');
        }
      }

      if (msg.toolCall) {
        this.callbacks.onStateChange('thinking');
        const calls = msg.toolCall.functionCalls || [];
        // run all tool calls in parallel
        await Promise.all(calls.map(call => this._dispatchTool(call)));
      }
    };

    ws.onerror = (e) => {
      console.error('WS error:', e);
      this.callbacks.onError('Connection error. Check API key and internet.');
      this.connected = false;
    };

    ws.onclose = (event) => {
      console.warn('WS closed:', event.code, event.reason);
      this.connected = false;
      if (event.code !== 1000 && event.code !== 1001) {
        this.callbacks.onError(`Disconnected (${event.code}): ${event.reason || 'Check API key or network.'}`);
      }
    };
  }

  async _dispatchTool(call) {
    const { id, name, args = {} } = call;
    console.log('Tool call:', name, args);

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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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

  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.callbacks.onError('Not connected to Gemini. Please reopen the assistant.');
      return;
    }
    this.callbacks.onUserText(text);
    this.callbacks.onStateChange('thinking');
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }

  disconnect() {
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
