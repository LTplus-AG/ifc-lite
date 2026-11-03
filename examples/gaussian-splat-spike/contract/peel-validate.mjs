/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual GPU correctness run (#8564), serialized through the GPU wrapper:
//   ~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/peel-validate.mjs [--backend=swiftshader|hardware]
// Correctness only. PEEL_RUNS (comma ids) / PEEL_SIZES narrow a debug run; PEEL_ALL=1 adds the
// K-layer negative controls of the original witness. The option-B (nearest-glass split) runs
// use the installed, production-patched upstream renderer and are judged against the
// independent reference and the K-layer peel per texel (peel-nearest.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { comparePeelImages, peelRejection } from './peel-acceptance.mjs';
import { extendSplatShaders, INSTALLED_RENDERER_SHA256, peelPlugin, UPSTREAM_SHADERS_SHA256 } from './peel-plugin.mjs';
import { auditScene, buildScene, expectedExhaustion } from './peel-scene.mjs';
import { readPublishedShaders } from '../depth-patch.mjs';
import { compareByLayers, judgeNearest, layerCounts, mirrorSensitive } from './peel-nearest.mjs';
import { isHardwareAdapter } from '../../../scripts/perf/hardware-adapter.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8564-peel');
const sizes = (process.env.PEEL_SIZES ?? '24,32,48').split(',').map(Number);
const backend = process.argv.find(a => a.startsWith('--backend='))?.slice(10) ?? 'swiftshader';
if (backend === 'hardware' && !process.env.IFC_GPU_CDP_URL) throw new Error('--backend=hardware needs IFC_GPU_CDP_URL; run under ~/build-workers/ifc-gpu-check');
const PANES = 'single,all';
/** Per-channel bound for option B on hardware blending noise; 0 means exact. Recorded with every verdict. */
const NEAREST_TOLERANCE = Number(process.env.PEEL_NEAREST_TOLERANCE ?? 0);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const RUNS = [
  ['reference-1x', { extend: false }, { mode: 'reference', samples: 1 }],
  ['reference-4x', { extend: false }, { mode: 'reference', samples: 4 }],
  ['peel-1x', { samples: 1 }, { samples: 1, layers: 4 }, 'accept'],
  ['peel-1x-k3', { samples: 1 }, { samples: 1, layers: 3 }, 'exhausted'],
  ['splats-first-1x', { samples: 1 }, { samples: 1, layers: 4, schedule: 'splats-first' }, 'reject'],
  ['glass-first-1x', { samples: 1 }, { samples: 1, layers: 4, schedule: 'glass-first' }, 'reject'],
  ['no-discard-1x', { samples: 1, filter: false }, { samples: 1, layers: 4 }, 'reject'],
  ['tie-front-1x', { samples: 1, tie: 'front' }, { samples: 1, layers: 4 }, 'reject'],
  ['coincident-reversed-1x', { samples: 1 }, { samples: 1, layers: 4, glassOrder: 'reversed' }, 'reject'],
  ['peel-4x', { samples: 4 }, { samples: 4, layers: 4 }, 'accept'],
  ['peel-4x-k3', { samples: 4 }, { samples: 4, layers: 3 }, 'exhausted'],
  ['per-pixel-peel-4x', { samples: 1 }, { samples: 4, layers: 4, peelRate: 'pixel' }, 'reject'],
  ['splats-first-4x', { samples: 4 }, { samples: 4, layers: 4, schedule: 'splats-first' }, 'reject'],
  ['glass-first-4x', { samples: 4 }, { samples: 4, layers: 4, schedule: 'glass-first' }, 'reject'],
  ['no-discard-4x', { samples: 4, filter: false }, { samples: 4, layers: 4 }, 'reject'],
  ['tie-front-4x', { samples: 4, tie: 'front' }, { samples: 4, layers: 4 }, 'reject'],
  ['coincident-reversed-4x', { samples: 4 }, { samples: 4, layers: 4, glassOrder: 'reversed' }, 'reject'],
  // frag_depth = position.z under sample_index shading; expectation follows the measured probe.
  ['position-z-4x', { samples: 4 }, { samples: 4, layers: 4, sampleDepth: 'position' }, 'platform'],
  // #8564 option B on the installed renderer (no plugin), and its split-off negative control.
  ['nearest-1x', null, { mode: 'nearest', samples: 1 }, 'nearest'],
  ['nearest-4x', null, { mode: 'nearest', samples: 4 }, 'nearest'],
  ['nearest-split-off-1x', null, { mode: 'nearest', samples: 1, split: 'off' }, 'nearest-control'],
  ['nearest-split-off-4x', null, { mode: 'nearest', samples: 4, split: 'off' }, 'nearest-control'],
].map(([id, plugin, page, expect]) => ({ id, plugin, page: { mode: 'candidate', ...page, sizes: sizes.join(','), panes: PANES }, expect }))
  .filter(run => run.page.mode === 'reference' || (process.env.PEEL_RUNS ? process.env.PEEL_RUNS.split(',').includes(run.id)
    : process.env.PEEL_ALL || ['peel-1x', 'peel-4x'].includes(run.id) || run.page.mode === 'nearest'));

await mkdir(output, { recursive: true });
const shaders = await readPublishedShaders(resolve(root, 'node_modules/@luma.gl/splats/dist/splat-shaders.js')); // hook stripped, hash-verified
const files = ['peel-acceptance.mjs', 'peel-gpu.mjs', 'peel-nearest.mjs', 'peel-plugin.mjs', 'peel-probe.mjs', 'peel-scene.mjs', 'peel-validate.mjs', 'peel-witness.html', 'peel-witness.mjs'];
const evidence = {
  issue: 8564, mode: 'SwiftShader correctness only', productionReady: false,
  sourceCommit: git(['rev-parse', 'HEAD']), workingTreeDirty: git(['status', '--porcelain']).length > 0,
  witnessFiles: Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await readFile(resolve(root, 'contract', file)))]))),
  upstream: { installedRendererSha256: INSTALLED_RENDERER_SHA256, upstreamShadersSha256: UPSTREAM_SHADERS_SHA256,
    extendedShadersSha256: Object.fromEntries([1, 4].flatMap(samples => [[true, 'behind'], [false, 'behind'], [true, 'front']].map(([filter, tie]) =>
      [`${samples}x${filter ? '' : '-no-discard'}${tie === 'front' ? '-tie-front' : ''}`, sha256(extendSplatShaders(shaders, { samples, filter, tie }))]))) },
  scenes: ['orthographic', 'perspective'].flatMap(projection => sizes.flatMap(size => [1, 4].map(samples =>
    ({ projection, size, samples, ...auditScene(buildScene(size, projection), samples) })))),
  runs: [], errors: [],
};
const references = new Map(), peels = new Map(), key = (samples, projection, size, panes) => `${samples}/${projection}/${size}/${panes}`;
const decode = text => new Uint8Array(Buffer.from(text, 'base64'));

function judge(run, row, scene, probe) {
  const { samples, layers, peelRate } = run.page, peelSamples = peelRate === 'pixel' ? 1 : samples;
  const reference = references.get(key(samples, row.projection, row.size, row.panes));
  const comparison = comparePeelImages(reference.pixels, decode(row.pixels));
  const expected = expectedExhaustion(scene, peelSamples, layers);
  const verdict = { ...comparison, exhaustion: row.exhaustion };
  if (run.expect === 'accept') peels.set(key(samples, row.projection, row.size, row.panes), decode(row.pixels));
  const result = { panes: row.panes, projection: row.projection, size: row.size, ...comparison, rejection: peelRejection(verdict),
    exhaustion: { ...row.exhaustion, expected }, layerDepth: row.layerDepth, cost: row.cost, wallMs: row.wallMs };
  run.judged = [...(run.judged ?? []), result];
  if (run.expect === 'platform') {
    // A conforming per-sample position.z must pass; SwiftShader's per-pixel value must fail.
    if (probe.perSamplePositionZ) assert.equal(result.rejection, null, `${run.id}: ${result.rejection}`);
    else assert.ok(row.layerDepth.mismatches > 0 && comparison.differentChannels > 0 && result.rejection !== null, `${run.id}: expected the probed defect`);
    return result;
  }
  assert.equal(row.exhaustion.reported, expected.exhausted, `${run.id}: exhaustion report must match the analytic layer count`);
  assert.equal(row.layerDepth.mismatches, 0, `${run.id}: every peeled depth sample must equal the analytic layer depth ${JSON.stringify(row.layerDepth.firstMismatches)}`);
  assert.ok(comparison.referenceSplatTexels > 0 && comparison.candidateSplatTexels > 0, `${run.id}: both images need red splat texels`);
  if (run.expect === 'accept') assert.equal(result.rejection, null, `${run.id}: ${result.rejection}`);
  else if (run.expect === 'exhausted') {
    assert.match(result.rejection ?? '', /exhausted/);
    // Same predicate with the exhaustion report suppressed: the truncated image itself fails.
    result.suppressedReportRejection = peelRejection({ ...verdict, exhaustion: { reported: false } });
    assert.match(result.suppressedReportRejection ?? '', /exactly match/);
  } else {
    assert.ok(result.rejection !== null && comparison.differentChannels > 0, `${run.id}: negative control must fail acceptance`);
  }
  return result;
}

/** Option B: per texel against the reference and the K-layer peel of the same case. */
function judgeNearestRow(run, row, probe) {
  const { samples } = run.page, id = key(samples, row.projection, row.size, row.panes);
  const scene = buildScene(row.size, row.projection, { panes: row.panes }), counts = layerCounts(scene, samples), pixels = decode(row.pixels);
  // P1 is fixed-function depth (as in the renderer); the probe says whether this backend evaluates it per standard sample.
  const conformantDepth = samples === 1 || JSON.stringify(probe?.slopedFixedFunction) === JSON.stringify(probe?.slopedExpected);
  const sensitive = conformantDepth ? null : mirrorSensitive(scene, samples);
  const toReference = compareByLayers(references.get(id).pixels, pixels, counts, sensitive);
  const toPeel = peels.has(id) ? compareByLayers(peels.get(id), pixels, counts, sensitive) : null;
  const verdict = judgeNearest({ toReference, toPeel, layers: row.layers, counts, control: run.expect === 'nearest-control', tolerance: NEAREST_TOLERANCE,
    panes: row.panes, conformantDepth });
  return { panes: row.panes, projection: row.projection, size: row.size, tolerance: NEAREST_TOLERANCE, layers: row.layers, toReference, toPeel, ...verdict,
    imageSha256: sha256(pixels), wallMs: row.wallMs };
}

let browser;
try {
  browser = backend === 'hardware' ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL) : await chromium.launch({ headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  evidence.browser = browser.version();
  evidence.backend = backend;
  evidence.mode = backend === 'hardware' ? 'hardware GPU correctness (Windows Chrome over CDP)' : 'SwiftShader correctness only';
  // References first, then the K-layer peel, then option B (judged against both).
  const order = run => run.page.mode === 'reference' ? 0 : run.page.mode === 'candidate' ? 1 : 2;
  RUNS.sort((a, b) => order(a) - order(b));
  for (const pluginKey of [...new Set(RUNS.map(run => JSON.stringify(run.plugin)))]) {
    const plugin = pluginKey === 'null' ? null : peelPlugin(JSON.parse(pluginKey));
    const server = await createServer({ root, configFile: false, logLevel: 'warn', plugins: plugin ? [plugin] : [], optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } } });
    try {
      await server.listen();
      for (const run of RUNS.filter(candidate => JSON.stringify(candidate.plugin) === pluginKey)) {
        const context = backend === 'hardware' ? await browser.newContext() : null;
        const page = await (context ?? browser).newPage(), pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        const started = Date.now();
        try {
          await page.goto(`${server.resolvedUrls.local[0]}contract/peel-witness.html?${new URLSearchParams(run.page)}`);
          await page.waitForFunction(() => Boolean(window.peelWitness), undefined, { timeout: 20 * 60 * 1000, polling: 500 });
          const witness = await page.evaluate(() => window.peelWitness);
          const record = { id: run.id, plugin: run.plugin, page: run.page, expect: run.expect, pageErrors, seconds: Math.round((Date.now() - started) / 1000) };
          evidence.runs.push(record);
          assert.equal(witness.error, undefined, witness.error);
          assert.deepEqual(pageErrors, []);
          assert.deepEqual(witness.result.errors, []);
          if (plugin) assert.deepEqual([...plugin.loaded].sort(), ['renderer', 'shaders'], 'hash-checked upstream modules must pass through the plugin');
          Object.assign(record, { adapter: witness.result.adapter, probe: witness.result.probe });
          if (backend === 'hardware') assert.ok(isHardwareAdapter(witness.result.adapter), `hardware run used ${JSON.stringify(witness.result.adapter)}`);
          if (run.page.mode === 'reference') {
            record.cases = witness.result.cases.map(row => {
              const pixels = decode(row.pixels);
              references.set(key(row.samples, row.projection, row.size, row.panes), { pixels });
              return { panes: row.panes, projection: row.projection, size: row.size, splatTexels: pixels.filter((v, i) => i % 4 === 0 && v > 0).length,
                imageSha256: sha256(pixels), cost: row.cost, wallMs: row.wallMs };
            });
          } else if (run.page.mode === 'nearest') {
            record.cases = witness.result.cases.map(row => judgeNearestRow(run, row, witness.result.probe));
          } else {
            // A K-layer verdict failure is recorded (not fatal) so option B is still judged against it.
            try { record.cases = witness.result.cases.map(row => judge(run, row, buildScene(row.size, row.projection, { panes: row.panes }), witness.result.probe)); }
            catch (error) { record.failure = error.message; }
            finally { record.cases ??= run.judged; }
          }
        } finally { await page.close(); await context?.close(); }
      }
    } finally { await server.close(); }
  }
  const accepted = evidence.runs.filter(run => run.expect === 'accept');
  evidence.summary = Object.fromEntries(evidence.runs.filter(run => run.expect).map(run => [run.id, run.cases?.map(c => run.page.mode === 'nearest'
    ? `${c.panes[0]}${c.projection[0]}${c.size}:${c.toReference.single.differentTexels}(${c.toReference.single.unexplainedTexels})/${c.toReference.multiple.differentTexels}${c.layers.reported[0]}${c.pass ? (c.platformExplained ? 'P' : 'A') : 'R'}`
    : `${c.panes?.[0] ?? ''}${c.projection[0]}${c.size}:${c.differentChannels}${c.rejection ? 'R' : 'A'}`).join(' ')]));
  evidence.accepted = accepted.length > 0 && evidence.runs.every(run => !run.failure) && accepted.every(run => run.cases?.every(c => c.rejection === null));
  const nearest = evidence.runs.filter(run => run.page.mode === 'nearest');
  evidence.nearestAccepted = nearest.length > 0 && nearest.every(run => run.cases?.length > 0 && run.cases.every(c => c.pass));
  if (!evidence.nearestAccepted) process.exitCode = 1;
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await writeFile(resolve(output, `peel-result-${backend}.json`), JSON.stringify(evidence) + '\n');
}
console.log(JSON.stringify({ accepted: evidence.accepted, nearestAccepted: evidence.nearestAccepted, summary: evidence.summary, failure: evidence.failure, output }, null, 1));
