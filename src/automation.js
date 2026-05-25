const { exec } = require('child_process');
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
"Memory: ${used}GB used / ${total}GB total ($([Math]::Round($used/$total*100))% used)"`,
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
    public const uint LD=2,LU=4,RD=8,RU=16,WHEEL=0x800,MOVE=0x8001;
}
'@
if (-not ([System.Management.Automation.PSTypeName]'Win32Input').Type) {
    Add-Type -TypeDefinition $code
}
`;

function buildMouseScript(x, y, action) {
  const base = `${WIN32_BLOCK}
[Win32Input]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 120
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
    default:
      return `Write-Output "unknown action"`;
  }
}

function buildScrollScript(x, y, direction, clicks) {
  const delta = direction === 'up' ? 120 * clicks : -120 * clicks;
  return `${WIN32_BLOCK}
[Win32Input]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 80
[Win32Input]::mouse_event([Win32Input]::WHEEL, 0, 0, ${delta}, 0)
Write-Output "scrolled ${direction} ${clicks} clicks at ${x},${y}"`;
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

function buildKeyScript(key) {
  const keyMap = {
    'enter': '{ENTER}', 'tab': '{TAB}', 'escape': '{ESC}', 'esc': '{ESC}',
    'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'space': ' ',
    'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
    'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
    'f5': '{F5}', 'f11': '{F11}', 'ctrl+a': '^a', 'ctrl+c': '^c',
    'ctrl+v': '^v', 'ctrl+z': '^z', 'ctrl+t': '^t', 'ctrl+w': '^w',
    'ctrl+r': '^r', 'ctrl+l': '^l', 'ctrl+f': '^f',
  };
  const mapped = keyMap[key.toLowerCase()] || `{${key.toUpperCase()}}`;
  return `$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${mapped}')
Write-Output "pressed ${key}"`;
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
  return `${WIN32_BLOCK}
[Win32Input]::SetCursorPos(${x1}, ${y1})
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
    case 'move':
      script = buildMouseScript(sx, sy, action);
      break;
    case 'scroll_down':
      script = buildScrollScript(sx, sy, 'down', scrollClicks);
      break;
    case 'scroll_up':
      script = buildScrollScript(sx, sy, 'up', scrollClicks);
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

  const result = await runPowerShell(script);
  await new Promise(r => setTimeout(r, 700));
  return result;
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
};
