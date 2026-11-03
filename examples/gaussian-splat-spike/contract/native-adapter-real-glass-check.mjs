/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 real-asset runner for validate-native-adapter.mjs --real-glass=<K-layer checkout>:
// the same FZK-Haus page renders through this branch and through the K-layer research
// renderer (one Vite server per checkout). Judged per pixel:
//  - independent reference (windows only): glass over the capture equals the affine
//    composite of glass-over-black, glass-over-white and the capture alone (<= 2/255);
//  - K-layer reference (full house): where the capture changes this branch's frame, the
//    split differs from K-layer by no more than the two renderers already differ with the
//    capture moved out of view (the research renderer shades glass per sample in its
//    K-layer frames) plus 2/255, and it is much closer to K-layer than the single pass.
// Both predicates apply where only the front window lies over the capture; pixels where
// the house's back windows show through (glass behind the capture) are beyond exact and
// only reported.
import { writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { defaultAssets } from '../prepare.mjs';

const spike = fileURLToPath(new URL('..', import.meta.url));
const TOLERANCE = 2;

/** Serves ~/.cache/ifc-lite/gaussian-splat-spike as /fixtures (prepare.mjs), like vite.config.mjs. */
const fixtures = () => ({ name: 'real-glass-fixtures', configureServer(server) {
  const root = resolve(process.env.SPLAT_SPIKE_ASSETS ?? defaultAssets);
  server.middlewares.use('/fixtures', async (req, res) => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    const info = path.startsWith(root + sep) ? await stat(path).catch(() => null) : null;
    if (!info?.isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    createReadStream(path).pipe(res);
  });
} });

async function renderWith(root, role, allow, browser, openPage, query = '') {
  const server = await createServer({
    root: spike, configFile: false, logLevel: 'warn', plugins: [fixtures()],
    resolve: { alias: {
      'ifc-lite-renderer-under-test': resolve(root, 'packages/renderer/src/index.ts'),
      '@ifc-lite/spatial': resolve(root, 'packages/spatial/src/index.ts'),
      '@ifc-lite/load-trace': resolve(root, 'packages/load-trace/src/index.ts'),
    } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, fs: { allow } },
  });
  await server.listen();
  const { context, page, log } = await openPage(browser);
  try {
    await page.goto(`${server.resolvedUrls.local[0]}contract/native-adapter-real-glass.html?role=${role}${query}`);
    await page.waitForFunction(() => Boolean(window.realGlass), undefined, { timeout: 120000 });
    const outcome = await page.evaluate(() => window.realGlass);
    if (outcome.error) throw new Error(`real-glass page failed for ${role}: ${outcome.error}`);
    const frames = Object.fromEntries(Object.entries(outcome.result.frames).map(([name, f]) => [name, { ...f, rgba: new Uint8Array(Buffer.from(f.rgba, 'base64')) }]));
    return { ...outcome.result, frames, browserLog: log };
  } finally {
    await context.close();
    await server.close();
  }
}

const delta = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
function stats(a, b, mask) {
  let compared = 0, changed = 0, maxDelta = 0, sum = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const d = delta(a.rgba, b.rgba, p * 4);
    compared++; sum += d; if (d) changed++; maxDelta = Math.max(maxDelta, d);
  }
  return { compared, changed, maxDelta, meanDelta: compared ? Math.round(sum / compared * 1000) / 1000 : 0 };
}

export async function runRealGlass({ browser, openPage, output, backend, stamp, repo, kLayerRoot }) {
  const kLayerCommit = execFileSync('git', ['-C', kLayerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const allow = [repo, kLayerRoot, resolve(process.env.SPLAT_SPIKE_ASSETS ?? defaultAssets)];
  const head = await renderWith(repo, 'head', allow, browser, openPage);
  const kLayer = await renderWith(kLayerRoot, 'k-layer', allow, browser, openPage, `&pane=${head.info.pane.expressId}&depth=${head.info.depth}`);
  const h = head.frames, k = kLayer.frames, pixels = h.split.width * h.split.height;
  for (const [role, run] of [['head', head], ['k-layer', kLayer]]) for (const [name, f] of Object.entries(run.frames)) {
    await writeFile(resolve(output, `real-glass-${backend}-${stamp}-${role}-${name}.png`), Buffer.from(f.png, 'base64'));
  }
  // Pixels the capture changes in this branch's full-house frame; `front`: no other window contributes there.
  const capture = new Uint8Array(pixels), rest = new Uint8Array(pixels), front = new Uint8Array(pixels), behindOther = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const changed = delta(h.split.rgba, h.away.rgba, p * 4) > 8, frontOnly = delta(h.windowsBlack.rgba, h.frontWindowBlack.rgba, p * 4) === 0;
    capture[p] = changed && frontOnly ? 1 : 0; rest[p] = changed ? 0 : 1; front[p] = frontOnly ? 1 : 0; behindOther[p] = changed && !frontOnly ? 1 : 0;
  }
  // K-layer predicate per capture pixel: |split - K| <= |away - K away| + TOLERANCE.
  let beyondBaseline = 0, worst = null;
  for (let p = 0; p < pixels; p++) {
    if (!capture[p]) continue;
    const excess = delta(h.split.rgba, k.split.rgba, p * 4) - delta(h.away.rgba, k.away.rgba, p * 4);
    if (excess > TOLERANCE) { beyondBaseline++; if (!worst || excess > worst.excess) worst = { x: p % h.split.width, y: Math.floor(p / h.split.width), excess }; }
  }
  // Independent affine reference over the whole windows-only frame.
  let affineOver = 0, affineMax = 0, affineCapture = 0, beyondOver = 0;
  const [b0, b1, a, w] = [h.windowsBlack.rgba, h.windowsWhite.rgba, h.captureAlone.rgba, h.windowsSplit.rgba];
  for (let p = 0; p < pixels; p++) {
    let d = 0, lit = false;
    if (!front[p]) {
      for (let c = 0; c < 3; c++) { const i = p * 4 + c; if (Math.abs(w[i] - (b0[i] + (b1[i] - b0[i]) * a[i] / 255)) > TOLERANCE) { beyondOver++; break; } }
      continue;
    }
    for (let c = 0; c < 3; c++) {
      const i = p * 4 + c, expected = b0[i] + (b1[i] - b0[i]) * a[i] / 255;
      d = Math.max(d, Math.abs(w[i] - expected)); if (a[i] > 8) lit = true;
    }
    if (lit && b1[p * 4] !== b0[p * 4]) affineCapture++;
    affineMax = Math.max(affineMax, d); if (d > TOLERANCE) affineOver++;
  }
  const result = {
    kLayerCommit, info: { head: head.info, kLayer: kLayer.info }, reports: { head: head.reports, kLayer: kLayer.reports },
    capturePixels: capture.reduce((s, v) => s + v, 0), capturePixelsWithBackWindows: behindOther.reduce((s, v) => s + v, 0),
    repeatStability: stats(h.windowsSplit, h.windowsSplitRepeat, new Uint8Array(pixels).fill(1)),
    kLayer: {
      splitVsKLayer: stats(h.split, k.split, capture), awayBaseline: stats(h.away, k.away, capture),
      beyondExactSplitVsKLayer: stats(h.split, k.split, behindOther),
      approximateVsKLayer: stats(h.single, k.split, capture), restSplitVsKLayer: stats(h.split, k.split, rest), restAwayBaseline: stats(h.away, k.away, rest),
      beyondBaseline, worst, tolerance: TOLERANCE,
    },
    affine: { pixels, capturePixelsBehindGlass: affineCapture, overTolerance: affineOver, maxDelta: Math.round(affineMax * 1000) / 1000, tolerance: TOLERANCE,
      beyondExactPixelsOverTolerance: beyondOver },
    stable: Object.fromEntries([...Object.entries(h).map(([n, f]) => [`head-${n}`, f.stable]), ...Object.entries(k).map(([n, f]) => [`k-layer-${n}`, f.stable])]),
    jitter: Object.fromEntries([...Object.entries(h).map(([n, f]) => [`head-${n}`, f.jitter]), ...Object.entries(k).map(([n, f]) => [`k-layer-${n}`, f.jitter])]),
    errors: { head: head.errors, kLayer: kLayer.errors, headDiagnostics: head.diagnostics, kLayerDiagnostics: kLayer.diagnostics },
    adapterInfo: head.adapterInfo,
  };
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), ...(pass ? {} : { detail }) });
  // The 113k-Gaussian capture jitters frame to frame upstream (also in the single pass and with no IFC);
  // frames without it must be byte-stable, frames with it report the jitter and must stay within the tolerance.
  const withCapture = name => !/away|Black$|White$/.test(name);
  check('real glass: frames without the capture are byte-stable', Object.entries(result.stable).every(([n, s]) => withCapture(n) || s), result.stable);
  // Observed in every renderer and mode (single pass, capture alone, K-layer): <= 3/255 on a few dozen channels.
  // A disclosure bound only; the correctness predicates above stay at TOLERANCE per pixel.
  check('real glass: capture-frame jitter stays within 3/255 on <= 0.1% of channels (upstream; also in the single pass)',
    Object.entries(result.jitter).every(([n, jit]) => !withCapture(n) || !jit || (jit.maxDelta <= 3 && jit.changedChannels <= pixels * 4 / 1000)), result.jitter);
  check('real glass: no GPU or render errors', !head.errors.length && !kLayer.errors.length && !head.diagnostics.renderErrors && !kLayer.diagnostics.renderErrors, result.errors);
  check('real glass: the capture is visible through the window (>= 200 px)', result.capturePixels >= 200 && affineCapture >= 200, { capture: result.capturePixels, behindGlass: affineCapture });
  check('real glass: this branch split the frame', head.reports.split?.composition === 'nearest-glass-split', head.reports.split);
  check(`real glass: windows over the capture equal the independent affine reference (<= ${TOLERANCE}/255)`, affineOver === 0, result.affine);
  check(`real glass: within the K-layer reference beyond the existing glass-shading delta (+${TOLERANCE}/255)`, beyondBaseline === 0, result.kLayer);
  check('real glass: split is much closer to K-layer than the single approximate pass', result.kLayer.splitVsKLayer.meanDelta * 4 < result.kLayer.approximateVsKLayer.meanDelta, result.kLayer);
  const failed = checks.filter(c => !c.pass);
  return { ...result, status: failed.length ? 'fail' : 'pass', verdict: { pass: !failed.length, total: checks.length, failed }, checks: checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`) };
}
