const GEMINI_API_KEY = 'REMOVED_API_KEY';
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const MODEL = 'models/gemini-3.1-flash-live-preview';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

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
      // camelCase keys required by the API
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
      // camelCase keys required by the API
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
            parts: [{
              text: 'You are a helpful AI assistant like Siri. Be concise, conversational, and friendly. Keep responses short unless the user asks for detail.',
            }],
          },
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

      console.log('WS msg keys:', Object.keys(msg));

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
            if (part.inlineData) {
              this.enqueueAudio(part.inlineData.data);
            }
            if (part.text) {
              this.callbacks.onTranscript(part.text);
            }
          }
        }
        if (sc.turnComplete) {
          if (this.audioQueue.length === 0 && !this.isPlaying) {
            this.callbacks.onStateChange('listening');
          }
        }
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

  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.callbacks.onError('Not connected to Gemini. Please reopen the assistant.');
      return;
    }
    this.callbacks.onUserText(text);
    this.callbacks.onStateChange('thinking');
    // camelCase keys required by the API
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

    return () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      actx.close();
    };
  }
}

window.GeminiLive = GeminiLive;
