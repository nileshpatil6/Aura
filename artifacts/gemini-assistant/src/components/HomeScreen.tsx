import { useState, useEffect } from "react";

function Clock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="text-center">
      <div
        className="font-thin tracking-[0.12em]"
        style={{ fontSize: 72, color: "rgba(255,255,255,0.07)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}
      >
        {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
      <div
        className="mt-2 text-sm tracking-[0.25em] uppercase font-light"
        style={{ color: "rgba(255,255,255,0.04)" }}
      >
        {time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
      </div>
    </div>
  );
}

export default function HomeScreen() {
  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center relative overflow-hidden select-none"
      style={{ background: "linear-gradient(160deg, #060610 0%, #0a0818 40%, #080c18 100%)" }}
    >
      {/* Subtle ambient orbs in background */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(99,102,241,0.04) 0%, transparent 70%)",
          top: "10%",
          left: "20%",
          filter: "blur(40px)",
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          width: 500,
          height: 500,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(139,92,246,0.05) 0%, transparent 70%)",
          bottom: "10%",
          right: "15%",
          filter: "blur(50px)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-16">
        <Clock />

        <div className="text-center space-y-3">
          <h1
            className="text-base font-medium tracking-[0.5em] uppercase"
            style={{ color: "rgba(255,255,255,0.09)" }}
          >
            Gemini Assistant
          </h1>
          <div className="flex items-center gap-3 justify-center">
            <div className="h-px w-16" style={{ background: "rgba(255,255,255,0.05)" }} />
            <p
              className="text-xs tracking-[0.3em] uppercase"
              style={{ color: "rgba(255,255,255,0.06)" }}
            >
              Press Ctrl+Space
            </p>
            <div className="h-px w-16" style={{ background: "rgba(255,255,255,0.05)" }} />
          </div>
        </div>

        {/* Feature pills */}
        <div className="flex items-center gap-4">
          {[
            { label: "Voice", icon: "🎙", desc: "Live voice" },
            { label: "Text",  icon: "⌨",  desc: "Type messages" },
            { label: "Smart", icon: "✦",  desc: "Gemini 2.0" },
          ].map(({ label, icon, desc }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-2 px-5 py-4 rounded-2xl"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.04)",
              }}
            >
              <span style={{ fontSize: 18, opacity: 0.25 }}>{icon}</span>
              <span className="text-xs font-medium tracking-wider" style={{ color: "rgba(255,255,255,0.1)" }}>{label}</span>
              <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.05)" }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="absolute bottom-6 text-[10px] tracking-[0.3em] uppercase"
        style={{ color: "rgba(255,255,255,0.04)" }}
      >
        Powered by Gemini 2.0 Flash Live
      </div>
    </div>
  );
}
