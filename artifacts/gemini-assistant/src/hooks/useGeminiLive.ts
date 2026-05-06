import { useState, useRef, useCallback, useEffect } from "react";

export type AssistantState = "idle" | "listening" | "thinking" | "speaking";

interface GeminiMessage {
  type: "text" | "audio";
  content: string;
  role: "user" | "assistant";
}

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY as string;
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
const MODEL = "models/gemini-2.0-flash-live-001";

function base64ToFloat32(base64: string): Float32Array {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function useGeminiLive() {
  const [state, setState] = useState<AssistantState>("idle");
  const [transcript, setTranscript] = useState("");
  const [userText, setUserText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);
  const isConnectedRef = useRef(false);
  const isActiveRef = useRef(false);

  const playNextAudio = useCallback(() => {
    if (!audioCtxRef.current || audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      if (isActiveRef.current && audioQueueRef.current.length === 0) {
        setState((s) => (s === "speaking" ? "listening" : s));
      }
      return;
    }

    isPlayingRef.current = true;
    const samples = audioQueueRef.current.shift()!;
    const sampleRate = 24000;
    const buffer = audioCtxRef.current.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = audioCtxRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtxRef.current.destination);

    const now = audioCtxRef.current.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;
    source.onended = playNextAudio;
  }, []);

  const enqueueAudio = useCallback(
    (base64Data: string) => {
      const samples = base64ToFloat32(base64Data);
      audioQueueRef.current.push(samples);
      setState("speaking");
      if (!isPlayingRef.current) {
        playNextAudio();
      }
    },
    [playNextAudio]
  );

  const stopRecording = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ sampleRate: 16000 });
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    streamRef.current = stream;
    sourceNodeRef.current = audioCtxRef.current.createMediaStreamSource(stream);
    const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const base64 = float32ToInt16Base64(inputData);
      wsRef.current.send(
        JSON.stringify({
          realtime_input: {
            audio: {
              mime_type: "audio/pcm;rate=16000",
              data: base64,
            },
          },
        })
      );
    };

    sourceNodeRef.current.connect(processor);
    processor.connect(audioCtxRef.current.destination);
  }, []);

  const connect = useCallback(async () => {
    if (isConnectedRef.current) return;

    setError(null);
    setTranscript("");
    setUserText("");

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      isConnectedRef.current = true;
      ws.send(
        JSON.stringify({
          setup: {
            model: MODEL,
            generation_config: {
              response_modalities: ["AUDIO"],
              speech_config: {
                voice_config: {
                  prebuilt_voice_config: {
                    voice_name: "Aoede",
                  },
                },
              },
            },
            system_instruction: {
              parts: [
                {
                  text: "You are a helpful AI assistant similar to Siri. Be concise, friendly, and helpful. Keep responses brief unless the user asks for detail.",
                },
              ],
            },
          },
        })
      );
    };

    ws.onmessage = async (event) => {
      let data: unknown;
      if (event.data instanceof Blob) {
        const text = await event.data.text();
        data = JSON.parse(text);
      } else {
        data = JSON.parse(event.data as string);
      }

      const msg = data as Record<string, unknown>;

      if (msg.setupComplete) {
        setState("listening");
        await startRecording();
        return;
      }

      if (msg.serverContent) {
        const sc = msg.serverContent as Record<string, unknown>;

        if (sc.interrupted) {
          audioQueueRef.current = [];
          isPlayingRef.current = false;
          nextPlayTimeRef.current = 0;
          setState("listening");
          return;
        }

        if (sc.modelTurn) {
          const parts = (sc.modelTurn as Record<string, unknown>).parts as Array<Record<string, unknown>>;
          for (const part of parts || []) {
            if (part.inlineData) {
              const inlineData = part.inlineData as Record<string, unknown>;
              enqueueAudio(inlineData.data as string);
            }
            if (part.text) {
              setTranscript((prev) => prev + (part.text as string));
            }
          }
        }

        if (sc.turnComplete) {
          if (audioQueueRef.current.length === 0 && !isPlayingRef.current) {
            setState("listening");
          }
        }
      }

      if (msg.toolCall) {
        setState("thinking");
      }
    };

    ws.onerror = () => {
      setError("Connection error. Check your API key or network.");
      setState("idle");
      isConnectedRef.current = false;
    };

    ws.onclose = () => {
      isConnectedRef.current = false;
      if (isActiveRef.current) {
        setState("idle");
      }
    };
  }, [startRecording, enqueueAudio]);

  const disconnect = useCallback(() => {
    stopRecording();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;
    isConnectedRef.current = false;
    setState("idle");
  }, [stopRecording]);

  const activate = useCallback(async () => {
    isActiveRef.current = true;
    setState("listening");
    await connect();
  }, [connect]);

  const deactivate = useCallback(() => {
    isActiveRef.current = false;
    disconnect();
    setTranscript("");
    setUserText("");
  }, [disconnect]);

  const sendText = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setUserText(text);
    setState("thinking");
    wsRef.current.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: "user", parts: [{ text }] }],
          turn_complete: true,
        },
      })
    );
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    state,
    transcript,
    userText,
    error,
    activate,
    deactivate,
    sendText,
  };
}
