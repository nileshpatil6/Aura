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

module.exports = { runPowerShell, openApp, searchWeb, showNotification, getSystemInfo };
