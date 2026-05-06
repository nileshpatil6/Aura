export default function HomeScreen() {
  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center select-none"
      style={{
        background: "linear-gradient(135deg, #0a0a14 0%, #0f0a1e 40%, #0a1020 100%)",
      }}
    >
      <div className="text-center space-y-6 px-8">
        <div
          className="text-6xl font-thin tracking-widest"
          style={{ color: "rgba(255,255,255,0.08)" }}
        >
          {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>

        <div className="space-y-2">
          <h1
            className="text-xl font-light tracking-[0.3em] uppercase"
            style={{ color: "rgba(255,255,255,0.15)" }}
          >
            Gemini Assistant
          </h1>
          <p
            className="text-sm tracking-widest"
            style={{ color: "rgba(255,255,255,0.08)" }}
          >
            Press Ctrl+Space to activate
          </p>
        </div>

        <div className="flex items-center justify-center gap-8 pt-4">
          {["Voice", "Text", "Smart"].map((feature) => (
            <div key={feature} className="text-center space-y-2">
              <div
                className="w-10 h-10 rounded-2xl mx-auto flex items-center justify-center"
                style={{ background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.15)" }}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: "rgba(139,92,246,0.4)" }}
                />
              </div>
              <span
                className="text-xs tracking-wider"
                style={{ color: "rgba(255,255,255,0.12)" }}
              >
                {feature}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="fixed bottom-8 left-1/2 -translate-x-1/2 text-xs tracking-widest text-center"
        style={{ color: "rgba(255,255,255,0.06)" }}
      >
        POWERED BY GEMINI 2.0 FLASH LIVE
      </div>
    </div>
  );
}
