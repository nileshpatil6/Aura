// Planner latency/quality bench (plain node, live Gemini calls, never prints the key).
//   node scripts/jev-planner-bench.js [--n 20] [--configs low:2048,minimal:1024] [--model gemini-3.6-flash] [--hedge 2500]
// Each config is <thinkingLevel>:<maxOutputTokens>. Calls are single requests (no hedging)
// so the numbers show the raw model tail that the hedge is meant to cut; --hedge <ms>
// switches to the production behaviour (hedge after <ms>, up to 3 requests, 12 s budget).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { planTask } = require(path.join(__dirname, '..', 'src', 'jev-planner.js'));
const { resolveGeminiKey } = require(path.join(__dirname, '..', 'src', 'env-keys.js'));

function parseArgs(argv) {
  const out = { n: 20, configs: ['low:2048', 'minimal:1024'], model: 'gemini-3.6-flash', hedge: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--n') out.n = Math.max(1, Number(argv[++i]) || 20);
    else if (argv[i] === '--configs') out.configs = String(argv[++i] || '').split(',').filter(Boolean);
    else if (argv[i] === '--model') out.model = argv[++i] || out.model;
    else if (argv[i] === '--hedge') out.hedge = Math.max(0, Number(argv[++i]) || 2500);
  }
  return out;
}

// Same source order the app uses: settings apiKey (electron-store file), env, .env.
function loadKey() {
  let settingsKey = '';
  try {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const j = JSON.parse(fs.readFileSync(path.join(appData, 'aura', 'aura.json'), 'utf8'));
    settingsKey = (j.settings && j.settings.apiKey) || '';
  } catch {}
  return resolveGeminiKey({ settingsKey, searchDirs: [process.cwd(), path.join(__dirname, '..')] });
}

const PROMPTS = [
  {
    text: 'open whatsapp',
    ok: (steps) => steps.length <= 2 && steps[0].op === 'open_app' && /whatsapp/i.test(steps[0].app),
  },
  {
    text: 'open chrome search for a phone and find a best phone under 50k',
    ok: (steps) => steps[0].op === 'open_url' && /google\.com\/search\?q=.*phone/i.test(steps[0].url),
  },
  {
    text: 'open notepad and type hello world',
    ok: (steps) => steps.some(s => s.op === 'open_app' && /notepad/i.test(s.app)) &&
      steps.filter(s => s.op === 'type' && /^hello world$/i.test(s.text)).length === 1,
  },
  {
    text: 'open settings and turn on dark mode',
    ok: (steps) => steps[0].op === 'open_app' && /settings/i.test(steps[0].app) &&
      steps.slice(1).some(s => s.op === 'click' || s.op === 'open_url' || s.op === 'type'),
  },
];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function runConfig(cfgStr, args, key) {
  const [thinkingLevel, tokens] = cfgStr.split(':');
  const maxOutputTokens = Number(tokens) || 2048;
  const times = [];
  let failed = 0;
  let badQuality = 0;
  let multi = 0;
  const errors = {};
  const samples = {};

  for (let i = 0; i < args.n; i++) {
    const p = PROMPTS[i % PROMPTS.length];
    const r = await planTask({
      key, instruction: p.text, model: args.model, signal: undefined,
      timeoutMs: args.hedge === null ? 25000 : 12000,
      hedgeMs: args.hedge === null ? Infinity : args.hedge,
      maxRequests: args.hedge === null ? 1 : 3,
      thinkingLevel, maxOutputTokens,
    });
    times.push(r.ms);
    if (r.requests > 1) multi++;
    if (!r.ok) {
      failed++;
      errors[r.error] = (errors[r.error] || 0) + 1;
      continue;
    }
    if (!samples[p.text]) samples[p.text] = r.plan.steps.map(s => s.op + (s.url ? `(${s.url.slice(0, 60)})` : s.app ? `(${s.app})` : s.text ? `("${s.text}")` : '')).join(' > ');
    if (!p.ok(r.plan.steps)) badQuality++;
  }

  const sorted = times.slice().sort((a, b) => a - b);
  console.log(`\n=== ${cfgStr} model=${args.model} n=${args.n}`);
  console.log(`p50=${pct(sorted, 0.5)}ms p90=${pct(sorted, 0.9)}ms max=${sorted[sorted.length - 1]}ms`);
  if (args.hedge !== null) console.log(`calls that needed more than one request: ${multi}/${args.n}`);
  console.log(`failed/invalid=${failed}/${args.n} (${Object.entries(errors).map(([k, v]) => `${k} x${v}`).join('; ') || 'none'}) quality_miss=${badQuality}/${args.n - failed}`);
  for (const [k, v] of Object.entries(samples)) console.log(`  "${k}" -> ${v}`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { key, source } = loadKey();
  console.log(`gemini key source: ${source || '(none)'}`);
  if (!key) { console.error('No Gemini key found; aborting.'); process.exit(1); }
  for (const c of args.configs) await runConfig(c, args, key);
})().catch((e) => { console.error('FATAL', (e && e.message) || String(e)); process.exit(1); });
