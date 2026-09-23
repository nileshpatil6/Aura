# Jev plays the Chrome dino game

An experiment to see how far TypeSafe's Jev decision model (text only, about 0.3 to 0.5 s per call) can get in a reflex game.

Both scripts launch a separate Chrome instance with its own profile (`profile/`, gitignored) on chromedino.com, read the game state over the Chrome DevTools Protocol, and send key presses through CDP. The Jev key is read from the repo's `.env` via `src/env-keys.js`.

| Script | Approach | Scores |
|---|---|---|
| `dino_jev.js` (v1) | Jev decides jump/duck/wait moment to moment, with pipelined calls and state projected forward by the measured latency | 72, 44, 45 |
| `dino_jev_v2.js` (v2) | One call plans the next 3 to 4 obstacles (jump/duck/none); a local timer only picks the exact moment to execute | 733, 55, 94 and 832, 190, 128 |

Takeaways:
- Reacting frame by frame fails: two close obstacles are often less than one Jev round trip apart.
- Planning ahead fixes that: 98 to 100% of obstacles had a plan before they arrived, and no death in the counted runs came from Jev picking the wrong action.
- Remaining deaths are physics: back-to-back obstacles tighter than the dino's fixed jump cycle. The 55 run was a real API latency spike.

Run: `node dino-jev-experiment/dino_jev_v2.js` (Node 22+, Chrome installed). Per-decision logs are written as `run*.log` next to the script.

## v3 (`dino_jev_v3.js`)

Same lookahead planning as v2, with game I/O behind a transport so it can run in two ways:
- `--transport=cdp` (default): separate scratch Chrome profile driven over CDP.
- `--transport=ext`: your own Chrome profile via the local extension in `extension/` (host permission for chromedino.com only; talks to the script over `ws://127.0.0.1:8765`). Load it at chrome://extensions > Developer mode > Load unpacked, open https://chromedino.com, then run `node dino-jev-experiment/dino_jev_v3.js --transport=ext`.

Fixes over v2: Jev connection re-warmed before every round (removed the near-instant "no plan yet" deaths), fast-drop decided from the measured gap to the next obstacle instead of an estimated flight time, lookahead widened to 6 obstacles. Scores in cdp mode: best 1972 (145 obstacles, 133 s); typical games still range from about 50 to 700 because of tight cactus clusters at top speed and occasional multi-second Jev API stalls.

Safety: every transport call has a timeout, a watchdog ends the run if the game stops progressing for about 3.5 s, and Jev calls are capped at 600 per round and 2500 per process.

Honest note: the jump/duck choice here is simple enough that a four-rule script could make it, so this experiment shows the planning pattern, not a case where Jev beats plain code.
