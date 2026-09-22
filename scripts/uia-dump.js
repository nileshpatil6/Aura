// Live diagnostic for src/uia.js. Plain node (no electron).
// Usage: node scripts/uia-dump.js --delay 3 [--json] [--act eN]
// Contract: docs/jev-uia/CONTRACT.md section 7, step 2.

const path = require('path');
const uia = require(path.join(__dirname, '..', 'src', 'uia.js'));
const { describeElement } = require(path.join(__dirname, '..', 'src', 'jev-step.js'));

function parseArgs(argv) {
  const out = { delay: 0, json: false, act: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delay') out.delay = Number(argv[++i]) || 0;
    else if (a === '--json') out.json = true;
    else if (a === '--act') out.act = argv[++i];
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));

  uia.uiaWarm();
  await sleep(500); // let the host start spinning up before the countdown

  if (args.delay > 0) {
    process.stdout.write(`Focus the target window within ${args.delay}s...\n`);
    await sleep(args.delay * 1000);
  }

  const snap = await uia.uiaSnapshot({ excludePid: process.pid, auraRects: [], maxElements: 200 });

  if (!snap.ok) {
    console.log(`FAIL ${snap.reason}${snap.detail ? ' ' + snap.detail : ''}`);
    // no_window/empty are accepted non-crashing outcomes (e.g. bare desktop focused).
    uia.shutdownUia();
    process.exit(snap.reason === 'no_window' || snap.reason === 'empty' ? 0 : 1);
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(snap, null, 2));
  } else {
    console.log(`window: ${snap.process} "${snap.title}" hwnd=${snap.hwnd} fw=${snap.fw}`);
    console.log(`elements: ${snap.elements.length}/${snap.total} truncated=${snap.truncated} host=${snap.ms}ms`);
    console.log(`focused: ${snap.focused ? `${snap.focused.type} "${snap.focused.name}" id=${snap.focused.id || '(not in list)'}` : '(none)'}`);
    console.log('--- first 40 elements ---');
    for (const el of snap.elements.slice(0, 40)) {
      console.log(`${el.id} ${describeElement(el)} rect=[${el.rect.join(',')}]`);
    }
  }

  const allFinite = snap.elements.every(el => el.rect.every(v => Number.isFinite(v)));
  console.log(`rects finite: ${allFinite}`);

  if (args.act) {
    const el = snap.elements.find(e => e.id === args.act);
    if (!el) {
      console.log(`--act: element ${args.act} not found in this snapshot`);
    } else {
      const t0 = Date.now();
      const res = await uia.uiaAct({ snapshotId: snap.snapshotId, index: el.i, op: 'click' });
      console.log(`--act ${args.act} (${el.type} "${el.name}") -> ${JSON.stringify(res)} (rt ${Date.now() - t0}ms)`);
    }
  }

  console.log('--- repeat x5 (warm) ---');
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const s = await uia.uiaSnapshot({ excludePid: process.pid, auraRects: [], maxElements: 200 });
    const rt = Date.now() - t0;
    timings.push(rt);
    console.log(`  run ${i + 1}: ok=${s.ok} host=${s.ms != null ? s.ms : '-'}ms rt=${rt}ms`);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length / 2)];
  const max = timings[timings.length - 1];
  console.log(`p50=${p50}ms max=${max}ms`);

  uia.shutdownUia();
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
