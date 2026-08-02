const { exec, spawn } = require('child_process');
const { Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Hardcoded map: app name -> PowerShell command to open it
const APP_COMMANDS = {
  // Browsers
  'chrome': 'Start-Process "chrome"',
  'google chrome': 'Start-Process "chrome"',
  'firefox': 'Start-Process "firefox"',
  'edge': 'Start-Process "msedge"',
  'microsoft edge': 'Start-Process "msedge"',
  'brave': 'Start-Process "brave"',
  'opera': 'Start-Process "opera"',

  // Dev tools
  'vscode': 'Start-Process "code"',
  'vs code': 'Start-Process "code"',
  'visual studio code': 'Start-Process "code"',
  'terminal': 'Start-Process "wt"',
  'windows terminal': 'Start-Process "wt"',
  'cmd': 'Start-Process "cmd"',
  'command prompt': 'Start-Process "cmd"',
  'powershell': 'Start-Process "powershell"',
  'git bash': 'Start-Process "git-bash"',

  // Windows built-ins
  'notepad': 'Start-Process "notepad"',
  'calculator': 'Start-Process "calculator:"',
  'calc': 'Start-Process "calculator:"',
  'paint': 'Start-Process "mspaint"',
  'file explorer': 'Start-Process "explorer"',
  'explorer': 'Start-Process "explorer"',
  'task manager': 'Start-Process "taskmgr"',
  'control panel': 'Start-Process "control"',
  'settings': 'Start-Process "ms-settings:"',
  'windows settings': 'Start-Process "ms-settings:"',
  'snipping tool': 'Start-Process "snippingtool"',
  'wordpad': 'Start-Process "wordpad"',
  'registry': 'Start-Process "regedit"',
  'device manager': 'Start-Process "devmgmt.msc"',
  'disk management': 'Start-Process "diskmgmt.msc"',
  'event viewer': 'Start-Process "eventvwr.msc"',

  // Office
  'word': 'Start-Process "winword"',
  'excel': 'Start-Process "excel"',
  'powerpoint': 'Start-Process "powerpnt"',
  'outlook': 'Start-Process "outlook"',
  'onenote': 'Start-Process "onenote"',

  // Communication (Store apps - use Get-StartApps fallback)
  'whatsapp': null,
  'telegram': null,
  'discord': 'Start-Process "discord:"',
  'slack': 'Start-Process "slack:"',
  'teams': 'Start-Process "msteams:"',
  'microsoft teams': 'Start-Process "msteams:"',
  'zoom': 'Start-Process "zoommtg:"',
  'skype': 'Start-Process "skype:"',

  // Media
  'spotify': 'Start-Process "spotify:"',
  'vlc': 'Start-Process "vlc"',
  'media player': 'Start-Process "wmplayer"',
  'netflix': 'Start-Process "https://netflix.com"',
  'youtube': 'Start-Process "https://youtube.com"',

  // Utilities
  'steam': 'Start-Process "steam:"',
  'epic games': null,
  'obs': 'Start-Process "obs64"',
  'audacity': 'Start-Process "audacity"',
};

// Build a PS script that opens an app by name, with Store app fallback
function buildOpenAppScript(name, url) {
  if (url) {
    return `Start-Process "${url}"`;
  }

  const key = name.toLowerCase().trim();
  const hardcoded = APP_COMMANDS[key];

  // Known app with a command
  if (hardcoded) return hardcoded;

  // Known app that needs Store app lookup, or unknown app - try both
  return `
$direct = $null
try { $direct = Get-Command "${name}" -ErrorAction Stop } catch {}
if ($direct) {
  Start-Process "${name}"
} else {
  $app = Get-StartApps | Where-Object { $_.Name -ilike "*${name}*" } | Select-Object -First 1
  if ($app) {
    Start-Process "explorer.exe" "shell:AppsFolder\\$($app.AppID)"
    Write-Output "Opened $($app.Name)"
  } else {
    Start-Process "${name}" -ErrorAction SilentlyContinue
    Write-Output "Attempted to open ${name}"
  }
}
`.trim();
}

async function runPowerShell(command) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `gemini_${Date.now()}.ps1`);
    fs.writeFileSync(tmp, command, 'utf8');

    exec(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`,
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmp); } catch {}
        const output = (stdout + stderr).trim();
        resolve({
          success: !err || output.length > 0,
          output: output || (err ? err.message : 'Done'),
        });
      }
    );
  });
}

// ── Persistent PowerShell session for input actions ─────────────────────────
// Every computerAction used to spawn a fresh PowerShell (~584ms) and re-JIT the
// Win32 P/Invoke type via Add-Type (~350ms) — about 1s of pure overhead on every
// click or keystroke. This keeps one warm session with the type already loaded
// and streams commands to it, so an action costs roughly the time it takes to
// actually move the mouse. Falls back to one-shot runPowerShell if the session
// can't start or stops responding.
const PS_SENTINEL = '<<AURA_DONE>>';
let psProc = null;
let psBuf = '';
let psPending = null;      // { resolve, timer }
let psChain = Promise.resolve(); // serializes commands onto the single stdin

function killPS() {
  if (psProc) { try { psProc.kill(); } catch {} }
  psProc = null;
  psBuf = '';
  if (psPending) { const p = psPending; psPending = null; p.resolve(null); }
}

function ensurePS() {
  if (psProc) return psProc;
  try {
    // Dot-source the Win32 type from a file rather than piping the here-string
    // through stdin, which is fragile with `-Command -`.
    const win32File = path.join(os.tmpdir(), 'aura_win32.ps1');
    fs.writeFileSync(win32File, WIN32_BLOCK, 'utf8');

    const proc = spawn('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      psBuf += chunk;
      const i = psBuf.indexOf(PS_SENTINEL);
      if (i !== -1 && psPending) {
        const out = psBuf.slice(0, i).trim();
        psBuf = psBuf.slice(i + PS_SENTINEL.length);
        const p = psPending; psPending = null;
        clearTimeout(p.timer);
        p.resolve(out);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => {});           // non-fatal; surfaced via stdout
    proc.on('exit', () => { psProc = null; psBuf = ''; });
    proc.on('error', () => { psProc = null; psBuf = ''; });

    proc.stdin.write(`. '${win32File.replace(/'/g, "''")}'\n`);
    psProc = proc;
    return proc;
  } catch {
    return null;
  }
}

// Runs a script in the warm session. Resolves null if unavailable/timed out,
// which signals the caller to fall back to a one-shot process.
function runPersistent(script, timeoutMs = 8000) {
  const task = () => new Promise((resolve) => {
    const proc = ensurePS();
    if (!proc || psPending) return resolve(null);
    const timer = setTimeout(() => {
      if (psPending) { psPending = null; killPS(); resolve(null); }
    }, timeoutMs);
    psPending = { resolve, timer };
    try {
      proc.stdin.write(`${script}\nWrite-Output "${PS_SENTINEL}"\n`);
    } catch {
      clearTimeout(timer); psPending = null; killPS(); resolve(null);
    }
  });
  psChain = psChain.then(task, task);
  return psChain;
}

function shutdownAutomation() { killPS(); }

async function openApp(name, url) {
  const script = buildOpenAppScript(name, url);
  return runPowerShell(script);
}

async function searchWeb(query) {
  const isUrl = /^https?:\/\//i.test(query);
  const target = isUrl ? query : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  return runPowerShell(`Start-Process "${target}"`);
}

function showNotification(title, message) {
  try {
    new Notification({ title, body: message }).show();
    return { success: true };
  } catch (e) {
    return { success: false, output: e.message };
  }
}

async function getSystemInfo(type) {
  const scripts = {
    time: `Get-Date -Format "dddd, MMMM d yyyy, h:mm tt"`,
    battery: `
$b = Get-WmiObject Win32_Battery
if ($b) { "Battery: $($b.EstimatedChargeRemaining)% - $(if($b.BatteryStatus -eq 2){'Charging'}else{'Discharging'})" }
else { "No battery (desktop)" }`,
    volume: `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float f, System.Guid g); int j(); int GetMasterVolumeLevelScalar(out float f); }' -PassThru | Out-Null
$vol = [Math]::Round((Get-WmiObject -Class Win32_SoundDevice | Select-Object -First 1).StatusInfo)
"Current system volume info retrieved"`,
    processes: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, @{N='CPU(s)';E={[Math]::Round($_.CPU,1)}}, @{N='Mem(MB)';E={[Math]::Round($_.WorkingSet/1MB,1)}} | Format-Table -AutoSize | Out-String`,
    disk: `Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='Used(GB)';E={[Math]::Round(($_.Used/1GB),1)}}, @{N='Free(GB)';E={[Math]::Round(($_.Free/1GB),1)}} | Format-Table -AutoSize | Out-String`,
    memory: `
$os = Get-CimInstance Win32_OperatingSystem
$total = [Math]::Round($os.TotalVisibleMemorySize/1MB, 1)
$free = [Math]::Round($os.FreePhysicalMemory/1MB, 1)
$used = [Math]::Round($total - $free, 1)
"Memory: \${used}GB used / \${total}GB total ($([Math]::Round($used/$total*100))% used)"`,
    wifi: `
$wifi = Get-NetConnectionProfile | Select-Object -First 1
if ($wifi) { "Connected to: $($wifi.Name) ($($wifi.NetworkCategory))" } else { "No network connection" }`,
    clipboard: `Get-Clipboard`,
    ip: `(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" } | Select-Object -First 1).IPAddress`,
  };

  const script = scripts[type] || `Write-Output "Unknown info type: ${type}"`;
  return runPowerShell(script);
}

// ── Computer control (mouse + keyboard via Win32 P/Invoke) ───────────────────

// Reusable Win32 type definition - compiled once per PS process
const WIN32_BLOCK = `
$code = @'
using System.Runtime.InteropServices;
public class Win32Input {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, int e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, int e);
    public const uint LD=2,LU=4,RD=8,RU=16,MD=0x20,MU=0x40,WHEEL=0x800,HWHEEL=0x1000,MOVE=0x8001;
}
'@
if (-not ([System.Management.Automation.PSTypeName]'Win32Input').Type) {
    Add-Type -TypeDefinition $code
}
`;

// NOTE: builders emit only the action itself. The Win32 type is loaded once by
// the persistent session (ensurePS); the one-shot fallback prepends WIN32_BLOCK.
function buildMouseScript(x, y, action) {
  const base = `[Win32Input]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 40
`;
  switch (action) {
    case 'click':
      return base + `[Win32Input]::mouse_event([Win32Input]::LD,0,0,0,0)\nStart-Sleep -Milliseconds 60\n[Win32Input]::mouse_event([Win32Input]::LU,0,0,0,0)\nWrite-Output "left-click at ${x},${y}"`;
    case 'right_click':
      return base + `[Win32Input]::mouse_event([Win32Input]::RD,0,0,0,0)\nStart-Sleep -Milliseconds 60\n[Win32Input]::mouse_event([Win32Input]::RU,0,0,0,0)\nWrite-Output "right-click at ${x},${y}"`;
    case 'double_click':
      return base + `[Win32Input]::mouse_event([Win32Input]::LD,0,0,0,0)\n[Win32Input]::mouse_event([Win32Input]::LU,0,0,0,0)\nStart-Sleep -Milliseconds 80\n[Win32Input]::mouse_event([Win32Input]::LD,0,0,0,0)\n[Win32Input]::mouse_event([Win32Input]::LU,0,0,0,0)\nWrite-Output "double-click at ${x},${y}"`;
    case 'move':
      return base + `Write-Output "moved to ${x},${y}"`;
    case 'middle_click':
      return base + `[Win32Input]::mouse_event([Win32Input]::MD,0,0,0,0)\nStart-Sleep -Milliseconds 60\n[Win32Input]::mouse_event([Win32Input]::MU,0,0,0,0)\nWrite-Output "middle-click at ${x},${y}"`;
    case 'triple_click':
      return base + `for ($i=0; $i -lt 3; $i++) { [Win32Input]::mouse_event([Win32Input]::LD,0,0,0,0); [Win32Input]::mouse_event([Win32Input]::LU,0,0,0,0); Start-Sleep -Milliseconds 70 }\nWrite-Output "triple-click at ${x},${y}"`;
    case 'mouse_down':
      return base + `[Win32Input]::mouse_event([Win32Input]::LD,0,0,0,0)\nWrite-Output "mouse down at ${x},${y}"`;
    case 'mouse_up':
      return base + `[Win32Input]::mouse_event([Win32Input]::LU,0,0,0,0)\nWrite-Output "mouse up at ${x},${y}"`;
    default:
      return `Write-Output "unknown action"`;
  }
}

// Gemini 3.x `scroll` gives direction + magnitude_in_pixels. Windows wheel
// notches are 120 units each, so convert pixels -> notches (~100px per notch).
function buildScrollScript(x, y, direction, clicks) {
  const horizontal = direction === 'left' || direction === 'right';
  // Wheel sign: up/right are positive, down/left negative.
  const sign = (direction === 'up' || direction === 'right') ? 1 : -1;
  const delta = sign * 120 * clicks;
  const evt = horizontal ? 'HWHEEL' : 'WHEEL';
  return `[Win32Input]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 40
[Win32Input]::mouse_event([Win32Input]::${evt}, 0, 0, ${delta}, 0)
Write-Output "scrolled ${direction} ${clicks} notches at ${x},${y}"`;
}

function buildTypeScript(text) {
  // Escape for PowerShell SendKeys
  const escaped = text
    .replace(/\+/g, '{+}').replace(/\^/g, '{^}').replace(/%/g, '{%}')
    .replace(/~/g, '{~}').replace(/\(/g, '{(}').replace(/\)/g, '{)}')
    .replace(/\[/g, '{[}').replace(/\]/g, '{]}').replace(/\{/g, '{{').replace(/\}/g, '}}');
  return `$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${escaped.replace(/'/g, "''")}')
Write-Output "typed text"`;
}

// SendKeys tokens for non-printable keys.
const SENDKEYS_SPECIAL = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', insert: '{INSERT}',
  space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  pgup: '{PGUP}', pgdn: '{PGDN}', capslock: '{CAPSLOCK}', printscreen: '{PRTSC}',
};
for (let i = 1; i <= 12; i++) SENDKEYS_SPECIAL[`f${i}`] = `{F${i}}`;

// Virtual-key codes needed for the Windows key, which SendKeys cannot express.
const VK = { win: 0x5B, ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, tab: 0x09, enter: 0x0D, escape: 0x1B, esc: 0x1B, delete: 0x2E, space: 0x20 };
function vkFor(token) {
  if (VK[token] != null) return VK[token];
  if (/^f([1-9]|1[0-2])$/.test(token)) return 0x6F + Number(token.slice(1)); // F1=0x70
  if (token.length === 1) return token.toUpperCase().charCodeAt(0);          // A-Z, 0-9
  return null;
}

// Gemini's computer-use model emits X11 keysym names (verified against the live
// API: it returns key:"Super_L" for the Windows key). Map those onto the names
// used below, otherwise they'd fall through as literal SendKeys tokens and fail.
const KEYSYM_ALIASES = {
  super_l: 'win', super_r: 'win', super: 'win', meta_l: 'win', meta_r: 'win',
  control_l: 'ctrl', control_r: 'ctrl', control: 'ctrl',
  alt_l: 'alt', alt_r: 'alt', shift_l: 'shift', shift_r: 'shift',
  return: 'enter', kp_enter: 'enter', backspace: 'backspace',
  page_up: 'pageup', page_down: 'pagedown', prior: 'pageup', next: 'pagedown',
  print: 'printscreen', caps_lock: 'capslock',
};
const normalizeKeyToken = (t) => KEYSYM_ALIASES[t] || t;

// Accepts "enter", "ctrl+a", "win", "win+d", "ctrl+shift+n", X11 keysyms like
// "Super_L", or an array of keys. Windows-key chords go through keybd_event
// (SendKeys has no Win modifier); everything else uses SendKeys, which is more
// reliable for text-entry targets.
function buildKeyScript(key) {
  const raw = Array.isArray(key) ? key.join('+') : String(key || 'enter');
  const parts = raw.toLowerCase().split('+')
    .map(s => normalizeKeyToken(s.trim()))
    .filter(Boolean);
  const label = parts.join('+');

  const hasWin = parts.some(p => p === 'win' || p === 'super' || p === 'meta' || p === 'cmd');

  if (hasWin) {
    const others = parts.filter(p => !['win', 'super', 'meta', 'cmd'].includes(p));
    const codes = others.map(vkFor).filter(c => c != null);
    const downs = codes.map(c => `[Win32Input]::keybd_event(${c},0,0,0)`).join('\n');
    const ups = codes.slice().reverse().map(c => `[Win32Input]::keybd_event(${c},0,2,0)`).join('\n');
    return `[Win32Input]::keybd_event(0x5B,0,0,0)
${downs}
Start-Sleep -Milliseconds 40
${ups}
[Win32Input]::keybd_event(0x5B,0,2,0)
Write-Output "pressed ${label}"`;
  }

  let prefix = '';
  let base = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') prefix += '^';
    else if (p === 'alt') prefix += '%';
    else if (p === 'shift') prefix += '+';
    else base = SENDKEYS_SPECIAL[p] || (p.length === 1 ? p : `{${p.toUpperCase()}}`);
  }
  if (!base) base = '';
  const seq = (prefix + base).replace(/'/g, "''");
  return `$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${seq}')
Write-Output "pressed ${label}"`;
}

// Resolve coordinates: accept normalized (nx/ny in 0-999) OR pixel (x/y in 1280x720 space).
// Normalized is preferred (Gemini 2.5 Computer Use convention).
function resolveXY({ x, y, nx, ny }, ctx) {
  if (nx != null && ny != null) {
    return {
      x: Math.round((nx / 1000) * ctx.physW),
      y: Math.round((ny / 1000) * ctx.physH),
    };
  }
  return {
    x: x != null ? Math.round(x * (ctx.scaleX || 1)) : 0,
    y: y != null ? Math.round(y * (ctx.scaleY || 1)) : 0,
  };
}

function buildDragScript(x1, y1, x2, y2) {
  return `[Win32Input]::SetCursorPos(${x1}, ${y1})
Start-Sleep -Milliseconds 120
[Win32Input]::mouse_event([Win32Input]::LD,0,0,0,0)
Start-Sleep -Milliseconds 80
$steps = 20
for ($i=1; $i -le $steps; $i++) {
  $px = ${x1} + [int]((${x2} - ${x1}) * $i / $steps)
  $py = ${y1} + [int]((${y2} - ${y1}) * $i / $steps)
  [Win32Input]::SetCursorPos($px, $py)
  Start-Sleep -Milliseconds 15
}
Start-Sleep -Milliseconds 80
[Win32Input]::mouse_event([Win32Input]::LU,0,0,0,0)
Write-Output "dragged ${x1},${y1} -> ${x2},${y2}"`;
}

async function computerAction(params) {
  const { action, text, key, clicks } = params;
  const ctx = {
    physW: params.physW || 1920,
    physH: params.physH || 1080,
    scaleX: params.scaleX,
    scaleY: params.scaleY,
  };
  const { x: sx, y: sy } = resolveXY(params, ctx);
  const scrollClicks = clicks || 3;

  let script;
  switch (action) {
    case 'click':
    case 'right_click':
    case 'double_click':
    case 'triple_click':
    case 'middle_click':
    case 'mouse_down':
    case 'mouse_up':
    case 'move':
      script = buildMouseScript(sx, sy, action);
      break;
    case 'scroll_down':
      script = buildScrollScript(sx, sy, 'down', scrollClicks);
      break;
    case 'scroll_up':
      script = buildScrollScript(sx, sy, 'up', scrollClicks);
      break;
    case 'scroll_left':
      script = buildScrollScript(sx, sy, 'left', scrollClicks);
      break;
    case 'scroll_right':
      script = buildScrollScript(sx, sy, 'right', scrollClicks);
      break;
    case 'type':
      script = buildTypeScript(text || '');
      break;
    case 'key':
      script = buildKeyScript(key || 'enter');
      break;
    case 'drag': {
      const { x: ex, y: ey } = resolveXY({ x: params.x2, y: params.y2, nx: params.nx2, ny: params.ny2 }, ctx);
      script = buildDragScript(sx, sy, ex, ey);
      break;
    }
    default:
      return { success: false, output: `Unknown action: ${action}` };
  }

  // Fast path: warm session (type already loaded). Fall back to a one-shot
  // process, which must prepend the Win32 type definition itself.
  let output = await runPersistent(script);
  if (output === null) {
    const r = await runPowerShell(`${WIN32_BLOCK}\n${script}`);
    output = r.output;
  }

  // Settle delay, scaled to what the action actually needs. A flat 700ms on
  // every action was a large share of per-step latency; only actions that
  // change focus or trigger UI transitions need real time to settle.
  const SETTLE = { type: 260, key: 220, drag: 220 };
  await new Promise(r => setTimeout(r, SETTLE[action] ?? 130));

  return { success: true, output: output || 'Done' };
}

// ── Clipboard ────────────────────────────────────────────────────────────────
async function readClipboard() {
  return runPowerShell('Get-Clipboard');
}
async function writeClipboard(text) {
  const escaped = (text || '').replace(/'/g, "''");
  return runPowerShell(`Set-Clipboard -Value '${escaped}'`);
}

// ── Media (system media keys via VK codes) ───────────────────────────────────
async function mediaControl(action) {
  // 0xB3 PLAY_PAUSE, 0xB2 STOP, 0xB0 NEXT, 0xB1 PREV, 0xAE VOL_DOWN, 0xAF VOL_UP, 0xAD VOL_MUTE
  const map = { play_pause:0xB3, stop:0xB2, next:0xB0, prev:0xB1, vol_up:0xAF, vol_down:0xAE, mute:0xAD };
  const code = map[action];
  if (!code) return { success: false, output: `unknown media action: ${action}` };
  const script = `${WIN32_BLOCK}
[Win32Input]::keybd_event(${code}, 0, 0, 0)
Start-Sleep -Milliseconds 60
[Win32Input]::keybd_event(${code}, 0, 2, 0)
Write-Output "media ${action}"`;
  return runPowerShell(script);
}

// ── Volume (precise, 0-100) ──────────────────────────────────────────────────
async function setVolume(percent) {
  const p = Math.max(0, Math.min(100, parseInt(percent, 10) || 0));
  // Use NirCmd-style approach via Set-AudioDevice not always available; use VK key spam
  const script = `${WIN32_BLOCK}
$obj = New-Object -ComObject WScript.Shell
1..50 | ForEach-Object { [Win32Input]::keybd_event(0xAE, 0, 0, 0); [Win32Input]::keybd_event(0xAE, 0, 2, 0) }
$target = ${p / 2}
1..[int]$target | ForEach-Object { [Win32Input]::keybd_event(0xAF, 0, 0, 0); [Win32Input]::keybd_event(0xAF, 0, 2, 0) }
Write-Output "volume set to ~${p}%"`;
  return runPowerShell(script);
}

// ── Brightness ───────────────────────────────────────────────────────────────
async function setBrightness(percent) {
  const p = Math.max(0, Math.min(100, parseInt(percent, 10) || 50));
  return runPowerShell(`(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${p}); Write-Output "brightness ${p}%"`);
}

// ── Window management ────────────────────────────────────────────────────────
async function focusWindow(appName) {
  const safe = (appName || '').replace(/'/g, "''");
  return runPowerShell(`
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safe}*' -or $_.ProcessName -like '*${safe}*' } | Select-Object -First 1
if ($proc) {
  $sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
  $type = Add-Type -MemberDefinition $sig -Name W -Namespace S -PassThru
  $type::SetForegroundWindow($proc.MainWindowHandle)
  Write-Output "focused $($proc.ProcessName)"
} else {
  Write-Output "no window matching '${safe}'"
}`.trim());
}

async function minimizeAll() {
  return runPowerShell(`(New-Object -ComObject Shell.Application).MinimizeAll(); Write-Output "minimized all"`);
}

async function closeApp(appName) {
  const safe = (appName || '').replace(/'/g, "''");
  return runPowerShell(`Get-Process | Where-Object { $_.ProcessName -like '*${safe}*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Output "closed ${safe}"`);
}

// ── Power ────────────────────────────────────────────────────────────────────
async function lockScreen()  { return runPowerShell('rundll32.exe user32.dll,LockWorkStation; Write-Output "locked"'); }
async function sleepPc()     { return runPowerShell('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $true); Write-Output "sleeping"'); }

module.exports = {
  runPowerShell, openApp, searchWeb, showNotification, getSystemInfo, computerAction,
  readClipboard, writeClipboard,
  mediaControl, setVolume, setBrightness,
  focusWindow, minimizeAll, closeApp,
  lockScreen, sleepPc,
  shutdownAutomation,
};
