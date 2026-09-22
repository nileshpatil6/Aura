# Aura UIA host. Dot-sourced ONCE into a persistent powershell.exe (5.1) session by src/uia.js.
# Contract: docs/jev-uia/CONTRACT.md section "uia.js / uia-host.ps1".

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

$AuraUiaNativeSrc = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AuraUiaNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
    [DllImport("user32.dll")] public static extern int SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

    public const uint GW_HWNDNEXT = 2;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x80;
    public const int DWMWA_CLOAKED = 14;
    public const uint LD = 2, LU = 4, WHEEL = 0x800;
}
'@
Add-Type -TypeDefinition $AuraUiaNativeSrc

# PER_MONITOR_AWARE_V2. Ignore the return value (already-set contexts fail benignly).
[void][AuraUiaNative]::SetProcessDpiAwarenessContext([IntPtr]-4)
$script:DpiOk = $false
$script:CursorScale = 1.0
try {
  $rootRect = [System.Windows.Automation.AutomationElement]::RootElement.Current.BoundingRectangle
  $sysW = [AuraUiaNative]::GetSystemMetrics(0)
  $script:DpiOk = ($sysW -eq [int]$rootRect.Width)
  if (-not $script:DpiOk -and $rootRect.Width -gt 0) { $script:CursorScale = $sysW / $rootRect.Width }
} catch {}

$script:Last = $null          # @{ Id; Elements; Hwnd; Fw; WindowRect; AuraRects }
$script:SnapCounter = 0

# ── JSON helpers (hand-rolled: ConvertTo-Json mangles Infinity rects, depth,
#    and single-element arrays — see contract traps 3/4) ────────────────────
# Built from a char code rather than typed as a literal escape: this file is
# authored through a pipeline that silently decodes any literal 4-hex-digit
# \u sequence in source text into the real Unicode character before the file
# is saved (verified: writing the 6 characters backslash-u-0-0-3-c produced a
# literal '<' byte on disk instead of the escape text). Building it at
# PowerShell runtime instead avoids that.
$script:BSU = [string][char]0x5C + 'u'

function Json-Str([string]$s) {
  if ($null -eq $s) { $s = '' }
  # .Replace (not -replace/regex) for the backslash step: verified live that
  # `-replace '\\','\\\\'` quadruples each backslash instead of doubling it
  # (C:\Users -> C:\\\\Users), corrupting every Windows path in the output.
  $s = $s.Replace('\', '\\')
  $s = $s.Replace('"', '\"')
  $s = $s.Replace("`r", '\r')
  $s = $s.Replace("`n", '\n')
  $s = $s.Replace("`t", '\t')
  # '<' must not survive raw: it is the first byte of our stdout sentinel
  # (<<AURA_UIA_DONE>>). An element name/value containing that literal text
  # would truncate the host's response mid-JSON and desync uia.js's buffer
  # for every call after it.
  $s = $s.Replace('<', ($script:BSU + '003c'))
  if ($s -match '[\x00-\x1f]') {
    # Remaining raw control chars (U+0000-U+001F) are invalid unescaped in JSON.
    $s = [regex]::Replace($s, '[\x00-\x1f]', { param($m) $script:BSU + ('{0:x4}' -f [int]$m.Value[0]) })
  }
  return '"' + $s + '"'
}
function Json-Bool($b) { if ($b) { return 'true' } else { return 'false' } }

function Get-CachedProp($el, $prop, $default) {
  try {
    $v = $el.GetCachedPropertyValue($prop, $true) # ignoreDefaultValue: real NotSupported sentinel
    if ($null -eq $v) { return $default }
    # NotSupported must be the LEFT operand: PowerShell's -eq coerces the RIGHT
    # operand to the LEFT operand's type, so "$true -eq $NotSupportedComObject"
    # silently coerces NotSupported to boolean (any non-null object -> $true)
    # and always compares equal — a false positive that made every available
    # pattern look unsupported. Verified live against Notepad's Document element.
    if ([System.Windows.Automation.AutomationElement]::NotSupported -eq $v) { return $default }
    return $v
  } catch { return $default }
}

function TryGetPattern($el, $patternType) {
  $pat = $null
  try {
    $ok = $el.TryGetCurrentPattern($patternType, [ref]$pat)
    if ($ok) { return $pat }
  } catch {}
  return $null
}

function Get-WndPid($h) {
  [uint32]$procId = 0
  [void][AuraUiaNative]::GetWindowThreadProcessId($h, [ref]$procId)
  return $procId
}
function Get-WndClass($h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][AuraUiaNative]::GetClassName($h, $sb, 256)
  return $sb.ToString()
}
function Is-Cloaked($h) {
  $val = 0
  $hr = [AuraUiaNative]::DwmGetWindowAttribute($h, [AuraUiaNative]::DWMWA_CLOAKED, [ref]$val, 4)
  return ($hr -eq 0 -and $val -ne 0)
}

function Is-DescendantOfOrSelf($el, $root) {
  try {
    if ($el.Equals($root)) { return $true }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $cur = $walker.GetParent($el)
    $depth = 0
    while ($null -ne $cur -and $depth -lt 64) {
      if ($cur.Equals($root)) { return $true }
      $cur = $walker.GetParent($cur)
      $depth++
    }
  } catch {}
  return $false
}

# ── ping ─────────────────────────────────────────────────────────────────
function Cmd-Ping {
  return '{"ok":true,"dpiOk":' + (Json-Bool $script:DpiOk) + ',"cursorScale":' + $script:CursorScale + '}'
}

# ── snapshot ─────────────────────────────────────────────────────────────
$BLOCKED_CLASSES = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')
$INTERACTIVE_TYPES = @('Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem',
  'RadioButton', 'TabItem', 'TreeItem', 'SplitButton', 'Slider', 'Spinner', 'DataItem', 'Document')

function Choose-Window($excludePid) {
  $fg = [AuraUiaNative]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) {
    $fgPid = Get-WndPid $fg
    if ([AuraUiaNative]::IsWindowVisible($fg) -and -not [AuraUiaNative]::IsIconic($fg) -and $fgPid -ne $excludePid) {
      return $fg
    }
  }

  $h = [AuraUiaNative]::GetTopWindow([IntPtr]::Zero)
  $count = 0
  while ($h -ne [IntPtr]::Zero -and $count -lt 400) {
    $count++
    $hPid = Get-WndPid $h
    $titleLen = [AuraUiaNative]::GetWindowTextLength($h)
    $exStyle = [AuraUiaNative]::GetWindowLong($h, [AuraUiaNative]::GWL_EXSTYLE)
    $isToolWindow = ($exStyle -band [AuraUiaNative]::WS_EX_TOOLWINDOW) -ne 0
    $cls = Get-WndClass $h
    if ([AuraUiaNative]::IsWindowVisible($h) -and -not [AuraUiaNative]::IsIconic($h) -and
        $hPid -ne $excludePid -and $titleLen -gt 0 -and -not $isToolWindow -and
        -not (Is-Cloaked $h) -and ($BLOCKED_CLASSES -notcontains $cls)) {
      $rectOk = $false
      try {
        $cand = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        $r = $cand.Current.BoundingRectangle
        if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) { $rectOk = $true }
      } catch {}
      if ($rectOk) { return $h }
    }
    $h = [AuraUiaNative]::GetWindow($h, [AuraUiaNative]::GW_HWNDNEXT)
  }
  return [IntPtr]::Zero
}

function Cmd-Snapshot($req) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  [uint32]$excludePid = 0
  if ($req.excludePid) { $excludePid = [uint32]$req.excludePid }

  $hwnd = Choose-Window $excludePid
  if ($hwnd -eq [IntPtr]::Zero) { return '{"ok":false,"reason":"no_window"}' }

  $root = $null
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } catch {}
  if ($null -eq $root) { return '{"ok":false,"reason":"no_window"}' }

  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  $cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::ClassNameProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::FrameworkIdProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty)
  [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)
  [void]$cache.Add([System.Windows.Automation.ValuePattern]::ValueProperty)
  [void]$cache.Add([System.Windows.Automation.ValuePattern]::IsReadOnlyProperty)
  [void]$cache.Add([System.Windows.Automation.TogglePattern]::ToggleStateProperty)
  [void]$cache.Add([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
  [void]$cache.Add([System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty)

  $typeConds = foreach ($n in $INTERACTIVE_TYPES) {
    New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$n)
  }
  $invokeCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty, $true)
  $typeOrCond = New-Object System.Windows.Automation.OrCondition(@($typeConds) + $invokeCond)
  $cond = New-Object System.Windows.Automation.AndCondition(@(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true)),
    $typeOrCond
  ))

  $found = $null
  $scope = $cache.Activate()
  try { $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) }
  finally { $scope.Dispose() }

  $focusedGlobal = $null
  try { $focusedGlobal = [System.Windows.Automation.AutomationElement]::FocusedElement } catch {}
  $focusedInWindow = $null
  if ($null -ne $focusedGlobal -and (Is-DescendantOfOrSelf $focusedGlobal $root)) { $focusedInWindow = $focusedGlobal }

  $winRect = $root.Current.BoundingRectangle
  $winX = $winRect.X; $winY = $winRect.Y; $winW = $winRect.Width; $winH = $winRect.Height
  $winIsFinite = -not [double]::IsInfinity($winX) -and -not [double]::IsInfinity($winY) -and
                 -not [double]::IsInfinity($winW) -and -not [double]::IsInfinity($winH) -and -not $winRect.IsEmpty

  $auraRects = New-Object System.Collections.Generic.List[object]
  if ($req.auraRects) {
    foreach ($ar in $req.auraRects) { [void]$auraRects.Add(@([double]$ar[0], [double]$ar[1], [double]$ar[2], [double]$ar[3])) }
  }

  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($el in $found) {
    $r = $null
    try { $r = $el.Cached.BoundingRectangle } catch { continue }
    if ($null -eq $r -or $r.IsEmpty) { continue }
    $rx = $r.X; $ry = $r.Y; $rw = $r.Width; $rh = $r.Height
    if ([double]::IsInfinity($rx) -or [double]::IsInfinity($ry) -or [double]::IsInfinity($rw) -or [double]::IsInfinity($rh) -or
        [double]::IsNaN($rx) -or [double]::IsNaN($ry) -or [double]::IsNaN($rw) -or [double]::IsNaN($rh)) { continue }

    if ($winIsFinite) {
      $ix1 = [Math]::Max($rx, $winX); $iy1 = [Math]::Max($ry, $winY)
      $ix2 = [Math]::Min($rx + $rw, $winX + $winW); $iy2 = [Math]::Min($ry + $rh, $winY + $winH)
      if ($ix2 -le $ix1 -or $iy2 -le $iy1) { continue }
      $cx = $ix1; $cy = $iy1; $cw = $ix2 - $ix1; $ch = $iy2 - $iy1
    } else {
      $cx = $rx; $cy = $ry; $cw = $rw; $ch = $rh
    }

    $isInvoke = [bool](Get-CachedProp $el ([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty) $false)
    $isToggle = [bool](Get-CachedProp $el ([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty) $false)
    $isSelect = [bool](Get-CachedProp $el ([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty) $false)
    $isExpand = [bool](Get-CachedProp $el ([System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty) $false)
    $isValue = [bool](Get-CachedProp $el ([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty) $false)

    $centerX = $cx + $cw / 2; $centerY = $cy + $ch / 2
    $inAuraRect = $false
    foreach ($ar in $auraRects) {
      if ($centerX -ge $ar[0] -and $centerX -lt ($ar[0] + $ar[2]) -and $centerY -ge $ar[1] -and $centerY -lt ($ar[1] + $ar[3])) { $inAuraRect = $true; break }
    }
    if ($inAuraRect -and -not ($isInvoke -or $isToggle -or $isSelect -or $isExpand -or $isValue)) { continue }

    $ctFull = $null
    try { $ctFull = $el.Cached.ControlType.ProgrammaticName } catch { $ctFull = '' }
    $ctName = $ctFull -replace '^ControlType\.', ''
    $elName = [string]$el.Cached.Name
    if ($null -eq $elName) { $elName = '' }
    $aid = [string]$el.Cached.AutomationId
    if ($null -eq $aid) { $aid = '' }

    $typeAllowsEmpty = ($ctName -eq 'Edit' -or $ctName -eq 'Document' -or $ctName -eq 'ComboBox')
    if ([string]::IsNullOrWhiteSpace($elName) -and [string]::IsNullOrWhiteSpace($aid) -and -not $typeAllowsEmpty) { continue }

    [void]$candidates.Add([PSCustomObject]@{
      El = $el; Type = $ctName; Name = $elName; Aid = $aid
      Rect = @([Math]::Round($cx), [Math]::Round($cy), [Math]::Round($cw), [Math]::Round($ch))
      IsInvoke = $isInvoke; IsToggle = $isToggle; IsSelect = $isSelect; IsExpand = $isExpand; IsValue = $isValue
    })
  }

  $total = $candidates.Count
  if ($total -eq 0) { return '{"ok":false,"reason":"empty"}' }

  $maxEl = 200
  if ($req.maxElements) { $maxEl = [int]$req.maxElements }
  if ($maxEl -le 0) { $maxEl = 200 }
  $truncated = $total -gt $maxEl

  $kept = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $candidates.Count -and $kept.Count -lt $maxEl; $i++) { [void]$kept.Add($candidates[$i]) }

  if ($null -ne $focusedInWindow) {
    $focusedIdx = -1
    for ($i = 0; $i -lt $candidates.Count; $i++) {
      if ($candidates[$i].El.Equals($focusedInWindow)) { $focusedIdx = $i; break }
    }
    if ($focusedIdx -ge $maxEl -and $kept.Count -gt 0) { $kept[$kept.Count - 1] = $candidates[$focusedIdx] }
  }

  $script:SnapCounter++
  $snapId = "s$($script:SnapCounter)"

  $liveList = New-Object System.Collections.Generic.List[object]
  $elemJsonParts = New-Object System.Collections.Generic.List[string]
  $focusedIdInList = $null

  for ($i = 0; $i -lt $kept.Count; $i++) {
    $c = $kept[$i]
    [void]$liveList.Add($c.El)
    $id = "e$($i + 1)"
    if ($null -ne $focusedInWindow -and $c.El.Equals($focusedInWindow)) { $focusedIdInList = $id }

    $pats = New-Object System.Collections.Generic.List[string]
    if ($c.IsInvoke) { [void]$pats.Add('invoke') }
    if ($c.IsToggle) { [void]$pats.Add('toggle') }
    if ($c.IsSelect) { [void]$pats.Add('select') }
    if ($c.IsExpand) { [void]$pats.Add('expand') }
    if ($c.IsValue) { [void]$pats.Add('value') }

    $nameOut = $c.Name
    if ($nameOut.Length -gt 0) {
      $nameOut = ($nameOut -replace '\s+', ' ').Trim()
      if ($nameOut.Length -gt 80) { $nameOut = $nameOut.Substring(0, 80) }
    }
    $aidOut = $c.Aid
    if ($aidOut.Length -gt 60) { $aidOut = $aidOut.Substring(0, 60) }
    $clsOut = ''
    try { $clsOut = [string]$c.El.Cached.ClassName } catch {}
    if ($null -eq $clsOut) { $clsOut = '' }
    if ($clsOut.Length -gt 60) { $clsOut = $clsOut.Substring(0, 60) }

    $isFocusedEl = $false
    try { $isFocusedEl = [bool]$c.El.Cached.HasKeyboardFocus } catch {}

    $fields = New-Object System.Collections.Generic.List[string]
    [void]$fields.Add('"id":' + (Json-Str $id))
    [void]$fields.Add('"i":' + $i)
    [void]$fields.Add('"type":' + (Json-Str $c.Type))
    [void]$fields.Add('"name":' + (Json-Str $nameOut))
    [void]$fields.Add('"aid":' + (Json-Str $aidOut))
    [void]$fields.Add('"cls":' + (Json-Str $clsOut))
    [void]$fields.Add('"rect":[' + ($c.Rect -join ',') + ']')
    [void]$fields.Add('"focused":' + (Json-Bool $isFocusedEl))
    [void]$fields.Add('"pats":[' + (($pats | ForEach-Object { Json-Str $_ }) -join ',') + ']')

    if ($c.IsValue) {
      $isPassword = [bool](Get-CachedProp $c.El ([System.Windows.Automation.AutomationElement]::IsPasswordProperty) $false)
      if (-not $isPassword) {
        $vpVal = [string](Get-CachedProp $c.El ([System.Windows.Automation.ValuePattern]::ValueProperty) '')
        if ($null -eq $vpVal) { $vpVal = '' }
        if ($vpVal.Length -gt 60) { $vpVal = $vpVal.Substring(0, 60) }
        [void]$fields.Add('"value":' + (Json-Str $vpVal))
        $roVal = [bool](Get-CachedProp $c.El ([System.Windows.Automation.ValuePattern]::IsReadOnlyProperty) $false)
        [void]$fields.Add('"readOnly":' + (Json-Bool $roVal))
      }
    }
    if ($c.IsToggle) {
      $tsRaw = Get-CachedProp $c.El ([System.Windows.Automation.TogglePattern]::ToggleStateProperty) $null
      $tsStr = switch ([string]$tsRaw) { 'On' { 'on' } 'Off' { 'off' } default { 'indeterminate' } }
      [void]$fields.Add('"toggle":' + (Json-Str $tsStr))
    }
    if ($c.IsSelect) {
      $selVal = [bool](Get-CachedProp $c.El ([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty) $false)
      [void]$fields.Add('"selected":' + (Json-Bool $selVal))
    }
    if ($c.IsExpand) {
      $ecRaw = Get-CachedProp $c.El ([System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty) $null
      $ecStr = switch ([string]$ecRaw) {
        'Collapsed' { 'collapsed' } 'Expanded' { 'expanded' } 'PartiallyExpanded' { 'partial' } 'LeafNode' { 'leaf' } default { 'leaf' }
      }
      [void]$fields.Add('"expand":' + (Json-Str $ecStr))
    }

    [void]$elemJsonParts.Add('{' + ($fields -join ',') + '}')
  }

  $hwndStr = '0x' + $hwnd.ToInt64().ToString('X')
  $titleOut = [string]$root.Current.Name
  if ($null -eq $titleOut) { $titleOut = '' }
  $fwOut = [string]$root.Current.FrameworkId
  if ([string]::IsNullOrEmpty($fwOut)) { $fwOut = 'Win32' }
  $winPid = Get-WndPid $hwnd
  $procName = ''
  try { $procName = (Get-Process -Id $winPid -ErrorAction Stop).ProcessName } catch {}

  $focusedJson = 'null'
  if ($null -ne $focusedInWindow) {
    $fType = ''; $fName = ''
    try { $fType = ($focusedInWindow.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch {}
    try { $fName = [string]$focusedInWindow.Current.Name } catch {}
    if ($null -eq $fName) { $fName = '' }
    $idPart = 'null'
    if ($null -ne $focusedIdInList) { $idPart = (Json-Str $focusedIdInList) }
    $focusedJson = '{"type":' + (Json-Str $fType) + ',"name":' + (Json-Str $fName) + ',"id":' + $idPart + '}'
  }

  $winRectOut = @(0, 0, 0, 0)
  if ($winIsFinite) { $winRectOut = @([Math]::Round($winX), [Math]::Round($winY), [Math]::Round($winW), [Math]::Round($winH)) }

  $script:Last = @{ Id = $snapId; Elements = $liveList; Hwnd = $hwnd; Fw = $fwOut; WindowRect = $winRectOut; AuraRects = $auraRects }

  $sw.Stop()
  return '{"ok":true,"snapshotId":' + (Json-Str $snapId) + ',"ms":' + $sw.ElapsedMilliseconds +
    ',"hwnd":' + (Json-Str $hwndStr) + ',"pid":' + $winPid + ',"process":' + (Json-Str $procName) +
    ',"title":' + (Json-Str $titleOut) + ',"fw":' + (Json-Str $fwOut) +
    ',"windowRect":[' + ($winRectOut -join ',') + ']' +
    ',"focused":' + $focusedJson +
    ',"total":' + $total + ',"truncated":' + (Json-Bool $truncated) +
    ',"elements":[' + ($elemJsonParts -join ',') + ']}'
}

# ── act ──────────────────────────────────────────────────────────────────
function Ok-Result($method, $point, $sw) {
  $sw.Stop()
  $s = '{"ok":true,"method":' + (Json-Str $method) + ',"ms":' + $sw.ElapsedMilliseconds
  if ($null -ne $point) { $s += ',"point":[' + $point[0] + ',' + $point[1] + ']' }
  $s += '}'
  return $s
}

function Do-MouseClick($el, $hwnd, $sw) {
  $pt = $null
  try { $pt = $el.GetClickablePoint() } catch { $pt = $null }
  if ($null -eq $pt) {
    try {
      $r = $el.Cached.BoundingRectangle
      if (-not $r.IsEmpty) { $pt = New-Object System.Windows.Point(($r.X + $r.Width / 2), ($r.Y + $r.Height / 2)) }
    } catch {}
  }
  if ($null -eq $pt) { return '{"ok":false,"reason":"unsupported","detail":"no clickable point"}' }

  $inAura = $false
  foreach ($ar in $script:Last.AuraRects) {
    if ($pt.X -ge $ar[0] -and $pt.X -lt ($ar[0] + $ar[2]) -and $pt.Y -ge $ar[1] -and $pt.Y -lt ($ar[1] + $ar[3])) { $inAura = $true; break }
  }
  if ($inAura) { return '{"ok":false,"reason":"occluded"}' }

  [void][AuraUiaNative]::SetForegroundWindow($hwnd)
  $cx = [int][Math]::Round($pt.X * $script:CursorScale)
  $cy = [int][Math]::Round($pt.Y * $script:CursorScale)
  [void][AuraUiaNative]::SetCursorPos($cx, $cy)
  [AuraUiaNative]::mouse_event([AuraUiaNative]::LD, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 60
  [AuraUiaNative]::mouse_event([AuraUiaNative]::LU, 0, 0, 0, 0)
  return (Ok-Result 'mouse' @($cx, $cy) $sw)
}

function Do-Click($el, $fw, $hwnd, $sw) {
  $ct = ''
  try { $ct = ($el.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch {}

  $isEditableCombo = $false
  if ($ct -eq 'ComboBox') {
    $vp = TryGetPattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $vp) { $isEditableCombo = $true }
  }

  if ($ct -eq 'Edit' -or $ct -eq 'Document' -or $isEditableCombo) {
    try { $el.SetFocus(); return (Ok-Result 'focus' $null $sw) }
    catch [System.Windows.Automation.ElementNotAvailableException] { throw }
    catch {}
  }

  if ($fw -ne 'Win32' -and $fw -ne 'WinForm') {
    $invokePat = TryGetPattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invokePat) {
      try { $invokePat.Invoke(); return (Ok-Result 'invoke' $null $sw) }
      catch [System.Windows.Automation.ElementNotAvailableException] { throw }
      catch {}
    }
  }

  $togglePat = TryGetPattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
  if ($null -ne $togglePat) {
    try { $togglePat.Toggle(); return (Ok-Result 'toggle' $null $sw) }
    catch [System.Windows.Automation.ElementNotAvailableException] { throw }
    catch {}
  }

  $selectPat = TryGetPattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $selectPat) {
    try { $selectPat.Select(); return (Ok-Result 'select' $null $sw) }
    catch [System.Windows.Automation.ElementNotAvailableException] { throw }
    catch {}
  }

  $expandPat = TryGetPattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($null -ne $expandPat) {
    try {
      $state = $expandPat.Current.ExpandCollapseState
      if ($state -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
        $expandPat.Expand(); return (Ok-Result 'expand' $null $sw)
      } else {
        $expandPat.Collapse(); return (Ok-Result 'collapse' $null $sw)
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] { throw }
    catch {}
  }

  return (Do-MouseClick $el $hwnd $sw)
}

function Do-Focus($el, $sw) {
  $el.SetFocus()
  return (Ok-Result 'focus' $null $sw)
}

function Do-SetValue($el, $text, $sw) {
  $valuePat = TryGetPattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $valuePat) { return '{"ok":false,"reason":"unsupported"}' }
  $valuePat.SetValue($text)
  $newVal = $null
  try { $newVal = $el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch {}
  $verified = ($newVal -eq $text)
  $sw.Stop()
  return '{"ok":true,"method":"set_value","verified":' + (Json-Bool $verified) + ',"ms":' + $sw.ElapsedMilliseconds + '}'
}

function Do-Scroll($winRect, $direction, $sw) {
  if ($null -eq $winRect) { return '{"ok":false,"reason":"unsupported"}' }
  $cx = [int](($winRect[0] + $winRect[2] / 2) * $script:CursorScale)
  $cy = [int](($winRect[1] + $winRect[3] / 2) * $script:CursorScale)
  [void][AuraUiaNative]::SetCursorPos($cx, $cy)
  $delta = 360
  if ($direction -ne 'up') { $delta = -360 }
  [AuraUiaNative]::mouse_event([AuraUiaNative]::WHEEL, 0, 0, $delta, 0)
  return (Ok-Result 'wheel' @($cx, $cy) $sw)
}

function Cmd-Act($req) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if ($null -eq $script:Last -or $req.snapshotId -ne $script:Last.Id) {
    return '{"ok":false,"reason":"stale_snapshot"}'
  }

  $el = $null
  if ($req.op -ne 'scroll') {
    $idx = [int]$req.index
    if ($idx -lt 0 -or $idx -ge $script:Last.Elements.Count) { return '{"ok":false,"reason":"stale_element"}' }
    $el = $script:Last.Elements[$idx]
  }

  try {
    switch ($req.op) {
      'click' { return (Do-Click $el $script:Last.Fw $script:Last.Hwnd $sw) }
      'focus' { return (Do-Focus $el $sw) }
      'set_value' { return (Do-SetValue $el $req.text $sw) }
      'scroll' { return (Do-Scroll $script:Last.WindowRect $req.direction $sw) }
      default { return '{"ok":false,"reason":"unsupported"}' }
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] {
    return '{"ok":false,"reason":"stale_element"}'
  }
}

# ── entry point ──────────────────────────────────────────────────────────
# One call per stdin line: Invoke-AuraUia '<base64 of UTF-8 JSON command>'
# Writes exactly ONE line of compact JSON to stdout (the caller appends the sentinel).
function Invoke-AuraUia([string]$b64) {
  $ErrorActionPreference = 'Stop'
  try {
    $jsonText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
    $req = $jsonText | ConvertFrom-Json
    switch ($req.cmd) {
      'ping' { Write-Output (Cmd-Ping) }
      'snapshot' { Write-Output (Cmd-Snapshot $req) }
      'act' { Write-Output (Cmd-Act $req) }
      default { Write-Output '{"ok":false,"reason":"error","detail":"unknown cmd"}' }
    }
  } catch {
    $msg = "$($_.Exception.Message)"
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
    Write-Output ('{"ok":false,"reason":"error","detail":' + (Json-Str $msg) + '}')
  }
}
