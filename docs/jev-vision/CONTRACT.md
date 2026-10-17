# CONTRACT: Jev Vision mode (text command -> Gemini text plan -> Jev screenshot+Box execution)

Status: design fixed, not implemented. Branch `jev-vision-only`. Read `docs/jev-uia/CONTRACT.md` sections 2.1
(UiaElement/UiaSnapshot shapes) and 6 (traps 3, 6, 7, 9, 12, 15, 16, 18) first; they all still apply.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| V1 | The whole run loop executes in MAIN (`src/jev-vision-runner.js`, deps injected). Renderer sends one `jev-vision-run` IPC and receives progress events. | Capture, UIA, Jev HTTP, Gemini HTTP and input all live in main already. Running the loop in the renderer (like `computer-use.js`) would add 3-4 IPC hops per step and expose keys. Deps injection keeps the loop testable under plain node with fakes. |
| V2 | Gemini picks the operation and the literals (planner). Jev does NOT choose the op. Per step Jev answers: did the previous step take effect (`prev_done`), is the target visible (`visible`), where is it (`target` Box), which UIA element is it (`element` choice), is the screen obstructed (`blocked`), is the click consequential (`risky`), is the whole task done (`task_done`, final call only). | Jev cannot produce text or keys; an op choice from Jev would only add a failure mode. The planner already knows the op. This deviates from the brief's "op choice over click/.../task_done" on purpose. |
| V3 | Verification of step i-1 and grounding of step i ride in ONE Jev call (one image). Steps whose `done_when` is empty are not verified. Deterministic steps (`open_app`, `hotkey`, `wait`, `type`/`scroll` without target) need no Jev call when there is nothing to verify. | Halves Jev calls; replaces fixed sleeps with verify-polls. |
| V4 | Planner is skipped for single-clause trivial commands (`parseTrivialCommand`). Otherwise exactly one Gemini text call (`generateContent`, JSON schema output, no audio, no image). Replans bounded by `maxReplans` (2). | Latency; Gemini is planner only. |
| V5 | Click target: UIA element when Jev picks one confidently AND it agrees with the Box (center inside Box expanded 25%) or no usable Box exists; otherwise Box center. | UIA click is pixel-exact; Box is grounded in what is actually visible (disambiguates duplicate names). |
| V6 | Screenshot = PRIMARY display only, whole display, aspect preserved. Box normalized coords map 1:1 onto the primary display. Box clicks go through `automation.computerAction` with `nx/ny` (0..999) and the same logical ctx main's `computer-action` IPC builds. UIA element clicks go through `uia.uiaAct` (physical, inside the DPI-aware host). | Reuses both existing, verified coordinate conventions; never mixes them (old trap 6). Multi-monitor beyond primary is an accepted limitation. |
| V7 | Image transport default multipart (`FormData` + `Blob`, raw JPEG bytes); `json` (base64 assets) selectable for fallback. Screenshot referenced exactly ONCE (in `state.screenshot`); questions refer to it as `` `screenshot` ``. | Billing per reference; no base64 overhead. |
| V8 | Mode flag: env `AURA_JEV_VISION` (`'0'` off, anything else on), default constant `JEV_VISION_DEFAULT = true` in main.js. No store setting. | A new settings field would be wiped by the dashboard "save" merge in `store-set` (main.js:721) unless that merge is also extended; not worth it for a branch experiment. |
| V9 | Consequential actions are never auto-executed: confirmed by a native `dialog.showMessageBox` in main (30 s timeout = decline). With `AURA_JV_CONFIRM=0` they are refused instead (never silently executed). | Safety; the pill is hidden during the run so the dialog must be native. |
| V10 | No voice in, no voice out. In this mode `app.js` never constructs `GeminiLive`; the hotkey/orb opens the text input. `gemini-live.js` stays loaded but inert. | Requirement. |

Deferred (do NOT build): multi-monitor targets, drag, typing text not supplied by planner/user, image-based replanning,
zstd/gzip request encoding, dashboard UI for the flag, changes to `computer-use.js` / Gemini Live tools / agent.html.

## 1. Files, in implementation order

| # | File | New/Mod | Responsibility | electron? |
|---|---|---|---|---|
| 1 | `src/jev-vision.js` | new | PURE: config parsing, image size fitting/validation, plan validation, trivial-command parser, consequential check, request builder, answer interpreter, coord mapping, action signature. | NO (plain node) |
| 2 | `src/jev.js` | mod | Add `jevCallImages` + `buildJevHttpBody`; shared response handling; 429/529 single retry. `jevCall` behavior unchanged. | NO |
| 3 | `src/env-keys.js` | mod | Add `resolveGeminiKey`. | NO |
| 4 | `src/jev-planner.js` | new | Gemini text planner + replanner; returns validated Plan. | NO |
| 5 | `src/jev-vision-runner.js` | new | `runVisionTask(instruction, deps, cfg)`: the step loop. Only talks to the world through `deps`. | NO |
| 6 | `src/screen-capture.js` | new | `capturePrimaryJpeg`, `primaryDisplayInfo` (desktopCapturer/screen). Shared by main and the probe. | YES |
| 7 | `scripts/jev-vision-selftest.js` | new | Pure + fake-deps runner tests. No network. | NO |
| 8 | `scripts/jev-vision-probe.js` | new | Live: one screenshot, one Box+noul call, prints latency and box. Runs under `npx electron`. | YES |
| 9 | `src/main.js` | mod | `jevVisionConfig()`, deps wiring, 3 IPC handlers, progress events, confirm dialog, abort on toggle hotkey, warmups. | YES |
| 10 | `src/preload.js` | mod | 4 bridge methods. | - |
| 11 | `src/renderer/app.js` | mod | Vision-mode UI: text input instead of voice, run/progress/result display. | - |

MUST NOT change: `src/jev-step.js`, `src/renderer/computer-use.js`, `src/renderer/gemini-live.js`, `src/automation.js`,
`src/uia.js`, `src/uia-host.ps1`, the existing `jev-status`/`jev-decide`/`uia-snapshot`/`uia-act`/`computer-action`
handlers, `scripts/jev-step-selftest.js` (must still print `ALL PASS`).

## 2. Data shapes

### 2.1 VisionConfig (`readVisionConfig(env)` in jev-vision.js; `DEFAULT_VISION_CFG` exported, frozen)
```js
{
  model: 'jev-1.14.0',          // AURA_JEV_VISION_MODEL
  transport: 'multipart',       // AURA_JV_TRANSPORT: 'multipart'|'json'
  imgMaxSide: 1280,             // AURA_JV_IMG_MAX, clamped 280..1568
  jpegQuality: 70,              // AURA_JV_JPEG_Q, clamped 30..95
  jevTimeoutMs: 6000,           // AURA_JV_TIMEOUT_MS (image calls)
  settleMs: 150,                // AURA_JV_SETTLE_MS, extra wait after an action before next capture
  pollIntervalMs: 300,          // AURA_JV_POLL_MS, wait between verify polls
  appWaitMs: 8000,              // AURA_JV_APP_WAIT_MS, max verify-poll window after open_app
  maxPolls: 4,                  // AURA_JV_MAX_POLLS, verify/ground polls per step (non open_app)
  uia: true,                    // AURA_JV_UIA ('0' off)
  uiaTimeoutMs: 1500,           // AURA_JV_UIA_TIMEOUT_MS (host kill on timeout, see trap T9)
  uiaGraceMs: 250,              // wait for UIA after capture finished before going without it
  uiaMaxElements: 80,           // AURA_JV_UIA_MAX
  maxActions: 25,               // AURA_JV_MAX_ACTIONS
  maxJevCalls: 40,              // AURA_JV_MAX_CALLS
  maxMs: 120000,                // AURA_JV_MAX_MS
  maxReplans: 2,                // AURA_JV_MAX_REPLANS
  sameActionLimit: 3,           // identical action signature executed this many times -> stop/replan
  confirm: true,                // AURA_JV_CONFIRM ('0' = refuse consequential instead of asking)
  finalVerify: true,            // AURA_JV_FINAL_VERIFY ('0' skips the task_done call)
  plannerModel: 'gemini-3.6-flash', // AURA_PLANNER_MODEL
  plannerTimeoutMs: 8000,       // AURA_PLANNER_TIMEOUT_MS
  thresholds: { prevDone: 0.6, taskDone: 0.7, visible: 0.5, boxConf: 0.3, boxMaxArea: 0.25,
                element: 0.7, risky: 0.5, blocked: 0.8 },   // not env-configurable
}
```
Unparseable/out-of-range env values fall back to the default (never NaN).

### 2.2 PlanStep / Plan
```js
PlanStep = {
  op: 'click'|'double_click'|'right_click'|'type'|'hotkey'|'scroll'|'open_app'|'wait',
  target?: string,      // visual description; REQUIRED for click family; optional for type (field to click first) and scroll (where)
  text?: string,        // REQUIRED for type; 1..500 chars; typed VERBATIM
  keys?: string,        // REQUIRED for hotkey; /^[a-z0-9]+(\+[a-z0-9]+)*$/i, <=40 chars, e.g. 'ctrl+l', 'enter', 'win+d'
  app?: string,         // REQUIRED for open_app; passed to automation.openApp(name)
  direction?: 'up'|'down', amount?: 1..15,   // scroll; default down, 5
  seconds?: number,     // wait; clamped 0.2..5
  submit?: boolean,     // type: press enter after
  clear?: boolean,      // type: ctrl+a before typing
  done_when?: string,   // visible post-condition, '' = do not verify; <=200 chars
  risky?: boolean,      // planner says consequential
}
Plan = { steps: PlanStep[] /* 1..12 */, source: 'trivial'|'gemini'|'replan' }
```
`validatePlan(raw) -> { ok:true, plan } | { ok:false, error }`: drops nothing silently; any invalid step -> `ok:false`
with the step index in `error`. Strings trimmed, newlines collapsed to spaces, backticks removed from
`target`/`done_when` (NOT from `text`). Steps beyond 12 truncated (allowed, logged).

### 2.3 Planner I/O (`src/jev-planner.js`)
```js
planTask({ key, instruction, model, timeoutMs, signal }) -> Promise<{ok:true, plan, ms} | {ok:false, error, status?, ms}>
replanTask({ key, instruction, done: string[], failed: {step: PlanStep, reason: string},
             screen: {title, process, elements: string[] /* <=30 describeElement lines */} | null,
             model, timeoutMs, signal }) -> same; plan = REMAINING steps only, source 'replan'
```
Request: `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, header
`x-goog-api-key: <key>` (NOT `?key=` in the URL), body `{systemInstruction, contents:[{role:'user',parts:[{text}]}],
generationConfig:{responseMimeType:'application/json', responseSchema:<PlanStep[] schema wrapped in {steps}>,
temperature:0.2, maxOutputTokens:2048, thinkingConfig:{thinkingLevel:'low'}}}`. Parse
`candidates[0].content.parts[*].text` joined, strip ``` fences defensively, `JSON.parse`, then `validatePlan`.
System prompt must state: Windows 11 desktop; allowed ops and fields exactly as 2.2; `text` is the exact literal
to type, copied from the user's instruction or required to complete it (URLs, search queries); prefer `open_app`
to launch apps, `hotkey ctrl+l` + `type ... submit:true` for URLs in a browser; targets are short unique visual
descriptions ("blue Send button at the bottom right of the compose window"); `done_when` describes what is
visible after success and is `''` when not visually checkable; `risky:true` for send/delete/buy/pay/post/submit
forms; max 12 steps; output JSON only.

### 2.4 VisionBuilt (`buildVisionRequest(ctx)` in jev-vision.js)
```js
ctx = { task: string, step: PlanStep|null /* step to ground now */, verify: PlanStep|null /* previous step to verify */,
        final: boolean, snap: UiaSnapshot|null, display: DisplayInfo, cfg: VisionConfig }
-> { state: { screenshot: SCREEN_REF, task: string, step?: string },
     questions: { prev_done?, visible?, target?, element?, blocked?, risky?, task_done? },
     elementMap: { [eid]: UiaElement },     // only elements offered as options
     ref: SCREEN_REF,
     flags: { verify: boolean, ground: boolean, final: boolean, riskyAsked: boolean } }
```
`SCREEN_REF = 'aura_screen_capture_img'` (exported). Question rules:
- `prev_done` (noul) iff `verify && verify.done_when`: `"Looking at \`screenshot\`, is this true: <done_when>"`.
- When `step` is click family, or `type`/`scroll` with `target` (= "ground"):
  - `visible` (noul): `"Is <target> visible and not covered in \`screenshot\`?"`
  - `target` (box, NO criteria): `"Locate <target> in \`screenshot\`. Box only that control, tightly."`
  - `element` (choice) iff `snap` has >=1 eligible element: criteria `{ eN: 'click ' + describeElement(el), ..., none: 'none of these is <target>' }`,
    instructions `"Which listed element is <target> as seen in \`screenshot\`?"`. Eligible = name or aid non-empty AND
    rect center inside primary physical rect; first `cfg.uiaMaxElements`, focused kept. `none` always present.
  - `blocked` (noul): `"Is an unexpected dialog, error, sign-in or permission prompt, or loading screen covering \`screenshot\`?"`
  - `risky` (noul) iff click family: `"Would clicking <target> send, delete, buy, pay, publish or do something hard to undo?"`
- `task_done` (noul) iff `final`: `"Judging only by \`screenshot\`, is \`task\` fully complete?"`
- `state.step` = `describeStep(step)` when grounding, omitted otherwise.
- `<target>`/`<done_when>`/`task` pass through `sanitizeText`: remove backticks, remove every occurrence of
  `SCREEN_REF`, collapse whitespace, cap 200 chars (task 500).
- At least one question always exists (builder is only called when there is something to ask; assert).

### 2.5 VisionRead (`interpretVisionAnswers(answers, built, display, cfg)`)
```js
{ ok: boolean, reason?: 'bad_answer',          // ok:false only when a question that was ASKED has a wrong shape
  prevDone: number|null, taskDone: number|null, visible: number|null, blocked: number|null, risky: number|null,
  box: { left, top, right, bottom, confidence } | null,
  boxReject: 'invalid'|'too_large'|'low_conf'|null,
  element: { id, conf } | null,               // null if 'none', unknown id, or conf < thresholds.element
  click: { source: 'element', elementId, nx, ny } | { source: 'box', nx, ny } | null,
  clickReason: 'element'|'element_agrees'|'box'|'element_box_disagree'|'not_visible'|'no_target' }
```
Box answer shape: `{type:'box', box:{top,bottom,left,right}, confidence}`. Valid iff all four finite, in [0,1],
`left<right`, `top<bottom`. `too_large` iff area > `boxMaxArea`. `low_conf` iff confidence < `boxConf`.
`click` resolution (V5): if `visible < thresholds.visible` -> null/`not_visible`. Else element+box both usable:
element center (normalized) inside box expanded by 25% of its width/height -> element (`element_agrees`), else box
(`element_box_disagree`). Only element -> element. Only box -> box. Neither -> null/`no_target`.

### 2.6 Coord mapping (pure, jev-vision.js)
```js
DisplayInfo = { dipW, dipH, physX, physY, physW, physH, scaleFactor }   // primary display; phys from screen.dipToScreenRect
boxCenterToNormalized(box) -> { nx, ny }           // nx = clamp(((left+right)/2)*1000, 0, 999), same for y; NOT rounded (resolveXY rounds)
elementCenterToNormalized(el, display) -> { nx, ny } | null  // ((x + w/2 - physX)/physW)*1000; null if outside [0,1000)
normalizedToPhysical({nx,ny}, display) -> { x, y }  // logging / probe only
```

### 2.7 Image sizing (pure)
```js
IMAGE_LIMITS = { minSide: 280, maxSide: 1568, minPixels: 78400, maxPixels: 2458624 }
fitImageSize(srcW, srcH, maxSide) -> { width, height } | null
  // longest side = min(maxSide, 1568, longest src side) (no upscaling unless needed for minSide),
  // aspect preserved, integers; if short side < 280 scale up so it is 280; null if result still violates limits.
validateImageDims(w, h) -> boolean
```

### 2.8 Jev image client (`src/jev.js`)
```js
buildJevHttpBody({ model, state, questions, images, transport }) ->
  { body: FormData|string, headers: Record<string,string> }
  // images: [{ ref, part, buffer: Buffer, format: 'jpeg'|'png' }]
  // multipart: FormData with 'request' = Blob([JSON], {type:'application/json'}) (+ filename 'request.json'),
  //   one file part per image named `part` (Blob type image/jpeg|png); JSON assets: { [ref]: {type:'image', format, part} }.
  //   headers: Authorization is added by caller; 'TypeSafe-Danger-Zone-Images':'true'; NO Content-Type (fetch sets boundary).
  // json: assets { [ref]: {type:'image', format, data_base64} }; headers Content-Type application/json + the danger header.
jevCallImages({ key, model, state, questions, images, transport='multipart', timeoutMs=6000, signal }) -> Promise<JevResult>
  // JevResult as today (+ answers may contain box answers). Never throws. One retry on 429/529 after
  // max(300, Retry-After*1000 if <=2s) ms, only if time remains in timeoutMs and not aborted.
  // External `signal` abort -> { ok:false, status:null, error:'aborted' }; own timer -> 'timeout'.
```

### 2.9 Runner (`src/jev-vision-runner.js`)
```js
runVisionTask(instruction: string, deps: VisionDeps, cfg: VisionConfig) -> Promise<RunResult>

VisionDeps = {
  capture():   Promise<{ ok:true, jpeg:Buffer, width, height, ms } | { ok:false, error }>,
  uiaSnapshot(): Promise<UiaSnapshot|UiaFailure>,           // bound to cfg.uiaTimeoutMs by main
  uiaClick({ snapshotId, index }): Promise<UiaActResult>,   // uia.uiaAct op 'click'
  input(params): Promise<{ success:boolean }>,              // automation.computerAction with LIVE display ctx bound
  openApp(name): Promise<any>,
  jev({ state, questions, image }): Promise<JevResult>,     // jevCallImages with key/model/transport/timeout/signal bound
  plan(instruction): Promise<PlannerResult>|null,           // null when no Gemini key
  replan(args): Promise<PlannerResult>|null,
  confirm(text): Promise<boolean>,
  display(): DisplayInfo,                                   // read at call time
  log(line), progress(evt),
  now(): number, sleep(ms): Promise<void>,
  signal: { aborted: boolean },
}
RunResult = { ok: boolean, status: 'done'|'unverified'|'failed'|'cancelled'|'refused'|'error',
              summary: string, actions: number, jevCalls: number, replans: number, plannerMs: number, ms: number }
ProgressEvt = { phase: 'planning'|'step'|'verify'|'replan'|'confirm'|'end', index?, total?, desc?, result?: RunResult }
```
Run state: `plan`, `i` (current step), `pendingVerify` (PlanStep|null + `actedAt` time), per-step `polls`,
`retried` (set of step indexes re-executed once), `sigCounts` (Map signature->count), `consecJevErrors`,
`uiaOff` (bool), `history` (desc strings).

Loop semantics (contract, not code):
1. Plan: `parseTrivialCommand` -> Plan(source trivial), else `deps.plan`. No Gemini key / planner error -> `error`.
   Capture+UIA for the first step start IN PARALLEL with the planner call (result reused if the plan's step 0
   needs grounding and the planner returned within `cfg.settleMs*4` of the capture, else re-captured).
2. Each iteration decides what it needs: verify = `pendingVerify?.done_when`; ground = current step needs a
   target; final = `i === steps.length`. Nothing needed -> execute deterministic step directly (no capture).
3. Observe: capture (+ UIA when ground && cfg.uia && !uiaOff; UIA awaited at most `uiaGraceMs` after capture;
   a UIA `timeout` sets `uiaOff=true` for the rest of the run). One `deps.jev` call. Counted in `jevCalls`.
4. Verify outcome: `prevDone >= prevDone` threshold -> verified, clear pendingVerify. Else poll (sleep
   `pollIntervalMs`, re-observe, no action) until `polls >= maxPolls` (open_app: until `appWaitMs` since actedAt).
   Exhausted: re-execute the previous step ONCE if it is click family (back to ground it again); type/hotkey/
   open_app/scroll are never re-executed -> replan (reason `not_verified`).
5. Ground outcome: `click` non-null -> act. Null: if `blocked >= blocked` or `not_visible`/`no_target` -> poll as
   in 4, then replan (reason `target_not_found` / `obstructed`).
6. Safety gate BEFORE any click-family action and before a `type` with `submit` or a `hotkey` step whose plan step
   is risky: consequential iff `step.risky || isConsequential(step) || (risky noul >= risky)`. Then
   `cfg.confirm ? await deps.confirm(text) : false`; false -> return `refused` (no input sent).
7. Act (one plan step = one action unit): click family -> element via `uiaClick` (plain click only) or
   `input({action, nx, ny})`; double/right on an element use its normalized center via `input`. uiaClick result
   `stale_snapshot`/`stale_element` -> fall back to element center via `input`; `occluded` -> box point if present
   else treat as no_target; `timeout` -> outcome unknown, still go to verify (never re-click).
   type: optional ground+click, `clear` -> `input({action:'key',key:'ctrl+a'})`, `input({action:'type',text})`,
   `submit` -> `input({action:'key',key:'enter'})`. hotkey -> `input({action:'key',key:keys})`. scroll ->
   `input({action:'scroll_'+dir, nx, ny, clicks:amount})` at box center or 500/500. open_app -> `deps.openApp`.
   wait -> `deps.sleep(seconds*1000)`. Then `sleep(settleMs)`, set pendingVerify, `i++`.
8. Repeat guard: `actionSignature(step, click)` (op | nx,ny bucketed by 20 | text | keys) counted; reaching
   `sameActionLimit` -> replan (reason `repeating`), or `failed` if no replans left.
9. Replan: `replans < maxReplans` and `deps.replan` -> plan = steps[0..i) + new steps; pendingVerify cleared.
   Else -> `failed` with reason.
10. Final: when `i === steps.length`: if `finalVerify` -> one call with `prev_done` (if pendingVerify) + `task_done`;
   `prevDone>=` or `taskDone>=` -> `done`; else poll up to `maxPolls`, then `unverified` (ok:true). `finalVerify`
   off -> `done` after the last pendingVerify is verified (or immediately if none).
11. Limits checked at the top of every iteration: `signal.aborted` -> `cancelled`; `now()>start+maxMs`,
   `actions>=maxActions`, `jevCalls>=maxJevCalls` -> `failed` with the limit name.
12. Jev errors: status 401/403 -> `error` immediately; others -> `consecJevErrors++`, `>=2` -> `error`, else
   retry the same observation (does not count as a poll). Shape error (`ok:false` read) counts like a Jev error.

### 2.10 IPC (main.js) and bridge (preload.js)
```js
ipcMain.handle('jev-vision-status') -> { enabled, hasJevKey, hasPlannerKey, model }
ipcMain.handle('jev-vision-run', (_e, instruction)) -> RunResult      // resolves always; busy -> {ok:false,status:'error',summary:'busy'}
ipcMain.handle('jev-vision-abort') -> true
mainWindow.webContents.send('jev-vision-progress', ProgressEvt)
preload: jevVisionStatus(), jevVisionRun(text), jevVisionAbort(), onJevVisionProgress(cb)
```

## 3. Per-file contract

### 3.1 `src/jev-vision.js` (pure, no I/O, no electron, no fetch)
Exports: `DEFAULT_VISION_CFG, readVisionConfig, IMAGE_LIMITS, fitImageSize, validateImageDims, SCREEN_REF,
sanitizeText, validatePlan, parseTrivialCommand, isConsequential, describeStep, buildVisionRequest,
interpretVisionAnswers, boxCenterToNormalized, elementCenterToNormalized, normalizedToPhysical, actionSignature`.
Reuse `describeElement` from `./jev-step` (require it; do not copy).
- `parseTrivialCommand(text) -> Plan|null`. Only when the text is a single clause (no `and`, `then`, `after`, `,`,
  `;`, `&` outside quotes). Patterns: `open|launch|start <app>` -> open_app (done_when `''`, verification via
  final task_done); `(double[- ]click|right[- ]click|click|tap) [on] [the] <target>` -> click family;
  `press <keys>` when keys matches the hotkey grammar after normalizing spaces/`plus` to `+` -> hotkey;
  `type "<lit>"` (quoted literal only) -> type without target; `scroll up|down` -> scroll. Anything else null.
- `isConsequential(step)`: regex over `target`, `text`, `keys`(none), `app`: `\b(send|delete|remove|erase|purchase|
  buy|order|pay|checkout|submit|publish|post|tweet|transfer|uninstall|format|sign ?out|log ?out|shut ?down|restart)\b`
  (case-insensitive) OR `step.risky`. `type` without `submit` is never consequential.

### 3.2 `src/jev.js`
Add 2.8. Refactor freely internally, but `jevCall({key,state,questions,timeoutMs,model})` keeps its exact
request (JSON, no danger header, `jev-latest` default) and result shapes; `jev-decide` must behave identically.
The timer stays armed through the body read (existing comment, keep that property). Key never in errors/logs.

### 3.3 `src/env-keys.js`
`resolveGeminiKey({ settingsKey, searchDirs }) -> { key, source: 'settings'|'process.env'|'.env'|null }`:
settingsKey > `process.env.GEMINI_API_KEY` > `.env GEMINI_API_KEY`. Reuse `loadDotEnvCached`.

### 3.4 `src/jev-planner.js`
2.3. Never throws. Own AbortController with timeout plus the external signal. Errors: HTTP status + first 200 chars
of `error.message`; never the URL or key. Does not retry (latency) except one retry on 429 when >=3 s remain.

### 3.5 `src/jev-vision-runner.js`
2.9. Requires only `./jev-vision`. Logs (via `deps.log`, main prefixes nothing; runner writes `[jv] ...`):
- run start: `[jv] run "<instr 80>" plan=<trivial|gemini Nms|FAIL err> steps=N`
- per Jev call: `[jv] #<call> s<i+1>/<n> <op> "<target 40>" cap=<ms> <w>x<h> <KB>KB uia=<ms|off|late>(e=<n>) jev=<ms> | prev=<x> vis=<x> box=[l,t,r,b]@<c> el=<id>@<c> blk=<x> risky=<x> done=<x> -> <clickReason|verified|poll|replan>`
- per action: `[jv] act s<i+1> <op> via=<element|box|key|type|app|wait> act=<ms>`
- run end: `[jv] end <status> actions=N calls=N replans=N planner=<ms> total=<ms>`
Typed text logged truncated to 40 chars. Numbers `toFixed(2)`.

### 3.6 `src/screen-capture.js` (requires electron; main + probe only)
- `primaryDisplayInfo() -> DisplayInfo` from `screen.getPrimaryDisplay()` and `screen.dipToScreenRect(null, bounds)`.
- `capturePrimaryJpeg({ maxSide, quality }) -> {ok, jpeg, width, height, ms} | {ok:false, error}`: size via
  `fitImageSize(physW, physH, maxSide)`; `desktopCapturer.getSources({types:['screen'], thumbnailSize})`; choose
  the source with `display_id === String(primary.id)`, fallback `sources[0]`; read actual `thumbnail.getSize()`,
  reject if `!validateImageDims` or aspect differs from the display by >1%; `thumbnail.toJPEG(quality)` (Buffer).
  Never throws.

### 3.7 `src/main.js`
- `jevVisionConfig()` -> `{ enabled, jevKey, plannerKey, cfg }`: enabled = (env `AURA_JEV_VISION` set ? `!=='0'` :
  `JEV_VISION_DEFAULT`) && jevKey && win32. jevKey via existing `jevConfig().key`; plannerKey via
  `resolveGeminiKey({settingsKey: store.get('settings','apiKey'), searchDirs})`; cfg = `readVisionConfig(process.env)`.
- `jev-vision-run`: guard single run; `const ctl = {aborted:false}` + AbortController for fetches; `enterActionMode()`,
  `await sleep(150)`; `uia.uiaWarm()`; build deps (input binds `physW/physH = primary.bounds.width/height`,
  `scaleX/scaleY` exactly like the `computer-action` handler, recomputed per call); `uiaSnapshot` =
  `uia.uiaSnapshot({excludePid: process.pid, auraRects: auraPhysicalRects(), maxElements: cfg.uiaMaxElements,
  timeoutMs: cfg.uiaTimeoutMs})`; `log` = `debugLog`; `progress` sends to mainWindow if alive; `confirm` =
  `dialog.showMessageBox({type:'warning', buttons:['Do it','Cancel'], defaultId:1, cancelId:1, message})` raced with
  30 s -> false. `finally`: `exitActionMode()`, clear guard. Always resolves a RunResult (wrap in try/catch -> `error`).
- `jev-vision-abort`: sets `ctl.aborted`, aborts the controller.
- `toggleAssistant()`: if a vision run is active -> abort it and return (the hotkey is the user's stop button while
  the pill is hidden). Otherwise unchanged.
- Add `dialog` to the electron destructure. Log once at startup: `[jv] mode enabled=<b> jevKey=<source> planner=<bool> model=<m>`.

### 3.8 `src/preload.js`
4 methods per 2.10; `onJevVisionProgress: (cb) => ipcRenderer.on('jev-vision-progress', (_e, evt) => cb(evt))`.

### 3.9 `src/renderer/app.js`
At boot `visionMode = (await api.jevVisionStatus?.())?.enabled === true` (failure -> false). When true:
- `activateVoice()` callers (orb click when not active, `onActivate`) instead open the panel, show
  `textInputRow`, focus `textInput`, set placeholder `Tell Aura what to do...`. `ensureConnected`/`GeminiLive` are
  never reached in this mode (guard at the top of `ensureConnected`: return false when visionMode).
- `submitText()` in vision mode: ignore if a run is in flight; `setUserText(txt)`; state `thinking`; await
  `jevVisionRun(txt)`; show `result.summary` via `appendTranscript` (or `showError` when `!ok`); state `idle`.
- Progress events update the transcript line (`Step i/n: desc`). No audio APIs touched.
- When visionMode is false, every existing code path is byte-for-byte unchanged.

## 4. Invariants
- J1 Typed text comes ONLY from `PlanStep.text` (planner or `parseTrivialCommand` quoted literal). Jev answers never
  produce or alter text. Hotkeys only from `PlanStep.keys`.
- J2 `SCREEN_REF` occurs exactly once in `JSON.stringify({state, questions})`; every asset is referenced; one image per call.
- J3 Every Jev image request carries `TypeSafe-Danger-Zone-Images: true` and `model = cfg.model`.
- J4 Box clicks only through `input({nx,ny})` (logical ctx); element clicks only through `uiaClick` or element center
  converted to normalized. Physical px never reach `computer-action`.
- J5 No consequential action without `confirm()===true`. `confirm=false` config refuses, never executes.
- J6 Every await in the runner is followed by an abort check; abort cancels in-flight Jev/planner fetches; no input
  is sent after `aborted` is observed.
- J7 IPC handlers always resolve; `jev-vision-run` never rejects, and `exitActionMode()` always runs.
- J8 Keys (Jev, Gemini) never in logs, errors, progress events or the renderer.
- J9 One plan step = at most one action unit (type step may be click+ctrl+a+type+enter); actions counted per unit.
- J10 With `AURA_JEV_VISION=0`, behavior is identical to the current branch (voice, Gemini Live, Jev-only CU).

## 5. Traps
- T1 DPI: Box is normalized to the IMAGE; the image is the full primary display, so `nx = cx*1000` maps onto
  `computer-action`'s logical `physW` (which is `display.bounds.width`, DIP, despite the name). Do NOT multiply by
  scaleFactor. UIA rects are physical: normalize with `physX/physY/physW/physH` from `dipToScreenRect`.
- T2 `desktopCapturer.getSources()[0]` is not guaranteed to be the primary display; match `display_id`.
- T3 Image limits are rejected, not resized: each side 280..1568 and pixels 78,400..2,458,624. Validate the ACTUAL
  thumbnail size; desktopCapturer may differ from the request by 1 px.
- T4 Asset rule: every asset referenced, and each reference bills a copy. Never put `SCREEN_REF` in a question;
  sanitize planner/UIA strings so a target description cannot contain it.
- T5 Box always returns a box, even when the target is absent. Never click on Box alone: require `visible` noul,
  box validity, `boxConf` and area cap.
- T6 `noul` is P(yes); compare with `>=`. Choice with 1 option returns confidence 1.0, so `element` always has `none`.
- T7 Multipart: do NOT set `Content-Type` yourself (kills the boundary). If the server rejects a Blob-typed
  `request` part, the probe's `--transport json` is the fallback; record which works in the probe output.
- T8 Timeouts: `AbortSignal.timeout()` rejects with `TimeoutError`, not `AbortError`; use the existing manual
  AbortController pattern and map own-timer vs external abort explicitly. Keep the timer armed through `res.json()`.
- T9 `uia.uiaSnapshot` timeout KILLS and respawns the host (~500 ms cold start). Hence `uiaOff` after first timeout
  and the grace window instead of awaiting UIA on the critical path.
- T10 `automation.computerAction` already sleeps 130-260 ms after each action; `settleMs` is added on top. Do not
  add more fixed sleeps; verification polls replace them.
- T11 Gemini key: send in `x-goog-api-key` header. The existing renderer code puts it in the URL; do not copy that,
  error messages from fetch can include the URL.
- T12 Electron main `fetch` is Node's undici: keep-alive pooling is automatic per origin. Do not create a new Agent
  per call. Optional warm-up: on run start fire `fetch('https://api.typesafe.ai/', {method:'HEAD'})` and ignore result.
- T13 After `enterActionMode()` the previously focused app regains focus asynchronously; wait 150 ms before the first
  capture/UIA snapshot or UIA describes the wrong window.
- T14 `uiaAct` only acts on the host's LATEST snapshot; a late, discarded snapshot (grace window) can make ours
  stale -> the element-center fallback in 2.9 step 7 is required, not optional.
- T15 Re-executing a `type` step duplicates text. Never retry type/hotkey/open_app automatically.
- T16 Store merge: do not add settings fields (V8).
- T17 Never echo keys on command lines (old trap 18).

## 6. Acceptance criteria
1. `node scripts/jev-step-selftest.js` and `node scripts/jev-vision-selftest.js` both print `ALL PASS`.
2. Probe returns HTTP 200 with a box on `jev-1.14.0`, prints latency; with `--move` the cursor lands on the target
   (Start button, a taskbar icon) on this 125% DPI laptop.
3. App with default env: Alt+Space opens a text box, no Gemini Live connect line in `aura-debug.log`, no mic prompt.
4. `open notepad` -> no planner call (`plan=trivial`), Notepad opens, run `done`.
5. `open notepad and type "hello from aura"` -> exactly 1 planner call, text appears exactly once, run `done`.
6. `click the Start button` -> 1 grounded call, Start menu opens, `done` or `unverified`.
7. A risky command (e.g. `delete the selected file in explorer`) shows the confirm dialog; Cancel -> `refused`, no click.
8. Alt+Space during a run -> `cancelled` within one step; no input after the cancel log line.
9. Every Jev call line has `cap=`, `jev=`; every action line has `act=`. Report p50 of `jev=` for image calls.
10. `AURA_JEV_VISION=0` -> voice mode works as before; no `[jv]` lines except the startup line.
11. Key hygiene grep (old verification step 4) -> `0`; `grep -rn "x-goog-api-key\|Bearer" src/renderer` -> none.

## 7. Verification plan
1. Pure: `node scripts/jev-vision-selftest.js` (no network; `node:assert/strict`, same `check()` style as
   `jev-step-selftest.js`). Must cover:
   - `fitImageSize`: 1920x1080@1280 -> 1280x720; 3840x2160@1568 -> 1568x882; 5120x1440@1280 -> 1280x360;
     800x600@1280 -> 800x600; 3000x200 -> short side raised to 280 or null when that breaks maxSide;
     `validateImageDims` at 279/280/1568/1569 and pixel bounds.
   - `readVisionConfig`: defaults on `{}`, numeric clamps, garbage -> default, `'0'` flags.
   - `validatePlan`: each required-field rule, bad op, bad keys grammar, >12 truncation, backticks stripped from
     target but not text, newline collapse.
   - `parseTrivialCommand`: `open notepad`, `click the Start button`, `double-click Recycle Bin`, `press ctrl+shift+n`,
     `type "hi there"`, `scroll down`; null for `open notepad and type hi`, `search for cats`, `type hi`.
   - `isConsequential`: send/delete hits; `type` without submit never; `risky:true` always.
   - `buildVisionRequest`: J2 count==1 in all combinations (verify only, ground only, both, final); question keys
     match `/^[a-z][a-z0-9_]{0,15}$/`; `target` question has no `criteria`; `element` has `none`, <=255 options,
     absent without snap; elements outside primary rect excluded; a target containing `SCREEN_REF` and backticks
     is sanitized; `risky` only for click family.
   - `buildJevHttpBody` (from jev.js, no network): multipart -> FormData with `request` part of type
     `application/json` whose JSON assets map `{[SCREEN_REF]:{type:'image',format:'jpeg',part}}` and a file part;
     headers have the danger header and NO content-type; json -> `data_base64` round-trips the buffer.
   - `interpretVisionAnswers`: valid box -> box click; inverted/out-of-range/NaN -> `invalid`; area 0.3 -> `too_large`;
     low conf; `visible` 0.2 -> null; element inside box -> element; outside -> box; element only; `none`; wrong
     shape of an asked question -> ok:false; missing un-asked question ignored.
   - Coords: box center (0.5,0.5) -> 500/500; (1,1) clamps to 999; element on display with physX offset; element
     outside -> null.
   - Runner with fake deps (scripted answers, fake clock, recorded calls): (a) trivial click -> 1 capture,
     1 grounding call, 1 input click, final task_done call, `done`; (b) plan open_app(done_when) + type(no target):
     open_app polls until prev_done passes, then type executes with EXACT planner text, single type call;
     (c) target never visible -> polls then replan x2 then `failed`, replan called exactly 2 times; (d) risky +
     confirm false -> `refused`, zero input calls; (e) abort set during jev call -> `cancelled`, no input after;
     (f) same click 3x -> replan/failed; (g) jev 401 -> `error` after 1 call; (h) UIA timeout -> later
     iterations call uiaSnapshot zero times; (i) uiaClick `stale_snapshot` -> input click at element center.
   Prints `ALL PASS`.
2. Live probe: `npx electron scripts/jev-vision-probe.js --target "the Windows Start button" [--delay 2]
   [--max 1280] [--q 70] [--transport multipart|json] [--model jev-1.14.0] [--repeat 1..5] [--move] [--save <path>]`.
   Loads key with `resolveJevKey({searchDirs:[process.cwd()]})`, prints only `source`. Captures via
   `screen-capture.js`, builds a request with `buildVisionRequest` (synthetic click step, no UIA unless `--uia`),
   sends with `jevCallImages`. Prints per call: status, ms, model, usage, image WxH and KB, `visible`, raw box,
   confidence, normalized and physical click point. `--move` moves the cursor via `automation.computerAction
   ({action:'move', nx, ny, physW, physH})` with the same ctx as main. Prints p50/max over repeats. Exits via
   `app.quit()`, exit code 1 on any non-200. Max 5 live calls per invocation. Run once with each transport.
3. App smoke: `npm start`, then acceptance items 3-10, reading `%APPDATA%\aura\aura-debug.log`.
4. Regression: `node scripts/jev-step-selftest.js`; `AURA_JEV_VISION=0` voice run of one command.

## 8. Size estimate (bodies)
jev-vision.js ~340, jev.js +80, env-keys.js +15, jev-planner.js ~110, jev-vision-runner.js ~270, screen-capture.js ~50,
main.js +140, preload.js +4, app.js +60, jev-vision-selftest.js ~300, jev-vision-probe.js ~110. Total ~1480 lines.
