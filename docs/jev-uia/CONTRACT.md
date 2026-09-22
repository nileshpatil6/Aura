# CONTRACT: Jev element-targeted steps + UIA screen describer for do_computer_task

Status: design fixed. Stubs already exist for all new files (`src/env-keys.js`, `src/jev.js`,
`src/jev-step.js`, `src/uia.js`, `src/uia-host.ps1`); fill them, then wire the existing files.

## 0. Decisions (with one-line justification each)

| # | Decision | Why |
|---|---|---|
| D1 | Jev lives ONLY inside `ComputerUseAgent.run()` as per-step action picker + goal/stuck judge. Typed-command pre-router is DEFERRED. | Gemini Live already picks top-level tools natively; the per-step Gemini vision call (~1-3s + image tokens, up to 15x per task) is where the cost is. |
| D2 | All Jev HTTP calls and key handling in MAIN. Renderer calls IPC and never sees the key. | Keeps secret out of renderer/devtools; main already owns automation. |
| D3 | UIA runs in a SECOND warm PowerShell session (`src/uia.js`), not the input session in `automation.js`. | (a) UIA session must be per-monitor DPI aware (physical px), input session must stay DPI-unaware (main.js computer-action relies on logical coords, see comment at main.js:676); (b) a hung UIA call kill/restart must not take down the input session; (c) no head-of-line blocking of input on psChain. |
| D4 | Element-targeted actions execute INSIDE the UIA host (patterns, or SetCursorPos/mouse_event in the DPI-aware process). No coordinate round-trip through main.js computer-action. | UIA rects are physical (verified: root rect 1920x1080 while unaware GetSystemMetrics = 1536x864 at 125%). Same process for rect + click removes DPI conversion bugs. |
| D5 | Keyboard (Enter/Escape) and SendKeys typing still go through existing `automation.computerAction({action:'key'|'type'})`. | Coordinate-free; already reliable. |
| D6 | Managed UIA (`System.Windows.Automation`) with a `CacheRequest` + one `FindAll(Descendants)` per snapshot. | Measured on this machine: 13-234 elements in 16-196ms per window, cached. No TreeWalker (one cross-process call per node). |
| D7 | Flag: `settings.jevEnabled` (default `true`), env override `AURA_JEV=0` disables. Key: `settings.jevApiKey` > `process.env.TYPESAFE_API_KEY` > `.env TYPESAFE_API_KEY` > `.env jev`. Dashboard UI for these is DEFERRED (store fields only). | Smallest surface; user already has `.env`. |
| D8 | Any Jev/UIA failure degrades to the existing Gemini step for THAT step; repeated failures disable the Jev path for the rest of the run. Without key/flag, behavior is byte-for-byte the current Gemini-only loop. | Required clean degradation. |

Deferred (do NOT build): Jev pre-router for typed text, dashboard settings UI, `score` question type,
scrolling via ScrollPattern, multi-window/popup enumeration beyond the chosen window, Jev inside agent.html planner.

## 1. Files, in implementation order

1. `src/env-keys.js` (new, stub present)
2. `src/jev.js` (new, stub present)
3. `src/jev-step.js` (new, stub present) + `scripts/jev-step-selftest.js` (new)
4. `src/uia-host.ps1` + `src/uia.js` (new, stubs present) + `scripts/uia-dump.js` (new)
5. `scripts/jev-decide.js` (new)
6. `src/store.js` (modify: defaults)
7. `src/main.js` (modify: key load, 4 IPC handlers, last-snapshot cache, shutdown, logging)
8. `src/preload.js` (modify: 4 bridge methods)
9. `src/renderer/computer-use.js` (modify: hybrid loop)
10. `src/renderer/gemini-live.js` (modify: one tool-description sentence)

None of files 1-5 may `require('electron')` (scripts run them under plain node 22).

---

## 2. Data shapes

### 2.1 UiaElement (produced by host, one per interactive element)
```js
{
  id: 'e1',            // 'e' + 1-based position in THIS snapshot's elements array. Regex /^e[1-9]\d{0,2}$/
  i: 0,                // index into host-side $script:Last.Elements (0-based). Same order as elements[].
  type: 'Button',      // ControlType.ProgrammaticName minus 'ControlType.' prefix
  name: 'Save',        // Current.Name, whitespace-collapsed, trimmed, truncated to 80 chars
  aid: 'SaveBtn',      // AutomationId, '' if none, truncated to 60
  cls: 'Button',       // ClassName, truncated to 60
  rect: [x, y, w, h],  // PHYSICAL screen px, integers, clipped to window rect; w>0 && h>0 guaranteed
  focused: false,      // HasKeyboardFocus
  pats: ['invoke'],    // subset of 'invoke','toggle','select','expand','value' (from cached Is*PatternAvailable)
  value: 'abc',        // ONLY if 'value' in pats and not IsPassword; truncated to 60; else omitted
  readOnly: false,     // ONLY if 'value' in pats
  toggle: 'on'|'off'|'indeterminate', // ONLY if 'toggle' in pats
  selected: true,      // ONLY if 'select' in pats
  expand: 'collapsed'|'expanded'|'partial'|'leaf', // ONLY if 'expand' in pats
}
```

### 2.2 UiaSnapshot / UiaFailure (host -> uia.js -> main -> renderer)
```js
{ ok: true, snapshotId: 's42', ms: 183,           // host-measured
  hwnd: '0x1A2B3C', pid: 1234, process: 'notepad', title: 'Untitled - Notepad',
  fw: 'Win32',                                      // window FrameworkId ('Win32','WPF','XAML','Chrome','DirectUI',...)
  windowRect: [x, y, w, h],                         // physical px
  focused: { type, name, id } | null,               // focused element; id set only if it is in elements[]
  total: 312,                                       // candidates before cap
  truncated: true,
  elements: UiaElement[] }                          // length <= maxElements (default 200)

{ ok: false, reason: 'no_window'|'timeout'|'error'|'empty', detail?: string, ms?: number }
```
`snapshotId`: host counter `'s' + n`, strictly increasing per host process; restart resets n but uia.js
prefixes with a per-process generation, final form `'g<gen>s<n>'`. Only the latest snapshot is actable.

### 2.3 UiaActResult
```js
{ ok: true, method: 'invoke'|'toggle'|'select'|'expand'|'collapse'|'focus'|'mouse'|'set_value'|'wheel',
  point?: [x, y], verified?: boolean, ms }
{ ok: false, reason: 'stale_snapshot'|'stale_element'|'occluded'|'unsupported'|'timeout'|'error', detail?, ms? }
```
`timeout` means "outcome unknown" (e.g. Invoke that opened a modal and blocked), not "did nothing".

### 2.4 JevResult (src/jev.js)
Typedef in stub. `ok:false` on: fetch reject, abort/timeout (`status:null, error:'timeout'`),
non-2xx (`status`, `error` = `detail` string or `detail.message` from body, max 200 chars), bad JSON.

### 2.5 JevRequestBuilt (jev-step.buildJevRequest)
```js
{ state: string, questions: object,           // exact payload fields for /v1/systemone
  optionMap: { [optionKey]: { kind:'click', elementId, el } | { kind:'type', elementId, el }
                          | { kind:'key', key:'enter'|'escape' } | { kind:'scroll', direction:'up'|'down' }
                          | { kind:'done' } | { kind:'need_vision' } },
  literals: string[],                         // x1..xM candidates (index 0 = x1)
  approxTokens: number }                      // Math.ceil((state.length + largestQuestionJson.length) / 3.5)
```

### 2.6 JevDecision (jev-step.interpretJevAnswers -> main -> renderer)
```js
{ ok: true,
  kind: 'act' | 'done' | 'vision',
  op?: 'click'|'type'|'key'|'scroll',      // kind==='act'
  elementId?: 'e12', target?: 'Button "Save"',
  text?: string, key?: 'enter'|'escape', direction?: 'up'|'down',
  reason?: 'need_vision'|'low_conf'|'stuck'|'done_disagree'|'text_none'|'text_low_conf'|'bad_answer',
  choice: string, conf: number, goal: number, stuck: number, textConf?: number,
  top2: [[key, p], [key, p]],               // from probabilities, desc
  ms: number, usage: { input_tokens, output_tokens } }
{ ok: false, error: string, status?: number|null, ms: number }   // transport/API failure
```

### 2.7 StepRecord (renderer, `this._history` in ComputerUseAgent)
```js
{ step: 3, source: 'jev'|'gemini',
  desc: 'clicked Button "Save"',         // human, no eN ids (ids are per snapshot)
  key?: 'Button|Save|SaveBtn',           // elementKey, jev click/type only
  outcome: 'ok'|'failed'|'no_effect'|'unknown',
  conf?, goal?, ms?: { uia, jev, act } }
```

---

## 3. Per-file contract

### 3.1 `src/env-keys.js`
- `parseDotEnv(text)`: rules in stub. Key match exact-case. No variable expansion. Later duplicate keys win.
- `resolveJevKey({settingsKey, searchDirs})`: precedence in stub; empty/whitespace strings count as absent.
  Returns `source` only, main logs `jev key source=<source>` (never the value, never a prefix/suffix of it).
- Called from main with `searchDirs = [app.getAppPath(), process.cwd()]` (dedupe). Resolve lazily on each
  `jev-status`/`jev-decide` call (cheap; picks up settings edits without restart) but cache the .env file
  read once per process.

### 3.2 `src/jev.js`
- `jevCall`: `fetch(JEV_ENDPOINT, {method:'POST', headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'}, body, signal})`
  with `AbortController` timeout. Body `{model, state, questions}`. `ms` = wall time. Never throws.
- Invariant: error strings never contain the key or headers.

### 3.3 `src/jev-step.js` (pure)

**extractLiteralTexts(goal)** returns candidates, deduped, trimmed, length 1..200, max 5, order of appearance:
1. Double-quoted `"..."`, curly `“...”`, and backtick `` `...` `` segments.
2. Single-quoted `'...'` / `‘...’` ONLY when the opening quote is at start or preceded by whitespace/`(`
   and the closing quote is followed by end/whitespace/punctuation (so `don't` / `it's` never match).
3. Only if steps 1-2 found nothing: verb pattern, case-insensitive:
   `\b(type|write|enter|input|search(?: for)?|find)\s+(.+?)(?=\s+(?:in|into|on|at|inside|and|then|&)\b|[.,;!?]|$)`
   capture group 2. Discard captures that are only filler (`it`, `this`, `that`, `the text`, `something`).
   Examples that MUST pass in selftest:
   - `Type "hello world" in Notepad` -> `["hello world"]`
   - `search for cats on youtube` -> `["cats"]`
   - `type hello then press enter` -> `["hello"]`
   - `open the file menu and click Save` -> `[]`
   - `don't close it, type 'ok' in the box` -> `["ok"]`

**elementKey(el)**: `${el.type}|${el.name}|${el.aid}`.

**describeElement(el)**: `${type} "${name}"` + ` value="${value}"` if value present + ` [on|off]` toggle
+ ` [selected]` if selected + ` [collapsed|expanded]` + ` [readonly]` if readOnly. Name `""` when empty.
Inner `"` in name/value replaced with `'`. Newlines collapsed.

**formatHistoryEntry(entry, index)**: `${index+1}. [${source}] ${desc} -> ${outcomeText}` where
outcomeText: ok->`ok`, failed->`failed`, no_effect->`no visible change`, unknown->`result unknown`.

**snapshotSignature(snap)**: string of `hwnd|title|focused.type|focused.name|` + for each element
`type|name|value|toggle|selected|expand|round(rect/8)` joined by `;`. Deterministic; no ids, no ms, no snapshotId.

**buildJevRequest(snap, ctx)** - exact state layout (lines, `\n` separated):
```
TASK: <goal>
WINDOW: "<title>" (process: <process>, framework: <fw>)
FOCUSED: <id + describeElement | "<describe> (not in list)" | "(none)">
ELEMENTS (<n> shown of <total>):
e1 Button "Save"
e2 Edit "File name" value="report.txt"
...
TEXT CANDIDATES: x1 "hello world" | x2 "..."        <- line omitted when no literals
RECENT ACTIONS (oldest first):                       <- "(none)" when history empty
1. [gemini] pressed win -> ok
2. [jev] clicked Button "Save" -> no visible change
```
- History: last `LIMITS.maxHistory` entries of `ctx.history`.
- Questions (keys exactly `action`, `goal`, `stuck`, optional `text`):
  - `action` (choice). instructions: `Choose the single next UI action that best advances TASK. Choosing an element id clicks/activates that element. Choose need_vision if the needed control is not listed, the task needs anything these options cannot do (launching an app, a hotkey, drawing, reading images), or you are unsure.`
  - criteria, in this order:
    1. `e<k>` -> `click ${describeElement(el)}` for each element whose `elementKey` is NOT in `ctx.excludeKeys`.
    2. `t_e<k>` -> `type the text from TEXT CANDIDATES into ${describeElement(el)}`, ONLY if `literals.length>0`,
       for elements with type in {Edit, Document} or (ComboBox with 'value' in pats), not readOnly, not excluded.
       Max `LIMITS.maxTypeOptions`, focused element first.
    3. Always: `key_enter` (`press Enter to submit or confirm`), `key_escape` (`press Escape to close or cancel`),
       `scroll_down`, `scroll_up` (`scroll the window to reveal more content`), `done` (`the task is already complete`),
       `need_vision` (`none of these options fits, or unsure`).
  - `goal` (noul): `Is TASK already fully completed, judging only by WINDOW, ELEMENTS and RECENT ACTIONS?`
  - `stuck` (noul): `Are the RECENT ACTIONS repeating the same thing without making progress?`
  - `text` (choice) ONLY when `literals.length >= 2`: criteria `x1..xM` -> the literal, plus
    `x0` -> `none of these is the text that should be typed now`. instructions: `Which text should be typed next for TASK?`
- Trimming, applied in order until `approxTokens <= LIMITS.maxStateTokens` AND total action options `<= 255`:
  (a) elements already capped by host at 200; (b) drop non-focused elements from the END of the list,
  removing both their state line and `e<k>`/`t_e<k>` options; ids of kept elements DO NOT change
  (ids come from the snapshot, never renumber). Header counts reflect what is shown.
- Option keys: all match `/^[a-z][a-z0-9_]{0,15}$/`. Assert in selftest.

**interpretJevAnswers(answers, built, ctx)** - rules evaluated IN THIS ORDER, first match wins:
1. Missing/ill-typed `answers.action`/`goal`/`stuck`, or `choice` not in `optionMap` -> `vision/bad_answer`.
2. `goal >= THRESHOLDS.goal && ctx.executedCount >= 1` -> `done`.
3. `stuck >= THRESHOLDS.stuck` -> `vision/stuck`.
4. choice `need_vision` -> `vision/need_vision`.
5. choice `done` (goal below threshold) -> `vision/done_disagree`.
6. choice `t_e*`: conf < `THRESHOLDS.typeAction` -> `vision/low_conf`. Text: if 1 literal use it; else
   `text.choice==='x0'` -> `vision/text_none`; `text.confidence < THRESHOLDS.text` -> `vision/text_low_conf`;
   else literal `x<k>`. -> `act/type`.
7. Any other choice with conf < `THRESHOLDS.action` -> `vision/low_conf`.
8. `e*` -> `act/click`; `key_*` -> `act/key`; `scroll_*` -> `act/scroll`.
Always fill `choice, conf, goal, stuck, top2`.

### 3.4 `src/uia-host.ps1` + `src/uia.js`

**Process / protocol (uia.js)**
- Mirror `automation.js` `ensurePS`/`runPersistent` shape but with OWN state (`uiaProc`, `uiaBuf`,
  `uiaPending`, `uiaChain`, `uiaGen`). Spawn `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`, `windowsHide:true`.
- Startup: `fs.readFileSync(HOST_SCRIPT,'utf8')` -> write to `os.tmpdir()/aura_uia_host.ps1` (UTF-8 WITH BOM,
  so PS 5.1 reads non-ASCII correctly) -> stdin `. '<path>'\n`. Never pipe a here-string through stdin
  (known broken; verified: the same script via `-Command -` produced no output).
- Each call: `Invoke-AuraUia '<base64>'\nWrite-Output "<<AURA_UIA_DONE>>"\n`, base64 of UTF-8 JSON
  command. Response = text before sentinel; take the LAST line starting with `{`; `JSON.parse`; failure -> `{ok:false,reason:'error',detail:'bad host output'}`.
- Timeout per call: kill host, bump `uiaGen`, resolve `{ok:false, reason:'timeout'}`; next call respawns.
  Defaults: snapshot 2500ms, act 5000ms, ping 8000ms (first spawn includes ~500ms assembly load + C# compile).
- `uiaWarm()`: spawn + fire `{cmd:'ping'}`; errors swallowed.
- Serialize calls on `uiaChain` (one pending at a time), exactly like `psChain`.
- `uiaSnapshot` prefixes the host `snapshotId` with `g<uiaGen>` before returning.
  `uiaAct` strips/validates the prefix: gen mismatch -> `stale_snapshot` without calling the host.

**Host commands** (JSON in, one compact JSON line out, everything wrapped in try/catch -> `{ok:false,reason:'error',detail:<msg 200 chars>}`)
- `{cmd:'ping'}` -> `{ok:true, dpiOk:<bool>, cursorScale:<num>}`.
- `{cmd:'snapshot', excludePid, auraRects:[[x,y,w,h]...], maxElements}`:
  1. Window choice: `GetForegroundWindow()`; accept if visible, not iconic, pid != excludePid (empty title allowed:
     foreground is authoritative, covers `#32768` menus / dialogs). Else walk z-order from `GetTopWindow(0)` via
     `GetWindow(h, GW_HWNDNEXT=2)`, first with: visible, not iconic, pid != excludePid, title length > 0,
     no `WS_EX_TOOLWINDOW (0x80)`, not DWM-cloaked, class not in {Progman, WorkerW, Shell_TrayWnd,
     Shell_SecondaryTrayWnd}, non-empty rect. None -> `{ok:false, reason:'no_window'}`. Cap walk at 400 hwnds.
  2. `AutomationElement.FromHandle(h)`. CacheRequest (TreeFilter = `Automation.ControlViewCondition`,
     AutomationElementMode Full) with properties: Name, ControlType, AutomationId, ClassName,
     BoundingRectangle, IsOffscreen, IsEnabled, HasKeyboardFocus, IsPassword, FrameworkId,
     IsInvoke/Toggle/SelectionItem/ExpandCollapse/ValuePatternAvailable, ValuePattern.Value/IsReadOnly,
     TogglePattern.ToggleState, SelectionItemPattern.IsSelected, ExpandCollapsePattern.ExpandCollapseState.
  3. Condition: `And(IsOffscreen=false, IsEnabled=true, Or(ControlType in INTERACTIVE, IsInvokePatternAvailable=true))`.
     INTERACTIVE = Button, CheckBox, ComboBox, Edit, Hyperlink, ListItem, MenuItem, RadioButton, TabItem,
     TreeItem, SplitButton, Slider, Spinner, DataItem, Document.
     One `FindAll(TreeScope.Descendants, cond)` inside `using` the activated cache.
  4. Post-filter in order: rect non-empty and all four values finite; intersect with window rect (drop if empty);
     drop if center inside any `auraRects` AND element has none of invoke/toggle/select/expand/value;
     drop if name empty AND aid empty AND type not in {Edit, Document, ComboBox}.
  5. `total` = count after post-filter. Keep first `maxElements` in tree order, but if the focused element
     (from `AutomationElement.FocusedElement`, same window root only) is beyond the cap, replace the last kept one.
  6. Store kept live elements in `$script:Last = @{Id; Elements}`; emit snapshot JSON via
     `ConvertTo-Json -Compress -Depth 5` (or a StringBuilder writer if ConvertTo-Json is > 100ms for 200 items).
- `{cmd:'act', snapshotId, index, op, text?, direction?}`:
  - `snapshotId` != `$script:Last.Id` -> `stale_snapshot`. `ElementNotAvailableException` anywhere -> `stale_element`.
  - `op:'click'` order: (1) type in {Edit, Document} or editable ComboBox -> `SetFocus()` => `focus`;
    (2) Invoke available AND window fw NOT in {Win32, WinForm} -> `Invoke()` => `invoke`;
    (3) Toggle -> `Toggle()`; (4) SelectionItem -> `Select()`; (5) ExpandCollapse -> Expand if collapsed else Collapse;
    (6) else mouse: point = `TryGetClickablePoint` else rect center; if point inside an auraRect ->
    `occluded`; `SetForegroundWindow(hwnd)`, `SetCursorPos(round(x*CursorScale), round(y*CursorScale))`,
    LD/60ms/LU => `mouse`. Any pattern call throwing `InvalidOperationException` falls through to mouse.
  - `op:'focus'` -> `SetFocus()`.
  - `op:'set_value'` -> `ValuePattern.SetValue(text)`, re-read `Current.Value`, `verified = (value -eq text)`.
  - `op:'scroll'` -> mouse wheel `WHEEL` +/-360 (3 notches, up positive) at window-rect center (cursor-scaled).
- DPI: after `SetProcessDpiAwarenessContext(-4)`, `dpiOk = (GetSystemMetrics(0) == RootElement rect width)`.
  `CursorScale = dpiOk ? 1 : GetSystemMetrics(0) / rootWidth`. Primary-monitor assumption only for the non-dpiOk path.

### 3.5 `src/store.js`
Add to `settings` defaults: `jevEnabled: true`, `jevApiKey: ''`. Nothing else.

### 3.6 `src/main.js`
- `require('./uia')`, `require('./jev')`, `require('./jev-step')`, `require('./env-keys')`.
- Module state: `let lastSnapshot = null;` (full UiaSnapshot with elements).
- `jevConfig()` -> `{ enabled, key, source }`: `enabled = settings.jevEnabled !== false && process.env.AURA_JEV !== '0' && !!key && process.platform === 'win32'`.
- `auraPhysicalRects()`: for every visible, non-minimized Aura window (`allAuraWindows()`), `screen.dipToScreenRect(win, win.getBounds())` -> `[x,y,w,h]`.
- IPC (all `ipcMain.handle`, all must resolve, never reject):
  - `jev-status` -> `{ enabled, hasKey, source }`. Never the key.
  - `uia-snapshot` -> `uia.uiaSnapshot({excludePid: process.pid, auraRects, maxElements: 200})`; on ok set
    `snap.sig = snapshotSignature(snap)`, store in `lastSnapshot`, return it. On failure set `lastSnapshot = null`.
  - `uia-act` `({snapshotId, elementId, op, text, direction, key})`, composite ops in main:
    - `snapshotId !== lastSnapshot?.snapshotId` -> `{ok:false, reason:'stale_snapshot'}`.
    - `op:'click'|'scroll'` -> `uia.uiaAct` with `index = el.i` (element resolved from `lastSnapshot` by `elementId`; scroll needs no element).
    - `op:'type'`: (1) if `'value' in el.pats && !el.readOnly && el.type in {Edit, ComboBox} && lastSnapshot.fw !== 'Chrome'` -> `set_value`; done if `ok && verified`. (2) else `uiaAct focus` (ignore failure only if the element is already focused); if type in {Edit, ComboBox} -> `automation.computerAction({action:'key', key:'ctrl+a'})`; then `automation.computerAction({action:'type', text})`. Result method `'sendkeys'`.
    - `op:'key'` -> `automation.computerAction({action:'key', key})`.
    - After any act: settle 300ms before resolving.
  - `jev-decide` `({snapshotId, goal, history, excludeKeys, executedCount})`:
    `!cfg.enabled` -> `{ok:false, error:'disabled'}`; stale snapshotId -> `{ok:false, error:'stale_snapshot'}`;
    `built = buildJevRequest(lastSnapshot, ctx)`; `r = jevCall({key, state, questions, timeoutMs:4000})`;
    `!r.ok` -> `{ok:false, error, status, ms}`; else `interpretJevAnswers(r.answers, built, ctx)` + `ms, usage`.
- Debug log every decision (single line):
  `[jev] s=<snapshotId> elems=<n>/<total> tok~<approx> choice=<c> conf=<.2f> goal=<.2f> stuck=<.2f> top2=<k:p,k:p> <ms>ms -> <kind>[/<op>|/<reason>] <target>`
  and every snapshot: `[uia] <process> "<title 40>" elems=<n>/<total> host=<ms>ms rt=<ms>ms` or `[uia] FAIL <reason> <detail>`.
- `app.whenReady`: if `jevConfig().enabled` -> `uia.uiaWarm()`; log `jev key source=<source> enabled=<bool>` once.
- `will-quit`: add `try { uia.shutdownUia(); } catch {}`.
- Do NOT change `computer-action`, `take-screenshot-clean`, action mode, or any existing handler.

### 3.7 `src/preload.js`
Add under Automation: `jevStatus()`, `uiaSnapshot()`, `uiaAct(p)`, `jevDecide(p)` -> `ipcRenderer.invoke('jev-status'|'uia-snapshot'|'uia-act'|'jev-decide', p)`.

### 3.8 `src/renderer/computer-use.js`
Public API unchanged: `new ComputerUseAgent({onStep,onLog})`, `run({apiKey, goal, maxSteps, maxMs})` returns the same
kinds of strings, `abort()`. Existing Gemini behavior (prompt, thoughtSignature echo, safety ack, 429 retry,
`_executeAction`) is untouched; move the per-step Gemini body into `async _visionStep(ctx)` verbatim.

New per-run state (reset at start of `run`): `_history: StepRecord[]`, `_pendingForGemini: StepRecord[]`,
`_prevJev: {sig, key, step} | null`, `_excludeKeys: Set`, `_excludeHwnd`, `_jevErrors`, `_consecNoEffect`,
`_consecFallbacks`, `_jevSkip`, `_uiaCooldown`, `_jevOff`, `executedCount`, counters `{jev, gemini}`.

Per loop iteration (one iteration = one executed action; `maxSteps`, `maxMs`, `abort` semantics unchanged):
1. Existing abort/deadline checks.
2. `useJev = !_jevOff && status.enabled && _jevSkip === 0 && _uiaCooldown === 0` (status from `jevStatus()` once per run; IPC failure -> false). Decrement `_jevSkip`/`_uiaCooldown` when they block a step.
3. If `useJev`: `r = await this._jevStep(ctx)` returning `{handled:true, result?}` or `{handled:false, reason}`.
   `handled:true` with `result` string -> `return result` (done). `handled:true` -> `continue`.
4. Else / not handled -> `_visionStep`. Record a gemini StepRecord (desc from existing `lastSummary`, outcome `failed` if result starts with `failed:` else `ok`); `_prevJev = null`.
5. After every await: `if (this.aborted) return 'Cancelled.'`.

`_jevStep` contract:
- `snap = await withTimeout(uiaSnapshot(), 3500)`. `!ok` or 0 elements -> `{handled:false}`; if reason `timeout`/`error` set `_uiaCooldown = 2`.
- If `snap.hwnd !== _excludeHwnd` -> clear `_excludeKeys`, `_excludeHwnd = snap.hwnd`.
- No-effect detection: if `_prevJev` and `snapshotSignature(snap) === _prevJev.sig` -> mark that history entry `no_effect`,
  add `_prevJev.key` (if any) to `_excludeKeys`, `_consecNoEffect++`; else `_consecNoEffect = 0`. `_prevJev = null`.
  `snap.sig` is attached by main (renderer cannot require jev-step.js); renderer only compares strings.
- `_consecNoEffect >= 2` -> `{handled:false, reason:'no_effect'}` and reset `_consecNoEffect`.
- `d = await withTimeout(jevDecide({...}), 5000)`. `!d.ok`: `_jevErrors++`; `status===401||403` or `_jevErrors>=2` -> `_jevOff = true` (log once); `{handled:false}`. On ok `_jevErrors = 0`.
- `d.kind==='done'` -> `{handled:true, result: 'Done: ' + last 1-3 history descs joined '; '}`.
- `d.kind==='vision'` -> `_consecFallbacks++`; `_jevSkip = min(2, _consecFallbacks - 1)`; `{handled:false}`.
- `d.kind==='act'` -> `_consecFallbacks = 0`; `onStep({action: 'uia_' + d.op, args:{target:d.target, text:d.text, conf:d.conf}})`;
  `res = await withTimeout(uiaAct({...}), 8000)`; outcome `ok` / `unknown` (reason timeout) / `failed`.
  `stale_snapshot|stale_element|occluded|unsupported` -> outcome `failed`, and return `{handled:false}` so the SAME
  iteration falls to vision (do not burn a step on nothing). Otherwise push StepRecord to `_history` and
  `_pendingForGemini`, set `_prevJev = {sig: snap.sig, key: elementKey or null, step}`, `executedCount++`,
  `_log('⚡ <desc> (<conf>) <ms>ms')`, return `{handled:true}`.
- Vision step injection: when `_pendingForGemini.length`, add a text part BEFORE the inlineData in the new user
  screenshot turn: `Actions already performed by the fast element path since your last action:\n<formatted lines>\nThe screenshot shows the result.` Then clear `_pendingForGemini`. Never modify model turns.
- `executedCount` also increments after each Gemini action.
- End of run (every return path incl. Cancelled/limits): `_log('run: <n> steps (<jev> jev, <gemini> gemini)')`.
  Use try/finally.

### 3.9 `src/renderer/gemini-live.js`
Append to the `do_computer_task` `goal` parameter description: ` Put any exact text that must be typed in double quotes, e.g. Type "hello world" into Notepad.` Nothing else.

---

## 4. Invariants
- I1 No key: `jevStatus().enabled === false` -> loop never calls uiaSnapshot/jevDecide; behavior identical to today.
- I2 Renderer never receives, logs, or stores the Jev key. Logs never contain it (grep check in verification).
- I3 Every IPC handler added resolves (never rejects, never hangs past its timeout).
- I4 Only the latest snapshot is actable; ids are never reused across snapshots within a host generation.
- I5 `optionMap` keys ⊆ `/^[a-z][a-z0-9_]{0,15}$/`, count ≤ 255, always contains `need_vision` and `done` (no single-option degenerate choice; verified: a 1-option choice returns confidence 1.0).
- I6 A Jev step that fails before any input is sent does not consume a step; one iteration = at most one executed action.
- I7 `abort()` is honored after every await in both paths; `maxSteps`/`maxMs` unchanged.
- I8 The input PS session (automation.js) and its coordinate conventions are untouched.
- I9 Jev never types text that is not verbatim from `extractLiteralTexts(goal)`.

## 5. Exit conditions (run returns)
Unchanged ones plus: Jev `done` (rule 2) -> `Done: <descs>`. No other new exits. Jev/UIA errors never end a run.

## 6. Traps (read before coding)
1. **Here-strings via stdin break.** Only in the dot-sourced file. Per-call payloads go base64 on one line.
2. **UTF-8.** Set `[Console]::OutputEncoding` in host; `proc.stdout.setEncoding('utf8')`; write host file with BOM.
   Verified: without it, non-ASCII window titles print as `????`.
3. **Infinity in rects.** Offscreen/empty `BoundingRectangle` is `Rect.Empty` (Infinity). PS 5.1 `ConvertTo-Json` emits invalid JSON for it. Filter before serializing.
4. **ConvertTo-Json depth.** Default depth 2 truncates `rect` arrays to strings. Use `-Depth 5 -Compress`.
   Single-element arrays: build `pats`/`rect` as `@(...)` and verify they stay arrays in output.
5. **Cached pattern props on unsupported elements** return `AutomationElement.NotSupported`, not null. Check `Is*PatternAvailable` first.
6. **DPI.** UIA rects are physical. Never pass them to main.js `computer-action` (expects normalized, logical). Clicks happen in the DPI-aware host only.
7. **Aura's own windows.** Electron top-level HWNDs belong to the MAIN process pid -> `excludePid = process.pid` (main), not a renderer pid. Voice path does NOT enter action mode, so the pill is visible and may be foreground: that is why the z-order walk exists.
8. **Invoke can block** on Win32 buttons that open modal dialogs. Hence fw Win32/WinForm -> mouse click, and act timeout -> outcome `unknown` (not failed, not retried).
9. **Chrome/Electron:** `SetValue` bypasses JS input events; use focus + SendKeys (`fw === 'Chrome'`). First UIA query on a Chrome window can be slow while it enables accessibility; that is why snapshot timeout is 2500ms and `_uiaCooldown` exists.
10. **Menus/popups** are often separate top-level windows not under the target's subtree. Accepted limitation: Jev picks `need_vision`. Do not add cross-window enumeration.
11. **Ids are per snapshot.** History and `excludeKeys` use `elementKey`/descriptions, never `eN`.
12. **Settle before snapshot.** Patterns return before the UI repaints; the 300ms settle in `uia-act` is what makes no-effect detection not fire falsely.
13. **Gemini contents shape.** Injected Jev history is a `text` part in a user turn. Do not add model turns, do not drop `thoughtSignature`.
14. **Renderer cannot `require`** (contextIsolation, no nodeIntegration). All jev-step logic runs in main; renderer consumes `snap.sig` and decisions.
15. **`noul` is P(yes)** (verified: not-done task -> goal 0.02). Thresholds compare `>=`.
16. **Error bodies differ:** 400 -> `{"detail":"<string>"}`, 401 -> `{"detail":{"error_type","message"}}`. Handle both.
17. **Two sessions, two sentinels.** Do not reuse `<<AURA_DONE>>`; a stray write from one must never resolve the other.
18. **Never echo the key** in curl/test commands; read it inside the command.

## 7. Verification plan (coder must run all; Git Bash commands unless noted)

1. Pure logic:
   `node scripts/jev-step-selftest.js` -> uses `node:assert`, fixture snapshot with 230 fake elements incl. an
   Edit, a CheckBox, a focused element at index 220. Asserts: literal-extraction examples in 3.3; option keys regex;
   option count ≤ 255 and elements capped with focused kept; `need_vision`/`done` present; `t_e*` absent when no
   literals; `text` question present only for ≥2 literals; every interpret rule 1-8 with synthetic answers; signature
   equal for identical snaps and different when one toggle flips; `parseDotEnv` on `jev=abc` (no newline), BOM, quotes, CRLF.
   Prints `ALL PASS`.
2. UIA dump (live): `node scripts/uia-dump.js --delay 3 [--json]`. Focus Notepad within 3s. Prints window line,
   `n/total`, host ms, round-trip ms, first 40 described elements, then repeats snapshot 5x and prints p50/max.
   Acceptance: Notepad and File Explorer p50 < 400ms round trip (warm), a Chrome tab < 1500ms; no `????` on a
   non-ASCII title; all rects finite; exit code 0. Also run with nothing but the desktop focused -> `no_window` or a valid window, no crash.
   Add `--act e<k>` flag: clicks that element through `uiaAct` (try Notepad `File` menu item) and prints the result/method.
3. Jev decision (live): `node scripts/jev-decide.js --delay 3 --goal "open the File menu"` with Notepad focused.
   Loads key via `resolveJevKey({searchDirs:[process.cwd()]})`, prints `source` only, approxTokens, choice, conf,
   goal, stuck, top2, ms. Expect choice = the File MenuItem id with conf ≥ 0.85, goal < 0.5. Second run:
   `--goal "type \"hello\" in the editor"` -> expect `act/type` with text `hello`. Max 4 live calls total.
4. Key hygiene (after the smoke test; prints only a count, key never on a command line):
   `grep -cFf <(sed -E 's/^[^=]*=//' .env | tr -d '\r') "$APPDATA/aura/aura-debug.log"` -> `0`.
   Also `grep -rn "jevApiKey\|Bearer" src/renderer` -> no matches.
5. Smoke: `npm start`, then via voice or agent console: "open notepad and type \"hello from aura\"".
   Expect in `%APPDATA%\aura\aura-debug.log`: `jev key source=.env enabled=true`, `[uia] ...` lines, at least one
   `[jev] ... -> act/type`, text appears in Notepad, run summary shows jev ≥ 1. Then "click the Format menu in notepad"
   -> expect a jev click, no Gemini request for that step.
6. Degradation: set env `AURA_JEV=0` (PowerShell: `$env:AURA_JEV='0'; npm start`) -> log `enabled=false`, no `[uia]`/`[jev]` lines, task still completes via Gemini. Then temporarily rename `.env` -> same result. Restore `.env`.
7. Abort: start a long task, interrupt by speaking; log shows `Cancelled.` path within one step, no further `[uia]` lines.
