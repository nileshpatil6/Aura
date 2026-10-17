// Live probe for Jev Vision mode: one screenshot, one Box + noul call, prints
// latency and box. Runs under electron (desktopCapturer). NEVER prints the key.
//   npx electron scripts/jev-vision-probe.js --target "the Windows Start button" [--delay 2]
//     [--max 1280] [--q 70] [--transport multipart|json] [--model jev-1.14.0]
//     [--repeat 1..5] [--move] [--save <path>] [--uia]
//   npx electron scripts/jev-vision-probe.js --bench-capture 20 [--max 1280] [--q 70]
//     (no key needed; compares the stream capture with the desktopCapturer thumbnail)
// Contract: docs/jev-vision/CONTRACT.md section 7, step 2.

const path = require('path');
const fs = require('fs');
const { resolveJevKey } = require(path.join(__dirname, '..', 'src', 'env-keys.js'));

function parseArgs(argv) {
  const out = {
    target: '', delay: 0, max: 1280, q: 70, transport: 'multipart',
    model: 'jev-1.14.0', repeat: 1, move: false, save: null, uia: false, benchCapture: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i] || '';
    else if (a === '--delay') out.delay = Number(argv[++i]) || 0;
    else if (a === '--max') out.max = Number(argv[++i]) || 1280;
    else if (a === '--q') out.q = Number(argv[++i]) || 70;
    else if (a === '--transport') out.transport = argv[++i] === 'json' ? 'json' : 'multipart';
    else if (a === '--model') out.model = argv[++i] || out.model;
    else if (a === '--repeat') out.repeat = Math.min(5, Math.max(1, Number(argv[++i]) || 1));
    else if (a === '--move') out.move = true;
    else if (a === '--save') out.save = argv[++i] || null;
    else if (a === '--uia') out.uia = true;
    else if (a === '--bench-capture') out.benchCapture = Math.min(100, Math.max(1, Number(argv[++i]) || 20));
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

async function benchCapture(args) {
  const { app } = require('electron');
  const sc = require(path.join(__dirname, '..', 'src', 'screen-capture.js'));
  await app.whenReady();
  sc.setCaptureLogger((l) => console.log(l));
  const opts = { maxSide: args.max, quality: args.q };
  const report = (label, times, extra) => {
    const sorted = times.slice().sort((a, b) => a - b);
    console.log(`${label}: p50=${pct(sorted, 0.5)}ms p90=${pct(sorted, 0.9)}ms max=${sorted[sorted.length - 1]}ms n=${sorted.length}${extra || ''}`);
  };

  const thumb = [];
  let dims = '';
  for (let i = 0; i < args.benchCapture; i++) {
    const t0 = Date.now();
    const r = await sc.captureViaThumbnail(opts);
    if (!r.ok) { console.error(`thumbnail failed: ${r.error}`); continue; }
    thumb.push(Date.now() - t0);
    dims = `${r.width}x${r.height} ${Math.round(r.jpeg.length / 1024)}KB`;
  }
  report('thumbnail', thumb, ` image=${dims}`);

  const tCold = Date.now();
  const first = await sc.capturePrimaryJpeg(opts);
  console.log(`stream cold start + first frame: ${Date.now() - tCold}ms via=${first.ok ? first.via : 'FAIL ' + first.error}`);
  const fast = [];
  const via = {};
  for (let i = 0; i < args.benchCapture; i++) {
    const t0 = Date.now();
    const r = await sc.capturePrimaryJpeg(opts);
    if (!r.ok) { console.error(`stream capture failed: ${r.error}`); continue; }
    fast.push(Date.now() - t0);
    via[r.via] = (via[r.via] || 0) + 1;
    dims = `${r.width}x${r.height} ${Math.round(r.jpeg.length / 1024)}KB`;
    if (args.save && i === 0) { try { fs.writeFileSync(args.save, r.jpeg); } catch {} }
    await sleep(60);
  }
  report('stream   ', fast, ` image=${dims} via=${JSON.stringify(via)}`);
  sc.stopCapture();
  app.quit();
  process.exit(fast.length ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.benchCapture) { await benchCapture(args); return; }
  if (!args.target) { console.error('usage: npx electron scripts/jev-vision-probe.js --target "<description>"'); process.exit(2); }

  const { key, source } = resolveJevKey({ searchDirs: [process.cwd()] });
  console.log(`key source: ${source || '(none)'}`); // value NEVER printed
  if (!key) { console.error('No Jev key resolved (.env / process.env); aborting.'); process.exit(1); }

  // Require electron-dependent modules only after the key check, so the no-key
  // path exits cleanly under plain node too.
  const { app } = require('electron');
  const { capturePrimaryJpeg, primaryDisplayInfo } = require(path.join(__dirname, '..', 'src', 'screen-capture.js'));
  const { jevCallImages } = require(path.join(__dirname, '..', 'src', 'jev.js'));
  const vision = require(path.join(__dirname, '..', 'src', 'jev-vision.js'));

  await app.whenReady();

  if (args.delay > 0) {
    process.stdout.write(`Focus the target window within ${args.delay}s...\n`);
    await sleep(args.delay * 1000);
  }

  const cfg = vision.readVisionConfig(process.env);
  const step = { op: 'click', target: args.target, done_when: '' };
  const timings = [];
  let failed = false;

  for (let run = 0; run < args.repeat; run++) {
    const cap = await capturePrimaryJpeg({ maxSide: args.max, quality: args.q });
    if (!cap.ok) {
      console.error(`capture failed: ${cap.error}`);
      failed = true;
      break;
    }

    const display = primaryDisplayInfo();
    let snap = null;
    if (args.uia) {
      const uia = require(path.join(__dirname, '..', 'src', 'uia.js'));
      uia.uiaWarm();
      snap = await uia.uiaSnapshot({ excludePid: process.pid, auraRects: [], maxElements: cfg.uiaMaxElements });
      if (!snap.ok) snap = null;
    }

    const built = vision.buildVisionRequest({
      task: `Locate ${args.target}`, step, verify: null, final: false, snap, display, cfg,
    });
    const image = { ref: vision.SCREEN_REF, part: 'image', buffer: cap.jpeg, format: 'jpeg' };

    const t0 = Date.now();
    const r = await jevCallImages({
      key, model: args.model, state: built.state, questions: built.questions,
      images: [image], transport: args.transport, timeoutMs: 8000,
    });
    const rt = Date.now() - t0;

    const kb = Math.round(cap.jpeg.length / 1024);
    console.log(`\n[run ${run + 1}] transport=${args.transport} model=${args.model} image=${cap.width}x${cap.height} ${kb}KB`);

    if (!r.ok) {
      console.error(`  FAIL status=${r.status} error=${r.error} ms=${r.ms}`);
      failed = true;
      continue;
    }

    const read = vision.interpretVisionAnswers(r.answers, built, display, cfg);
    const phys = read.click ? vision.normalizedToPhysical(read.click, display) : null;
    console.log(`  status=200 ms=${r.ms} (rt ${rt}ms) model=${r.model} usage=${JSON.stringify(r.usage)}`);
    console.log(`  visible=${read.visible === null ? '-' : read.visible.toFixed(2)} ` +
      `raw box=${read.box ? JSON.stringify(read.box) : '-'} reject=${read.boxReject || '-'}`);
    console.log(`  normalized click=${read.click ? `(${read.click.nx.toFixed(1)}, ${read.click.ny.toFixed(1)}) via ${read.click.source}` : '-'} ` +
      `reason=${read.clickReason}`);
    console.log(`  physical point=${phys ? `(${phys.x}, ${phys.y})` : '-'}`);
    timings.push(r.ms);

    if (args.save) {
      try { fs.writeFileSync(args.save, cap.jpeg); console.log(`  saved ${args.save}`); } catch (e) { console.error(`  save failed: ${e.message}`); }
    }

    if (args.move && read.click && phys) {
      // Same logical ctx main.js's computer-action handler builds.
      const automation = require(path.join(__dirname, '..', 'src', 'automation.js'));
      const res = await automation.computerAction({
        action: 'move', nx: read.click.nx, ny: read.click.ny,
        physW: display.dipW, physH: display.dipH,
        scaleX: display.dipW / 1280, scaleY: display.dipH / 720,
      });
      console.log(`  move -> ${JSON.stringify(res)}`);
    }
  }

  if (timings.length) {
    console.log(`\np50=${median(timings)}ms max=${Math.max(...timings)}ms over ${timings.length} call(s)`);
  }

  app.quit();
  process.exit(failed || !timings.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', (e && e.message) || String(e));
  process.exit(1);
});
