<div align="center">

# Aura

### The real-world Jarvis for your PC.

**An AI that *uses* your computer — not one that talks about using your computer.**

Say it out loud. Aura sees your screen, plans the steps, then **moves the mouse, types the keys, and finishes the job** — shopping carts, code, research, file wrangling, whatever you were about to do yourself.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![Model](https://img.shields.io/badge/model-Gemini%203-8E44AD)
![License](https://img.shields.io/badge/license-Proprietary-lightgrey)

**[What it can do](#what-you-can-actually-ask-it) · [Get started](#getting-started) · [How it works](#architecture)**

</div>

---

<!--
  DEMO_GIF_HERE — replace this comment with a real screen recording before
  going public. Highest-leverage thing in this file: a 10-15s silent loop of
  the orb hearing a command and visibly clicking through a task.
  Record with ScreenToGif or OBS -> gifski, keep under ~8MB, save to
  assets/demo.gif, then put:  ![Aura demo](assets/demo.gif)  right here.
-->

## The difference

| Ordinary voice assistant | Aura |
|---|---|
| "Here's how to order coffee filters on Amazon…" | *Opens Chrome, searches, picks the item, fills the cart, stops at payment for your OK* |
| "I can't see your screen." | *Looks at your screen mid-sentence and answers about what's on it* |
| "Here's a code snippet, copy it." | *Reads the error on your screen, clicks into your editor, types the fix* |
| Forgets everything you did | *Remembers what was on your screen last Tuesday and finds it* |
| Answers one question, then stops | *Plans 3–8 steps and executes them one after another, showing live progress* |

## What you can actually ask it

Every example below maps to a real, working code path in this repo — not a roadmap.

### Get things done on the web

```
"Order coffee filters on Amazon"
"Book a table for two on Friday"
"Apply to five frontend jobs on LinkedIn"
"Fill out this form with my details"
```

The **Agent Console** breaks the goal into concrete steps, then executes each one by actually clicking and typing. You watch the plan tick over live, step by step, with screenshots. It stops and asks before anything irreversible — payments, sending messages, accepting terms.

### Ride shotgun while you code

```
"What's this error on my screen?"
"Open my project in VS Code"
"Run the test suite and tell me what broke"
"Copy this stack trace and search it"
```

It captures your actual screen, reads it, and can drive your editor or terminal directly. PowerShell execution means it can run builds, inspect processes, or manage files — and report back what happened, out loud.

### Ask about anything you can see

```
Ctrl+Shift+S   → drag a box around anything → "what does this mean?"
Ctrl+Shift+E   → select text anywhere → instant explanation
Ctrl+Shift+A   → Spotlight-style prompt over any app
```

Foreign text, a cryptic error dialog, a dense chart, a legal clause. Drag, ask, done — without leaving what you were doing.

### Remember things you'd forget

```
"Find that PDF about the budget I was reading last week"
"What was that library I had open on Tuesday?"
```

**Recall** quietly snapshots your screen in the background, has Gemini describe and index each frame, and makes weeks of your own screen history searchable in plain language. Opt-in, off by default, stored entirely on your machine.

### Run your machine by voice

```
"Set volume to 30 and open Spotify"
"What's eating my CPU?"
"Minimize everything and lock the screen"
"Make a folder called Invoices on my desktop"
"Save this as a macro called morning setup"
```

Apps, volume, brightness, windows, clipboard, power, battery, disk, WiFi — plus **macros**: teach it a multi-step routine once, then trigger it by name forever.

## Why it's different under the hood

**It genuinely sees and acts.** Aura uses Gemini 3's built-in `computer_use` tool in desktop mode — a real vision→action loop, screenshot in, mouse coordinates out. Not a scripted macro recorder, not a wrapper around keyboard shortcuts.

**Voice is truly live.** Full-duplex WebSocket streaming over the Gemini Live API. Interrupt it mid-sentence. It talks back *while* it's working. No push-to-talk, no record-then-transcribe lag.

**Clicks land where they're aimed.** Coordinates are computed in true logical display space, verified to 0px error on scaled (125%/150%) displays — the thing most computer-use demos quietly get wrong.

**It can't hang.** Every model request, screenshot, and executed action is individually bounded with real timeouts. A stalled network call can't wedge the agent, and every failure is reported back to the model so it can adapt instead of dying.

**It runs to completion, on its own.** Gemini's safety layer flags financial transactions, message sending, and legal agreements. Aura acknowledges those flags and keeps going rather than stopping to ask. That is deliberate: a task you started finishes without babysitting. It also means Aura can complete a purchase or send a message by itself, so treat it like something with your hands on the keyboard, not a sandbox.

## Getting started

```bash
git clone https://github.com/nileshpatil6/Aura.git
cd Aura
npm install
npm start
```

Grab a free Gemini API key at [aistudio.google.com](https://aistudio.google.com), paste it into the Command Center's **Settings** tab on first launch, and start talking.

Prefer a binary? Build one with `npm run build` — you get an installer and a portable `.exe`.

> Your API key is stored only in local `electron-store` data on your machine. It never enters this repo, never goes anywhere but Google's API, and isn't shared between installs.

## The interface

**The pill.** A transparent, always-on-top orb docked at the top of your screen. Click to talk. It shows a live waveform driven by your actual microphone input, mutes instantly mid-conversation on click, and slips away to a thin glowing edge after 20s idle — reappearing when your cursor comes near.

**The Command Center.** A full console behind it:

| Tab | Purpose |
|---|---|
| Voice | Full-screen voice arena — audio-reactive orb on real FFT data, live oscilloscope |
| Conversation | Complete chat history |
| Activity Log | Timeline of every command, click, and tool invocation |
| System Monitor | Live CPU and memory |
| Macros | Save a goal once, replay it by name forever |
| Memory | Your name and notes, woven into every conversation automatically |
| Recall | Searchable background screen history |
| Agent Console | Autonomous multi-step tasks with live progress |
| Settings | API key, voice, preferences |

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Toggle the pill | `Alt+Space` (falls back to `Ctrl+Shift+Space` / `Ctrl+Space`) |
| Agent Console | `Ctrl+Shift+Q` |
| Ask Aura anywhere | `Ctrl+Shift+A` |
| Region screenshot → ask | `Ctrl+Shift+S` |
| Ask about selected text | `Ctrl+Shift+E` |
| Clipboard history | `Ctrl+Shift+V` |
| Mute / unmute mic | Click the pill during a voice session |
| Expand / collapse panel | Chevron on the pill |

## Architecture

```
src/
├── main.js                    Electron main — windows, IPC, global shortcuts, tray
├── preload.js                 contextBridge — the only IPC surface exposed to renderers
├── automation.js               PowerShell / Win32 layer (persistent warm session)
├── store.js                    electron-store — settings, memory, macros, history
├── vision-memory.js            Background capture + indexing for Recall
└── renderer/
    ├── index.html / app.js / style.css        Pill overlay and mini-panel
    ├── dashboard.html / dashboard.js / .css    Command Center
    ├── gemini-live.js          Live API client — WebSocket, audio I/O, tool dispatch
    ├── computer-use.js         Vision-driven click/type agent
    ├── agent.html              Autonomous Agent Console
    ├── ask.html                Spotlight-style prompt
    ├── clips.html              Clipboard history
    └── region.html             Screen region selector
```

**Window model.** The pill is one frameless, transparent, always-on-top `BrowserWindow` that measures its own rendered content and reports the real size to the main process — no hardcoded pixel constants. Command Center, Agent Console, Ask, and Clips are independent windows created on demand.

**Voice pipeline.** `gemini-live.js` streams 16 kHz PCM out and 24 kHz PCM in over a WebSocket to `gemini-3.1-flash-live-preview`, exposing 15 tools. Tool calls dispatch through the same IPC bridge every other automation path uses — voice and text share one execution surface, not two implementations.

**Computer-use pipeline.** `computer-use.js` runs a screenshot → model → action loop against Gemini's `computer_use` tool in `ENVIRONMENT_DESKTOP`. Screenshots are captured at the display's true aspect ratio and sized for latency; coordinates are denormalized into logical display space; every await is individually bounded.

## Technology stack

| Layer | Technology |
|---|---|
| Shell | Electron 33 — frameless, transparent, always-on-top |
| Reasoning | Gemini 3 Flash (`gemini-3.6-flash`) with built-in computer use |
| Voice | Gemini Live API (`gemini-3.1-flash-live-preview`), full-duplex WebSocket |
| Persistence | `electron-store` |
| Audio | Web Audio API — real mic-driven FFT visualization |
| Rendering | Canvas 2D — audio-reactive orb and oscilloscope |
| System control | PowerShell + Win32 P/Invoke via a persistent warm session |
| Capture | `desktopCapturer` |

## Building

```bash
npm run build            # NSIS installer + portable .exe
npm run build-portable   # portable only
npm run pack             # unpacked dir, for local testing
```

## Security & privacy

- Your API key lives in local storage only — never in this repo, never shared between installs.
- Recall is **opt-in and off by default**. Snapshots stay on your machine.
- `contextIsolation` on and `nodeIntegration` off for every window; renderers never touch Node directly.
- **This software moves your mouse, types on your behalf, and runs shell commands based on model output.** It runs autonomously and does **not** pause for confirmation, including on payments, message sending, and legal agreements. Watch it on anything that matters, and don't leave it running unattended on a machine with saved cards or logged-in accounts you care about. It's a real agent, not a toy.

---

<div align="center">

### Built to be the Jarvis we were promised — one that actually presses the buttons.

**Windows 10/11 x64 · internet connection · a free Gemini API key**

If this is useful to you, a ⭐ helps other people find it.

</div>
