import { useState, useRef, useEffect } from "react";
import { useGeminiLive } from "@/hooks/useGeminiLive";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";
import { useAudioVisualizer } from "@/hooks/useAudioVisualizer";

const SHORTCUT_KEY = " ";
const SHORTCUT_CTRL = true;

function WaveformBars({ bars, color }: { bars: number[]; color: string }) {
  return (
    <div className="flex items-center gap-[2px] h-8">
      {bars.map((h, i) => (
        <div
          key={i}
          className="rounded-full transition-all duration-75"
          style={{
            width: 3,
            height: `${Math.max(6, h * 32)}px`,
            background: color,
            opacity: 0.7 + h * 0.3,
          }}
        />
      ))}
    </div>
  );
}

function PulsingOrb({ state }: { state: string }) {
  const colors: Record<string, string> = {
    idle: "#6366f1",
    listening: "#8b5cf6",
    thinking: "#3b82f6",
    speaking: "#06b6d4",
  };
  const color = colors[state] || "#6366f1";

  return (
    <div className="relative flex items-center justify-center" style={{ width: 44, height: 44 }}>
      {state !== "idle" && (
        <>
          <div
            className="absolute rounded-full animate-ping"
            style={{
              width: 44,
              height: 44,
              background: color,
              opacity: 0.2,
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: 36,
              height: 36,
              background: color,
              opacity: 0.15,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        </>
      )}
      <div
        className="rounded-full flex items-center justify-center transition-all duration-300"
        style={{
          width: 32,
          height: 32,
          background: `radial-gradient(circle at 40% 35%, ${color}cc, ${color})`,
          boxShadow: state !== "idle" ? `0 0 20px ${color}88` : "none",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
          {state === "listening" ? (
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V22H8v2h8v-2h-3v-1.06A9 9 0 0 0 21 12v-2h-2z" />
          ) : state === "speaking" ? (
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          ) : state === "thinking" ? (
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
          ) : (
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
          )}
        </svg>
      </div>
    </div>
  );
}

function StatusLabel({ state }: { state: string }) {
  const labels: Record<string, string> = {
    idle: "Press Ctrl+Space",
    listening: "Listening...",
    thinking: "Thinking...",
    speaking: "Speaking...",
  };
  return (
    <span className="text-xs font-medium tracking-wide" style={{ color: "rgba(255,255,255,0.6)" }}>
      {labels[state] || state}
    </span>
  );
}

export default function GeminiOverlay() {
  const { state, transcript, error, activate, deactivate, sendText } = useGeminiLive();
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bars = useAudioVisualizer(isOpen && state === "listening");

  const toggle = async () => {
    if (isOpen) {
      setIsOpen(false);
      setShowInput(false);
      setInputText("");
      deactivate();
    } else {
      setIsOpen(true);
      await activate();
    }
  };

  useKeyboardShortcut({ key: SHORTCUT_KEY, ctrlKey: SHORTCUT_CTRL }, toggle);

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      sendText(inputText.trim());
      setInputText("");
      setShowInput(false);
    }
  };

  useEffect(() => {
    if (showInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showInput]);

  const isActive = isOpen && state !== "idle";

  return (
    <>
      <div
        className="fixed top-0 left-1/2 z-50 flex flex-col items-center"
        style={{ transform: "translateX(-50%)" }}
      >
        <div
          className="relative overflow-hidden transition-all duration-500 ease-out"
          style={{
            background: isOpen
              ? "linear-gradient(135deg, rgba(10,10,20,0.95) 0%, rgba(20,15,40,0.95) 100%)"
              : "linear-gradient(135deg, rgba(10,10,20,0.9) 0%, rgba(20,15,40,0.9) 100%)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            border: isOpen
              ? "1px solid rgba(139,92,246,0.4)"
              : "1px solid rgba(99,102,241,0.3)",
            boxShadow: isOpen
              ? "0 8px 40px rgba(139,92,246,0.3), 0 0 0 1px rgba(139,92,246,0.1), inset 0 1px 0 rgba(255,255,255,0.05)"
              : "0 4px 20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
            borderRadius: isOpen ? "0 0 24px 24px" : "0 0 20px 20px",
            width: isOpen ? 420 : 160,
            paddingTop: 6,
            paddingBottom: isOpen ? 16 : 6,
            paddingLeft: isOpen ? 20 : 16,
            paddingRight: isOpen ? 20 : 16,
          }}
        >
          {isOpen && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(ellipse at 50% 0%, rgba(139,92,246,0.15) 0%, transparent 70%)",
              }}
            />
          )}

          <div className="relative flex items-center gap-3">
            <PulsingOrb state={isOpen ? state : "idle"} />

            {isOpen ? (
              <div className="flex-1 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span
                    className="text-sm font-semibold"
                    style={{ color: "rgba(255,255,255,0.9)" }}
                  >
                    Gemini Assistant
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowInput((v) => !v)}
                      className="rounded-full px-2 py-0.5 text-xs transition-all hover:bg-white/10"
                      style={{ color: "rgba(255,255,255,0.5)" }}
                      title="Type instead"
                    >
                      ⌨️
                    </button>
                    <button
                      onClick={toggle}
                      className="rounded-full w-5 h-5 flex items-center justify-center transition-all hover:bg-white/10"
                      style={{ color: "rgba(255,255,255,0.4)" }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <StatusLabel state={state} />
              </div>
            ) : (
              <button
                onClick={toggle}
                className="flex-1 text-center"
                style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}
              >
                Ctrl+Space
              </button>
            )}
          </div>

          {isOpen && (
            <div className="relative mt-3 space-y-3">
              {state === "listening" && (
                <div className="flex items-center justify-center py-1">
                  <WaveformBars bars={bars} color="#8b5cf6" />
                </div>
              )}

              {state === "thinking" && (
                <div className="flex items-center justify-center gap-1.5 py-2">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="rounded-full"
                      style={{
                        width: 8,
                        height: 8,
                        background: "#3b82f6",
                        animation: `bounce 1s ease-in-out ${i * 0.15}s infinite`,
                      }}
                    />
                  ))}
                </div>
              )}

              {state === "speaking" && (
                <div className="flex items-center justify-center gap-[3px] py-1">
                  {Array(24)
                    .fill(0)
                    .map((_, i) => (
                      <div
                        key={i}
                        className="rounded-full"
                        style={{
                          width: 3,
                          height: 4 + Math.sin((i / 24) * Math.PI) * 20,
                          background: "#06b6d4",
                          opacity: 0.6 + Math.sin((i / 24) * Math.PI) * 0.4,
                          animation: `speakBar 0.6s ease-in-out ${(i * 0.025).toFixed(3)}s infinite alternate`,
                        }}
                      />
                    ))}
                </div>
              )}

              {transcript && (
                <div
                  className="rounded-2xl px-4 py-3 text-sm max-h-32 overflow-y-auto"
                  style={{
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.85)",
                    lineHeight: 1.6,
                  }}
                >
                  {transcript}
                </div>
              )}

              {showInput && (
                <form onSubmit={handleTextSubmit} className="flex gap-2">
                  <input
                    ref={inputRef}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Type a message..."
                    className="flex-1 rounded-full px-4 py-2 text-sm outline-none"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.15)",
                      color: "rgba(255,255,255,0.9)",
                    }}
                  />
                  <button
                    type="submit"
                    className="rounded-full w-9 h-9 flex items-center justify-center transition-all hover:opacity-80"
                    style={{ background: "#8b5cf6" }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                    </svg>
                  </button>
                </form>
              )}

              {error && (
                <div
                  className="rounded-2xl px-4 py-3 text-xs"
                  style={{
                    background: "rgba(239,68,68,0.15)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    color: "#fca5a5",
                  }}
                >
                  ⚠️ {error}
                </div>
              )}
            </div>
          )}
        </div>

        {!isOpen && (
          <div
            className="mt-1 rounded-full"
            style={{
              width: 40,
              height: 3,
              background: "rgba(99,102,241,0.4)",
            }}
          />
        )}
      </div>

      <style>{`
        @keyframes speakBar {
          from { transform: scaleY(0.3); }
          to { transform: scaleY(1); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); opacity: 0.4; }
          50% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 0.15; }
          50% { transform: scale(1.15); opacity: 0.25; }
        }
      `}</style>
    </>
  );
}
