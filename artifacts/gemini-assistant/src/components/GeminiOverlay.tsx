import { useState, useRef, useEffect, useCallback } from "react";
import { useGeminiLive } from "@/hooks/useGeminiLive";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";

/* ─── Animated Siri orb ──────────────────────────────────────────────────── */
function SiriOrb({ state, onClick }: { state: string; onClick?: () => void }) {
  const colors: Record<string, string> = {
    idle:      "conic-gradient(from 0deg, #6366f1, #7c6df0, #6366f1)",
    listening: "conic-gradient(from 0deg, #a78bfa, #8b5cf6, #6366f1, #818cf8, #a78bfa)",
    thinking:  "conic-gradient(from 0deg, #60a5fa, #3b82f6, #818cf8, #60a5fa)",
    speaking:  "conic-gradient(from 0deg, #34d399, #06b6d4, #22d3ee, #34d399)",
  };

  const ringColors: Record<string, string> = {
    listening: "rgba(167,139,250,0.4)",
    thinking:  "rgba(96,165,250,0.35)",
    speaking:  "rgba(52,211,153,0.35)",
  };

  const icons: Record<string, string> = {
    idle:      "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z",
    listening: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z",
    thinking:  "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z",
    speaking:  "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  };

  const isActive = state !== "idle";
  const animClass = {
    listening: "animate-orbListen",
    thinking:  "animate-orbSpin",
    speaking:  "animate-orbSpeak",
    idle:      "",
  }[state] || "";

  return (
    <div
      className={`relative cursor-pointer flex-shrink-0 ${onClick ? "cursor-pointer" : ""}`}
      style={{ width: 44, height: 44 }}
      onClick={onClick}
    >
      {/* Outer glow ring */}
      {isActive && (
        <div
          className="absolute inset-[-5px] rounded-full pointer-events-none"
          style={{
            background: `conic-gradient(from 0deg, ${ringColors[state] || "transparent"}, transparent, ${ringColors[state] || "transparent"})`,
            animation: "spinOrb 2s linear infinite",
            opacity: 0.9,
          }}
        />
      )}

      {/* Gradient sphere */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: colors[state] || colors.idle,
          animation: isActive ? "spinOrb 2.5s linear infinite" : "none",
          transition: "background 0.5s ease",
        }}
      />

      {/* Inner glass sphere */}
      <div
        className="absolute rounded-full flex items-center justify-center"
        style={{
          inset: 3,
          background: `
            radial-gradient(circle at 33% 28%, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.02) 55%, transparent 100%),
            radial-gradient(circle at 65% 68%, rgba(0,0,0,0.35) 0%, transparent 55%)
          `,
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="white" style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.5))" }}>
          <path d={icons[state] || icons.idle} />
        </svg>
      </div>
    </div>
  );
}

/* ─── Mic waveform bars ───────────────────────────────────────────────────── */
function MicBars({ active }: { active: boolean }) {
  const [heights, setHeights] = useState<number[]>(Array(22).fill(4));
  const rafRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const actxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!active) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      setHeights(Array(22).fill(4));
      return;
    }
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;
      actxRef.current = new AudioContext();
      analyserRef.current = actxRef.current.createAnalyser();
      analyserRef.current.fftSize = 64;
      srcRef.current = actxRef.current.createMediaStreamSource(stream);
      srcRef.current.connect(analyserRef.current);
      const data = new Uint8Array(analyserRef.current.frequencyBinCount);
      const tick = () => {
        if (cancelled || !analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        setHeights(Array.from({ length: 22 }, (_, i) => {
          const idx = Math.floor((i / 22) * data.length);
          return Math.max(4, (data[idx] / 255) * 38);
        }));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => {
      const tick = () => {
        if (cancelled) return;
        setHeights(Array(22).fill(0).map(() => 4 + Math.random() * 20));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    });
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      actxRef.current?.close();
    };
  }, [active]);

  return (
    <div className="flex items-center justify-center gap-[2.5px] h-11">
      {heights.map((h, i) => (
        <div
          key={i}
          className="rounded-full"
          style={{
            width: 3.5,
            height: h,
            background: "linear-gradient(to top, rgba(139,92,246,0.6), rgba(167,139,250,1))",
            boxShadow: "0 0 6px rgba(139,92,246,0.4)",
            transition: "height 0.06s ease-out",
          }}
        />
      ))}
    </div>
  );
}

/* ─── Speaking wave ───────────────────────────────────────────────────────── */
function SpeakWave() {
  const N = 24;
  const colors = ["#34d399", "#06b6d4", "#22d3ee", "#34d399"];
  return (
    <div className="flex items-center justify-center gap-[3px] h-11">
      {Array.from({ length: N }, (_, i) => {
        const frac = i / N;
        const h = 4 + Math.sin(frac * Math.PI) * 28;
        const color = colors[Math.floor(frac * colors.length)];
        return (
          <div
            key={i}
            className="rounded-full"
            style={{
              width: 3.5,
              height: h,
              background: color,
              animation: `speakWave 0.55s ease-in-out ${(frac * 0.55).toFixed(3)}s infinite alternate`,
            }}
          />
        );
      })}
    </div>
  );
}

/* ─── Thinking dots ───────────────────────────────────────────────────────── */
function ThinkDots() {
  const dotColors = ["#818cf8", "#60a5fa", "#a78bfa"];
  return (
    <div className="flex items-center justify-center gap-[7px] py-3">
      {dotColors.map((color, i) => (
        <div
          key={i}
          className="rounded-full"
          style={{
            width: 8,
            height: 8,
            background: color,
            animation: `thinkDot 1.1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

/* ─── Main overlay ────────────────────────────────────────────────────────── */
export default function GeminiOverlay() {
  const { state, transcript, error, activate, deactivate, sendText } = useGeminiLive();
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback(async () => {
    if (isOpen) {
      setIsOpen(false);
      setShowInput(false);
      setInputText("");
      deactivate();
    } else {
      setIsOpen(true);
      await activate();
    }
  }, [isOpen, activate, deactivate]);

  useKeyboardShortcut({ key: " ", ctrlKey: true }, toggle);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) { sendText(inputText.trim()); setInputText(""); setShowInput(false); }
  };

  useEffect(() => {
    if (showInput) setTimeout(() => inputRef.current?.focus(), 40);
  }, [showInput]);

  return (
    <>
      <div
        className="fixed top-0 left-1/2 z-50 flex flex-col items-center"
        style={{ transform: "translateX(-50%)" }}
      >
        {/* ── Pill ── */}
        <div
          className="relative overflow-hidden flex items-center gap-3 transition-all duration-500"
          style={{
            padding: isOpen ? "8px 18px 8px 10px" : "8px 18px 8px 10px",
            background: "rgba(9,9,20,0.93)",
            backdropFilter: "blur(28px) saturate(1.8)",
            border: "1px solid rgba(139,92,246,0.28)",
            borderTop: "none",
            borderRadius: "0 0 26px 26px",
            boxShadow: isOpen
              ? "0 10px 40px rgba(139,92,246,0.22), 0 2px 8px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)"
              : "0 6px 24px rgba(139,92,246,0.15), 0 2px 8px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
            minWidth: isOpen ? 200 : 170,
          }}
        >
          {/* ambient top glow */}
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse at 50% -10%, rgba(139,92,246,0.13) 0%, transparent 70%)" }} />

          <SiriOrb state={isOpen ? state : "idle"} onClick={isOpen ? undefined : toggle} />

          <span className="relative text-xs font-medium tracking-widest flex-1 text-center" style={{ color: "rgba(255,255,255,0.42)", display: isOpen ? "none" : "block" }}>
            Ctrl+Space
          </span>
          <span className="relative text-xs font-medium tracking-widest flex-1" style={{ color: "rgba(255,255,255,0.42)", textTransform: "uppercase", display: isOpen ? "block" : "none" }}>
            Gemini&nbsp;Assistant
          </span>

          {isOpen && (
            <button
              onClick={toggle}
              className="relative w-[22px] h-[22px] flex items-center justify-center rounded-full transition-all duration-200 flex-shrink-0 text-xs"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.35)" }}
            >
              ✕
            </button>
          )}
        </div>

        {/* ── Expanded panel ── */}
        {isOpen && (
          <div
            className="relative overflow-hidden mt-[3px] flex flex-col gap-3"
            style={{
              width: 460,
              background: "rgba(9,9,20,0.93)",
              backdropFilter: "blur(28px) saturate(1.8)",
              border: "1px solid rgba(139,92,246,0.25)",
              borderRadius: 20,
              padding: "16px 18px 14px",
              boxShadow: "0 24px 64px rgba(0,0,0,0.65), 0 4px 24px rgba(139,92,246,0.13), inset 0 1px 0 rgba(255,255,255,0.07)",
              animation: "panelSlideIn 0.38s cubic-bezier(0.16,1,0.3,1) both",
            }}
          >
            {/* Ambient glow */}
            <div className="absolute top-0 left-0 right-0 h-20 pointer-events-none" style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(139,92,246,0.13) 0%, transparent 75%)" }} />

            {/* Header */}
            <div className="relative flex items-center justify-between">
              <span className="text-sm font-semibold" style={{
                background: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(196,181,253,0.9) 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}>
                Gemini Assistant
              </span>
              <span className="text-[10.5px] font-medium tracking-[0.08em] uppercase" style={{ color: "rgba(255,255,255,0.32)" }}>
                {{ idle: "Ready", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…" }[state]}
              </span>
            </div>

            {/* Mic waveform */}
            {state === "listening" && <div className="relative"><MicBars active={true} /></div>}

            {/* Thinking */}
            {state === "thinking" && <ThinkDots />}

            {/* Speaking */}
            {state === "speaking" && <SpeakWave />}

            {/* Transcript */}
            {transcript && (
              <div
                className="relative rounded-2xl px-4 py-3 text-[13px] max-h-28 overflow-y-auto"
                style={{
                  background: "rgba(255,255,255,0.042)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.82)",
                  lineHeight: 1.65,
                }}
              >
                {transcript}
              </div>
            )}

            {/* Type input */}
            {showInput && (
              <form onSubmit={handleSend} className="relative flex gap-2 items-center" style={{ animation: "slideUp 0.25s cubic-bezier(0.16,1,0.3,1) both" }}>
                <input
                  ref={inputRef}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  placeholder="Type a message…"
                  className="flex-1 rounded-full px-4 py-[9px] text-[13px] outline-none transition-all duration-200"
                  style={{
                    background: "rgba(255,255,255,0.065)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    color: "rgba(255,255,255,0.9)",
                  }}
                />
                <button
                  type="submit"
                  className="flex-shrink-0 w-[38px] h-[38px] rounded-full flex items-center justify-center transition-all duration-150 hover:scale-105 active:scale-95"
                  style={{ background: "linear-gradient(135deg, #8b5cf6, #6366f1)", boxShadow: "0 4px 14px rgba(139,92,246,0.45)" }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
              </form>
            )}

            {/* Error */}
            {error && (
              <div className="relative rounded-2xl px-4 py-3 text-xs" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5" }}>
                ⚠️ {error}
              </div>
            )}

            {/* Footer */}
            <div className="relative flex justify-end">
              <button
                onClick={() => setShowInput(v => !v)}
                className="text-[11px] font-medium px-3 py-[5px] rounded-xl transition-all duration-200"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.09)",
                  color: "rgba(255,255,255,0.35)",
                  letterSpacing: "0.04em",
                }}
              >
                ⌨ Type instead
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spinOrb {
          to { transform: rotate(360deg); }
        }
        @keyframes panelSlideIn {
          from { opacity: 0; transform: translateY(-14px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes speakWave {
          from { transform: scaleY(0.25); opacity: 0.5; }
          to   { transform: scaleY(1);    opacity: 1; }
        }
        @keyframes thinkDot {
          0%, 100% { transform: scale(0.6) translateY(0);    opacity: 0.35; }
          45%       { transform: scale(1.2) translateY(-8px); opacity: 1; }
          60%       { transform: scale(0.9) translateY(-3px); opacity: 0.9; }
        }
      `}</style>
    </>
  );
}
