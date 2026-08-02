<div align="center">

# Aura

**An always-on, voice-native AI assistant overlay for Windows.**

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![Model](https://img.shields.io/badge/model-Gemini%203-8E44AD)
![License](https://img.shields.io/badge/license-Proprietary-lightgrey)

</div>

---

## Overview

Aura is a native desktop overlay, not a browser tab. It runs as a small, transparent, always-on-top pill docked at the top of the screen, and expands on demand into a full **Command Center** — a multi-tab console for conversation, system automation, memory, and autonomous task execution.

Unlike assistants that only answer questions, Aura is built to **act**: it opens applications, executes shell commands, drives the mouse and keyboard through a vision-based agent, and carries out multi-step goals autonomously while surfacing live progress. Voice is handled natively through the Gemini Live API — real-time, full-duplex, interruptible speech, not a record-then-transcribe workaround.

## Contents

- [Feature overview](#feature-overview)
- [Getting started](#getting-started)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Example commands](#example-commands)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Building for distribution](#building-for-distribution)
- [Security & privacy](#security--privacy)

## Feature overview

### Overlay & voice

| Capability | Description |
|---|---|
| Floating pill | Transparent, click-through, always-on-top orb docked at the top-center of the screen |
| Live voice | Real-time, full-duplex conversation via the Gemini Live API — no push-to-talk |
| In-place mute | Click the active orb to mute/unmute the microphone mid-conversation |
| Live waveform | Compact waveform rendered from real microphone input, not a simulated animation |
| Mini-panel | Expands from the pill for transcript view and a text-input fallback |
| Auto-hide | Recedes to a thin edge indicator after 20s idle; reappears on hover |
| Dashboard sync | Voice state is shared live between the pill and the Command Center |

### Command Center

A dedicated multi-tab window reachable from the tray or the pill:

| Tab | Purpose |
|---|---|
| Voice | Full-screen voice arena — an audio-reactive orb driven by real FFT data, plus a live oscilloscope waveform |
| Conversation | Complete chat history with Aura |
| Activity Log | Timeline of every command, click, and tool invocation |
| System Monitor | Live CPU and memory statistics |
| Macros | Save a named goal once and replay it by name, by voice or text |
| Memory | Persistent name and notes, automatically woven into every conversation |
| Recall | Background screen capture with OCR, searchable in natural language |
| Agent Console | Long-running autonomous tasks with live, step-by-step progress |
| Settings | API key, voice selection, and preferences |

### Autonomous computer control

Aura can operate the desktop directly, not just describe what to do:

- **Vision-driven UI control** — hands any on-screen goal ("click submit", "scroll to the third result") to a dedicated click/type agent
- **Instant hotkeys** — single-key or chorded shortcuts executed without vision (`ctrl+c`, `alt+tab`, `win+d`)
- **Screen capture on demand** — Aura can see exactly what the user is looking at before acting
- **Tool chaining** — opens an application, then hands the UI work to the computer-use agent in the same turn

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
| System info | Battery, memory, disk, running processes, WiFi, IP, date/time |
| Notifications | Native Windows toast notifications on request |

### Contextual tools

| Shortcut | Behavior |
|---|---|
| `Ctrl+Shift+A` | Spotlight-style prompt over any application |
| `Ctrl+Shift+S` | Drag a screen region and ask about its contents |
| `Ctrl+Shift+E` | Ask about the current text selection directly |

## Getting started

### Prerequisites

- Windows 10 or 11, x64
- An active internet connection
- A Gemini API key — obtain one at [aistudio.google.com](https://aistudio.google.com)

### Installation

**Installer** — run `dist/Aura Setup 1.0.0.exe`.

**Portable** — run `dist/Aura 1.0.0.exe` directly; no installation required.

**From source**

```bash
npm install
npm start
```

### Configuration

On first launch, the Command Center opens automatically. Open **Settings**, paste the Gemini API key, choose a voice, and save. The key can be changed at any time from the same tab, or from the pill's settings button.

> The API key is stored locally via `electron-store` and is never bundled with or committed to this repository. Generate your own key rather than reusing one from elsewhere.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Toggle the pill | `Alt+Space` (falls back to `Ctrl+Shift+Space` or `Ctrl+Space` if unavailable) |
| Agent Console (autonomous mode) | `Ctrl+Shift+Q` |
| Ask Aura anywhere | `Ctrl+Shift+A` |
| Region screenshot → ask | `Ctrl+Shift+S` |
| Ask about selected text | `Ctrl+Shift+E` |
| Clipboard history | `Ctrl+Shift+V` |
| Open Command Center | Tray menu, or the pill's dashboard button |
| Mute / unmute microphone | Click the pill while a voice session is active |
| Expand / collapse mini-panel | Chevron button on the pill |

## Example commands

```
Open WhatsApp
Search for flights to Goa
What's my battery level?
Open Chrome and go to YouTube
Create a folder called Projects on my desktop
Set volume to 50%
What processes are using the most CPU?
Take a screenshot and tell me what's on my screen
Apply to 5 frontend jobs on LinkedIn         (Agent Console)
Run my "morning setup" macro
Find that document I was reading about budgets last Tuesday   (Recall)
```

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

**Window model.** The pill is a single frameless, transparent, always-on-top `BrowserWindow` that resizes between three states — collapsed orb, wider voice pill with waveform, and expanded mini-panel — via `setBounds`, coordinated entirely through IPC. The Command Center, Agent Console, Ask, and Clips surfaces are independent frameless windows created on demand and torn down on close.

**Voice pipeline.** `gemini-live.js` opens a WebSocket to the Gemini Live API (`gemini-3.1-flash-live-preview`), streaming 16 kHz PCM microphone audio outbound and 24 kHz PCM audio inbound. Tool calls returned over the same connection are dispatched through the identical IPC bridge used by every other automation path, so voice and text commands share one execution surface.

## Technology stack

| Layer | Technology |
|---|---|
| Application shell | Electron 33 — frameless, transparent, always-on-top windows |
| Reasoning | Gemini 3 Flash (`gemini-3.6-flash`) |
| Voice | Gemini Live API (`gemini-3.1-flash-live-preview`), full-duplex over WebSocket |
| Persistence | `electron-store` — settings, memory, macros, history, activity log |
| Audio analysis | Web Audio API (`AudioContext`, `AnalyserNode`) — real microphone-driven visualization |
| Rendering | Canvas 2D — audio-reactive orb and oscilloscope waveform |
| System control | PowerShell and Win32 (via SendKeys / P-Invoke) |
| Screen capture | `desktopCapturer` |

## Building for distribution

```bash
npm run build            # NSIS installer + portable .exe
npm run build-portable   # portable .exe only
npm run pack              # unpacked directory, for local testing
```

Build artifacts are emitted to `dist/`.

## Security & privacy

- The Gemini API key is stored locally through `electron-store` and is never written into source control.
- Anyone building from source must supply their own key; keys are not transferable between forks or shared.
- Recall (background screen capture) is opt-in and disabled by default; it can be toggled off at any time from the Command Center.

---

<div align="center">

**Requirements:** Windows 10/11 x64 · internet connection · Gemini API key

</div>
