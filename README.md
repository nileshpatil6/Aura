# Aura — AI Voice Assistant for Windows

Aura is an always-on AI assistant overlay for Windows. It sits as a small orb at the top of your screen, activates with a hotkey, and lets you control your entire PC with your voice or text — open apps, search the web, run commands, click things on screen, and execute multi-step tasks autonomously.

There is nothing else like this for Windows.

![Aura](assets/preview.png)

## Features

- **Voice + Text input** — speak or type, your choice
- **Autonomous computer control** — Aura sees your screen and clicks, types, scrolls to complete multi-step tasks without you guiding each step
- **App launcher** — open any installed app by name (WhatsApp, Chrome, Spotify, VS Code, etc.)
- **PowerShell automation** — set volume, manage files, control media, check processes, anything
- **Web search & navigation** — open URLs or search Google directly
- **System info** — battery, memory, disk, WiFi, clipboard, IP
- **Windows notifications** — show toast notifications on demand
- **Always on top** — transparent overlay, click-through when idle
- **Minimal UI** — tiny pill at screen top, expands only when active

## Setup

### 1. Get a Gemini API key

Go to [aistudio.google.com](https://aistudio.google.com), create a key, and copy it.

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

First time you open Aura, the settings screen appears automatically. Paste your Gemini API key and click **Save & Connect**.

To change the key later: open Aura and click the ⚙ button in the footer.

## Usage

| Action | Shortcut |
|--------|----------|
| Open Aura voice assistant | `Alt+Space` |
| Ask Aura anything (Spotlight) | `Ctrl+Shift+A` |
| Region screenshot → ask | `Ctrl+Shift+S` |
| Ask about selected text | `Ctrl+Shift+E` |
| Clipboard history | `Ctrl+Shift+V` |
| Open Command Center | tray menu / pill ⚙ button |

### Example commands

- "Open WhatsApp"
- "Search for flights to Goa"
- "What's my battery level?"
- "Open Chrome and go to YouTube"
- "Create a folder called Projects on my desktop"
- "Set volume to 50%"
- "What processes are using the most CPU?"
- "Take a screenshot and tell me what's on my screen"

## Building

```bash
npm run build
```

Outputs to `dist/` — both NSIS installer and portable `.exe`.

## Tech

- Electron 33 (transparent, frameless, always-on-top window)
- Gemini Live API (WebSocket, real-time audio streaming)
- Win32 P/Invoke via PowerShell for mouse/keyboard control
- WScript.Shell SendKeys for typing
- `desktopCapturer` for screenshots

## Requirements

- Windows 10/11 x64
- Internet connection
- Gemini API key (free tier works)
