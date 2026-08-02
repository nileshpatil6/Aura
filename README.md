<div align="center">

# Aura

### Your Windows desktop, voice-controlled by Gemini — and it actually touches the screen.

Not a chatbot in a window. A floating orb that listens, thinks, and then **moves your mouse, types your keys, and gets the task done** — while you watch it happen.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![Model](https://img.shields.io/badge/model-Gemini%203-8E44AD)
![License](https://img.shields.io/badge/license-Proprietary-lightgrey)

**[Get started](#getting-started)** · **[See what it does](#what-it-actually-does)** · **[How it works](#architecture)**

</div>

---

<!--
  DEMO_GIF_HERE — replace this block with a real screen recording before
  making the repo public. This is the single highest-leverage thing in this
  file: a 10-15s loop of the orb hearing a command and visibly clicking
  through a task. Record with ScreenToGif or OBS -> gifski, keep it under
  ~8MB, drop it in assets/demo.gif, then:
    ![Aura demo](assets/demo.gif)
  right here, above everything else.
-->

## What it actually does

You say: *"Open Notepad and write a haiku about deadlines."*

Aura doesn't reply with text describing what it would do. It:

1. Hears you — real-time, full-duplex voice over the Gemini Live API, no push-to-talk
2. Decides Notepad needs to open, and opens it
3. **Watches the screen, moves the cursor into the text field, and types the haiku itself**
4. Talks back, mid-task, while it's still working

That's the whole pitch. Most "AI assistants" stop at step 1. Aura is built around steps 2–4.

## Why this exists

Every voice assistant on the market can tell you the weather. None of them can actually *do* something on your machine — open the right app, click the right button, fill the right field — without you doing the clicking yourself. Aura closes that gap: it's a real computer-use agent wearing a voice interface, not a chat window with a microphone bolted on.

## Getting started

```bash
git clone https://github.com/nileshpatil6/Aura.git
cd Aura
npm install
npm start
```

Grab a free Gemini API key at [aistudio.google.com](https://aistudio.google.com), paste it into the Command Center's Settings tab on first launch, and talk to it.

Prefer not to build from source? Grab a prebuilt release: **Installer** (`Aura Setup.exe`) or **Portable** (`Aura.exe`, no install).

> Your API key lives only in local storage on your machine. It is never bundled with this repo, never transmitted anywhere but Google's API, and never shared between installs. Use your own.

## See it work

```
you   › "Find that PDF I was reading about the budget last week and open it"
aura  › [searches Recall, locates the file, opens it]
        "Found it — Q3_Budget_Draft.pdf, opened."

you   › "Apply to five frontend jobs on LinkedIn for me"
aura  › [Agent Console takes over — plans steps, clicks through applications,
         reports progress live]
        "Applied to 5. Two needed a cover letter — I flagged those for you."

you   › [click the orb, mid-sentence] "actually stop — mute for a sec"
aura  › [mutes instantly, mid-conversation, no delay]
```

Every line above is a real, working code path — not a mockup. `Recall` is background OCR search, `Agent Console` is the autonomous multi-step runner, the mute is instant because voice state and mute state are decoupled at the protocol level.

## Feature overview

### Overlay & voice

| Capability | Description |
|---|---|
| Floating pill | Transparent, click-through, always-on-top orb docked at the top-center of the screen |
| Live voice | Real-time, full-duplex conversation via the Gemini Live API — no push-to-talk |
| In-place mute | Click the active orb to mute/unmute mid-conversation, instantly |
| Live waveform | Rendered from real microphone input via Web Audio — not a canned animation |
| Mini-panel | Expands from the pill for transcript view and a text-input fallback |
| Auto-hide | Recedes to a thin glowing edge after 20s idle; reappears on hover |
| Dashboard sync | Voice state shared live between the pill and the Command Center |

### Command Center

A dedicated multi-tab window reachable from the tray or the pill:

| Tab | Purpose |
|---|---|
| Voice | Full-screen voice arena — an audio-reactive orb driven by real FFT data, plus a live oscilloscope |
| Conversation | Complete chat history with Aura |
| Activity Log | Timeline of every command, click, and tool invocation |
| System Monitor | Live CPU and memory statistics |
| Macros | Save a named goal once, replay it by name — by voice or text |
| Memory | Persistent name and notes, automatically woven into every conversation |
| Recall | Background screen capture with OCR, searchable in natural language |
| Agent Console | Long-running autonomous tasks with live, step-by-step progress |
| Settings | API key, voice selection, preferences |

### The part that makes this different: real computer use

- **Vision-driven UI control** — hand it any on-screen goal ("click submit," "scroll to the third result") and a dedicated agent plans and executes the clicks
- **Verified DPI-correct targeting** — coordinates are computed in true logical display space, so clicks land where they're aimed on scaled displays, not offset
- **Instant hotkeys** — chorded shortcuts fire without a vision pass at all (`ctrl+c`, `alt+tab`, `win+d`)
- **Bounded execution** — every action and every model request has a real timeout; nothing can silently hang the agent
- **Tool chaining** — opens an app, then hands the UI work to the computer-use agent in the same turn

### System & application automation

| Capability | Description |
|---|---|
| Application launcher | Opens any installed application by name |
| Shell execution | Arbitrary PowerShell for anything not covered by a dedicated tool |
| Web search | Opens a Google search or a specific URL directly |
| Media control | Play/pause, next/previous, mute |
| Volume & brightness | Set to an exact percentage |
| Window management | Focus, minimize all, or close an application by name |
| Power actions | Lock the screen or suspend the PC |
| Clipboard | Read, write, and a running history (`Ctrl+Shift+V`) |
| System info | Battery, memory, disk, processes, WiFi, IP, date/time |
| Notifications | Native Windows toast notifications on request |

### Contextual tools

| Shortcut | Behavior |
|---|---|
| `Ctrl+Shift+A` | Spotlight-style prompt over any application |
| `Ctrl+Shift+S` | Drag a screen region and ask about its contents |
| `Ctrl+Shift+E` | Ask about the current text selection directly |

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Toggle the pill | `Alt+Space` (falls back to `Ctrl+Shift+Space` / `Ctrl+Space`) |
| Agent Console | `Ctrl+Shift+Q` |
| Ask Aura anywhere | `Ctrl+Shift+A` |
| Region screenshot → ask | `Ctrl+Shift+S` |
| Ask about selected text | `Ctrl+Shift+E` |
| Clipboard history | `Ctrl+Shift+V` |
| Open Command Center | Tray menu, or the pill's dashboard button |
| Mute / unmute mic | Click the pill while a voice session is active |
| Expand / collapse panel | Chevron on the pill |

## Architecture

```
src/
├── main.js                    Electron main process — windows, IPC, global shortcuts, tray
├── preload.js                 contextBridge — the only IPC surface exposed to renderers
├── automation.js               PowerShell / Win32 automation layer
├── store.js                    electron-store wrapper — settings, memory, macros, history
├── vision-memory.js            Background capture + OCR pipeline for Recall
└── renderer/
    ├── index.html / app.js / style.css        The pill overlay and mini-panel
    ├── dashboard.html / dashboard.js / .css    Command Center (all tabs)
    ├── gemini-live.js          Gemini Live API client — WebSocket, audio I/O, tool dispatch
    ├── computer-use.js         Vision-driven click/type agent
    ├── agent.html              Autonomous Agent Console
    ├── ask.html                Spotlight-style prompt window
    ├── clips.html              Clipboard history viewer
    └── region.html             Screen region selector
```

**Window model.** The pill is a single frameless, transparent, always-on-top `BrowserWindow` that resizes between collapsed orb, wide voice pill, and expanded panel — measuring its own real content size and reporting it to the main process, never guessing pixel constants. The Command Center, Agent Console, Ask, and Clips surfaces are independent frameless windows created on demand.

**Voice pipeline.** `gemini-live.js` opens a WebSocket to the Gemini Live API (`gemini-3.1-flash-live-preview`), streaming 16 kHz PCM microphone audio out and 24 kHz PCM in. Tool calls returned over that same connection are dispatched through the identical IPC bridge every other automation path uses — voice and text share one execution surface, not two parallel implementations.

**Computer-use pipeline.** `computer-use.js` runs a screenshot → model → action loop against Gemini's built-in `computer_use` tool in `ENVIRONMENT_DESKTOP` mode. Every request, screenshot capture, and executed action is individually timed and bounded — a stalled network call or a wedged screenshot can't silently hang the agent, and every failure reports back to the model so it can adapt instead of dying.

## Technology stack

| Layer | Technology |
|---|---|
| Application shell | Electron 33 — frameless, transparent, always-on-top windows |
| Reasoning | Gemini 3 Flash (`gemini-3.6-flash`) with built-in computer use |
| Voice | Gemini Live API (`gemini-3.1-flash-live-preview`), full-duplex over WebSocket |
| Persistence | `electron-store` — settings, memory, macros, history, activity log |
| Audio analysis | Web Audio API (`AudioContext`, `AnalyserNode`) — real mic-driven visualization |
| Rendering | Canvas 2D — audio-reactive orb and oscilloscope waveform |
| System control | PowerShell + Win32 (P/Invoke via a persistent, warm session) |
| Screen capture | `desktopCapturer` |

## Building for distribution

```bash
npm run build            # NSIS installer + portable .exe
npm run build-portable   # portable .exe only
npm run pack              # unpacked directory, for local testing
```

Artifacts land in `dist/`.

## Security & privacy

- Your Gemini API key lives in local `electron-store` storage only — never written into source control, never bundled, never shared across installs.
- Recall (background screen capture) is opt-in and off by default; toggle it any time from the Command Center.
- `contextIsolation` and disabled `nodeIntegration` are enforced on every window; renderer processes never touch Node directly.
- **This software can move your mouse, type on your behalf, and execute shell commands based on a language model's output.** Supervise it, especially on anything consequential. It's a real agent, not a toy — treat it with the caution that implies.

---

<div align="center">

**Requirements:** Windows 10/11 x64 · internet connection · a free Gemini API key

If this is useful to you, a ⭐ helps more people find it.

</div>
