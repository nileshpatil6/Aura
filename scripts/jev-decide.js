// Live end-to-end test: UIA snapshot -> Jev decision. Plain node (no electron).
// NEVER prints the key value. Usage:
//   node scripts/jev-decide.js --delay 3 --goal "open the File menu"
// Contract: docs/jev-uia/CONTRACT.md section 7, step 3.

const path = require('path');
const uia = require(path.join(__dirname, '..', 'src', 'uia.js'));
const { jevCall } = require(path.join(__dirname, '..', 'src', 'jev.js'));
const { buildJevRequest, interpretJevAnswers } = require(path.join(__dirname, '..', 'src', 'jev-step.js'));
const { resolveJevKey } = require(path.join(__dirname, '..', 'src', 'env-keys.js'));

function parseArgs(argv) {
  const out = { delay: 0, goal: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delay') out.delay = Number(argv[++i]) || 0;
    else if (a === '--goal') out.goal = argv[++i] || '';
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.goal) { console.error('usage: node scripts/jev-decide.js --delay N --goal "..."'); process.exit(1); }

  const { key, source } = resolveJevKey({ searchDirs: [process.cwd()] });
  console.log(`key source: ${source || '(none)'}`); // value NEVER printed
  if (!key) { console.error('No Jev key resolved; aborting.'); process.exit(1); }

  uia.uiaWarm();
  await sleep(500);

  if (args.delay > 0) {
    process.stdout.write(`Focus the target window within ${args.delay}s...\n`);
    await sleep(args.delay * 1000);
  }

  const snap = await uia.uiaSnapshot({ excludePid: process.pid, auraRects: [], maxElements: 200 });
  if (!snap.ok) {
    console.error(`snapshot failed: ${snap.reason}${snap.detail ? ' ' + snap.detail : ''}`);
    uia.shutdownUia();
    process.exit(1);
  }
  console.log(`window: ${snap.process} "${snap.title}" elements=${snap.elements.length}/${snap.total}`);

  const ctx = { goal: args.goal, history: [], excludeKeys: [], executedCount: 0 };
  const built = buildJevRequest(snap, ctx);
  console.log(`approxTokens: ${built.approxTokens}  literals: ${JSON.stringify(built.literals)}`);

  const r = await jevCall({ key, state: built.state, questions: built.questions, timeoutMs: 8000 });
  if (!r.ok) {
    console.error(`jev call failed: status=${r.status} error=${r.error} ms=${r.ms}`);
    uia.shutdownUia();
    process.exit(1);
  }

  const d = interpretJevAnswers(r.answers, built, ctx);
  console.log(`choice=${d.choice} conf=${d.conf.toFixed(2)} goal=${d.goal.toFixed(2)} stuck=${d.stuck.toFixed(2)}`);
  console.log(`top2=${JSON.stringify(d.top2)}`);
  console.log(`kind=${d.kind}${d.op ? '/' + d.op : ''}${d.reason ? '/' + d.reason : ''} target=${d.target || ''} text=${d.text || ''}`);
  console.log(`ms=${r.ms} usage=${JSON.stringify(r.usage)}`);

  uia.shutdownUia();
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
