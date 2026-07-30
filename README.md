# Aura — AI Voice Assistant for Windows

Aura is an always-on AI assistant overlay for Windows. It lives as a small floating pill at the top of your screen, wakes up on a hotkey or a click, and lets you control your entire PC with voice or text — open apps, browse the web, run shell commands, click and type on screen, and carry out multi-step tasks autonomously while you watch.

![Aura](assets/preview.png)

---

## Why Aura

Most "AI assistants" on Windows are chat windows bolted onto a browser tab. Aura is different:

- It's a **native overlay**, not a webpage — always on top, click-through when idle, zero taskbar clutter.
- It doesn't just answer questions — it **acts**: opens apps, runs PowerShell, drives the mouse and keyboard, and completes autonomous multi-step goals.
- It has a **memory** — your name, notes, recent conversations, and saved macros persist across sessions and get fed back into every conversation.
- It's **voice-native**, powered by the Gemini Live API for real-time, low-latency, interruptible speech — not a record-then-transcribe hack.

## Features

### The pill (always-on overlay)
- Tiny floating orb docked at the top-center of your screen, transparent and click-through until you interact with it
- Click the orb to start a live voice session — real-time speech in, real-time speech out, no push-to-talk
- Click again while active to **mute/unmute** the mic instantly
- A compact live waveform appears in the pill itself while listening or speaking, driven by your actual mic input — not a fake animation
- Chevron button expands a full mini-panel below the pill: transcript, quick actions, and a text-input fallback
- Auto-hides to a thin glowing edge line at the top of the screen after 20s of inactivity; hover near it to bring the pill back
- Bidirectional state sync with the Command Center — start voice from either the pill or the dashboard and both stay in sync live

### Command Center (full dashboard)
A dedicated window (tray menu → Command Center, or the pill's dashboard button) with:
- **Voice** — a cinematic full-screen voice arena: a fluid audio-reactive orb (real FFT data, not canned animation) plus a live oscilloscope waveform, with Start/Stop controls
- **Conversation** — full chat history with Aura
- **Activity Log** — a timeline of every command, click, and tool call Aura has executed
- **System Monitor** — live CPU/RAM and system stats
- **Macros** — save a named goal once ("apply to jobs on LinkedIn") and replay it by name via voice or text later
- **Aura's Memory** — teach Aura your name and freeform notes that get woven into its system prompt automatically
- **Photographic Memory (Recall)** — background screen capture on an interval, OCR'd and searchable ("find that doc I was reading about budgets last Tuesday")
- **Autonomous Agent** — a dedicated console for long-running, multi-step autonomous goals with live step-by-step progress
- **Settings** — API key, voice selection, and preferences

### Autonomous computer control
Aura doesn't just talk — it can see and operate your screen:
- **`do_computer_task`** hands any UI goal ("click submit", "scroll down and open the third result") to a dedicated vision-driven click/type agent
- **`press_key`** for instant hotkeys (`ctrl+c`, `alt+tab`, `win+d`, etc.)
- **`capture_screen`** so Aura can see exactly what you're looking at before acting
- Combines tools naturally — open an app, then hand off the UI work to the computer-use agent

### System & app automation
- **Open any installed app** by name — WhatsApp, Chrome, Spotify, VS Code, Discord, Steam, Notepad, Settings, anything
- **Run arbitrary PowerShell** for whatever isn't covered by a dedicated tool — file management, weather, custom scripts
- **Web search** — opens a Google search or a specific URL directly
- **Media control** — play/pause, next/prev, volume, mute
- **Volume & brightness** — set to an exact percentage
- **Window management** — focus, minimize all, or close an app by name
- **Power actions** — lock the screen or sleep the PC
- **Clipboard** — read or write, plus a running clipboard history (`Ctrl+Shift+V`)
- **System info on demand** — battery, memory, disk, running processes, WiFi, IP, time/date
- **Windows toast notifications** triggered by voice or text

### Ask Anywhere & Region Ask
- **`Ctrl+Shift+A`** — a Spotlight-style prompt over any app, anywhere. Type a question, get an answer, no context switch.
- **`Ctrl+Shift+S`** — drag a screen region and ask about it. Foreign text, a cryptic error, a confusing chart — screenshot it and ask.
- **`Ctrl+Shift+E`** — grabs your current text selection and asks about it directly.

## Setup

### 1. Get a Gemini API key
Go to [aistudio.google.com](https://aistudio.google.com), create a key, and copy it.

> ⚠️ Never commit your API key to source control. Aura stores it locally via `electron-store`, outside the repo.

### 2. Install or run

**Option A — Installer**
Run `dist/Aura Setup 1.0.0.exe` and install normally.

**Option B — Portable**
Run `dist/Aura 1.0.0.exe` directly, no install needed.

**Option C — From source**
```bash
npm install
npm start
```

### 3. Enter your API key
First launch opens the Command Center automatically. Go to **Settings**, paste your Gemini API key, pick a voice, and save. You can change it any time from the same tab, or via the pill's ⚙ button.

## Usage

| Action | Shortcut |
|---|---|
| Toggle Aura pill | `Alt+Space` (falls back to `Ctrl+Shift+Space` / `Ctrl+Space` if taken) |
| 🤖 Agent Console (autonomous mode) | `Ctrl+Shift+Q` |
| 💬 Ask Aura anywhere (Spotlight) | `Ctrl+Shift+A` |
| 📸 Region screenshot → ask | `Ctrl+Shift+S` |
| Ask about selected text | `Ctrl+Shift+E` |
| 📋 Clipboard history | `Ctrl+Shift+V` |
| Command Center | tray menu, or the pill's dashboard button |
| Mute/unmute mic mid-conversation | click the pill orb while voice is active |
| Expand/collapse the mini-panel | chevron button on the pill |

## Example commands

- "Open WhatsApp"
- "Search for flights to Goa"
- "What's my battery level?"
- "Open Chrome and go to YouTube"
- "Create a folder called Projects on my desktop"
- "Set volume to 50%"
- "What processes are using the most CPU?"
- "Take a screenshot and tell me what's on my screen"
- "Apply to 5 frontend jobs on LinkedIn" *(Agent Console)*
- "Run my 'morning setup' macro"
- "Find that document I was reading about budgets last Tuesday" *(Photographic Memory)*

## Building

```bash
npm run build          # NSIS installer + portable .exe
npm run build-portable # portable .exe only
npm run pack           # unpacked dir, for quick local testing
```

Outputs to `dist/`.

## Architecture

```
src/
├── main.js            Electron main process — windows, IPC, global shortcuts, tray
├── preload.js          contextBridge: safe IPC surface exposed to renderers
├── automation.js        PowerShell / Win32 automation (apps, media, power, clipboard, system info)
├── store.js             electron-store wrapper — settings, memory, macros, history, activity
├── vision-memory.js      Background screen capture + OCR for Photographic Memory
└── renderer/
    ├── index.html/.js/.css   The pill overlay + mini-panel
    ├── dashboard.html/.js/.css  Command Center (all tabs)
    ├── gemini-live.js     Gemini Live API client — WebSocket, audio I/O, tool dispatch
    ├── computer-use.js    Vision-driven click/type agent for do_computer_task
    ├── agent.html         Autonomous Agent Console
    ├── ask.html            Ask Anywhere (Spotlight-style prompt)
    ├── clips.html          Clipboard history viewer
    └── region.html         Screen region selector
```

**Windows:** the pill is a frameless, transparent, always-on-top `BrowserWindow` that resizes itself between a collapsed orb, a wider "voice pill" (waveform visible), and an expanded mini-panel — all via `setBounds`, driven by IPC from the renderer. The Command Center, Agent Console, Ask, and Clips windows are separate frameless windows created on demand.

**Voice:** `gemini-live.js` opens a WebSocket to the Gemini Live API (`models/gemini-3.1-flash-live-preview`), streams 16kHz PCM mic audio in and 24kHz PCM audio out, and dispatches Gemini's tool calls back through the same IPC bridge used everywhere else.

## Tech stack

- **Electron 33** — frameless, transparent, always-on-top overlay windows
- **Gemini 3 Flash** (`gemini-3-flash-preview`) — text/reasoning
- **Gemini Live API** (`gemini-3.1-flash-live-preview`) — real-time bidirectional voice over WebSocket
- **electron-store** — persistent settings, memory, macros, history, activity log
- **Web Audio API** — `AudioContext` + `AnalyserNode` for real mic-driven visualizations (no fake CSS waves)
- **Canvas 2D** — audio-reactive fluid blob orb and oscilloscope waveform in the Command Center
- **PowerShell + Win32 (via SendKeys/P-Invoke)** — app launching, media/volume/brightness control, clipboard, power actions
- **`desktopCapturer`** — screenshots for vision-based tools and Photographic Memory

## Requirements

- Windows 10/11 x64
- Internet connection
- A Gemini API key (the free tier works)

## Security note

Your API key is stored locally on your machine via `electron-store` and is never committed to this repository. If you fork or clone this project, generate your own key at [aistudio.google.com](https://aistudio.google.com) — never share or commit yours.
