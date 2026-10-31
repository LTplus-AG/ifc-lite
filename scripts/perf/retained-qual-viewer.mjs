#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Viewer time to FIRST RETAINED FRAME (#7955 item 6, the #7955 qualification plan, "Viewer").
//
// One fresh Chrome process and profile per sample; the built viewer (`pnpm build:e2e`
// with VITE_RETAINED_GEOMETRY=on) is served by `vite preview` with the staged engine;
// the model is handed to the real `#file-input-open`, i.e. the canonical `loadFile`
// path with `?kernel=retained`. Milestones come from retained-qual-viewer-page.mjs.
// Correctness first: a sample whose store does not show the retained kernel with
// published products, or whose GPU device was lost, FAILS and is reported, never timed.
//
//   node scripts/perf/retained-qual-viewer.mjs --out DIR --rounds 7 \
//     --arm branch:/abs/checkout:/abs/engine [--arm base:/abs/checkout:/abs/engine] \
//     --fixture /abs/model.ifc [--fixture ...] [--gpu swiftshader|hardware] [--headed]
//
// Report-only. A run is labelled exclusive only under an `ifc-fleet --kind benchmark` job
// (IFC_WORKER_KIND) or with --exclusive-receipt ID; every other number says non-exclusive.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { engineIdentity, gitIdentity, parseArgs, parseArms, pinFor, resultEnvelope, roundSides, sha256File, summarizeRows,
  unreleasedQuietWindows, writeResult } from './retained-qual-lib.mjs';
import { startSampler } from './retained-qual-proc.mjs';
import { assertMilestones, assertViewerRetained } from './retained-qual-assert.mjs';
import { INIT_SCRIPT, PAGE_KEY } from './retained-qual-viewer-page.mjs';
import { deviceLossCount, gpuIdentity, isSoftwareAdapter, launchFresh, raceWithTimeout, servedManifestSha256,
  startPreviews, treeDigest, userAgentMemory } from './retained-qual-browser.mjs';

const COLUMNS = ['productMs', 'sceneHeldMs', 'firstRetainedFrameMs', 'terminalMs', 'settledFrameMs', 'uaMemoryBytes',
  'browserPeakHwmKiB', 'browserPeakConcurrentPssKiB', 'longTaskMs'];

/** Everything the store and trace say once the sample is over (one evaluate, JSON-safe). */
const readState = key => {
  const store = globalThis.__ifc_lite_viewer_store__, state = store.getState();
  const model = [...state.models.values()][0], rg = model?.retainedGeometry;
  const trace = globalThis.__IFC_LITE_LOAD_TRACE__?.latest?.() ?? null;
  const milestones = {};
  for (const span of trace?.spans ?? []) if (span.milestone && span.end !== null) milestones[span.name] = span.end - trace.start;
  return { error: state.error ?? null, models: state.models.size, loadState: model?.loadState ?? null,
    summary: rg ? { kernel: rg.kernel, candidates: rg.candidates, started: rg.started, published: rg.published, cancelled: rg.cancelled,
      completeness: rg.completeness, failure: rg.failure ?? null, obligationsUnmet: rg.obligationsUnmet, refused: rg.refused.map(r => ({ expressId: r.expressId, code: r.code })) } : null,
    meshCount: model?.geometryResult?.meshes?.length ?? 0, spans: trace?.spans.map(s => s.name) ?? [],
    traceStartMs: trace?.start ?? null, milestones, hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated, userAgent: navigator.userAgent };
};

export async function viewerSample({ arm, preview, fixture, round, options, expectation, distTree, launcher = launchFresh }) {
  const timeout = Number(options['timeout-ms'] ?? 600000);
  const row = { side: arm.side, path: fixture.path, fixture: basename(fixture.path), round, ok: false, fixtureSha256: fixture.sha256,
    fixtureBytes: fixture.bytes, gpu: options.gpu ?? 'swiftshader', headed: Boolean(options.headed), distSha256: distTree.sha256 };
  let browser, sampler;
  try {
    browser = await launcher({ gpu: row.gpu, channel: options.channel ?? 'chrome', executable: options['browser-executable'], headed: row.headed });
    const { page } = browser;
    await page.addInitScript(INIT_SCRIPT);
    await page.goto(`${preview.origin}/?perfTrace=1&kernel=retained`);
    await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__));
    await page.locator('#file-input-open').waitFor({ state: 'attached', timeout: 60000 });
    sampler = startSampler(null, { intervalMs: 100, profileDir: browser.profileDir, pss: true });
    await page.locator('#file-input-open').setInputFiles(fixture.path);
    await page.waitForFunction(key => { const q = globalThis[key];
      if (q.errors.length || globalThis.__ifc_lite_viewer_store__.getState().error) return true;
      if (q.terminalMs === null) return false;
      return q.firstRetainedFrameMs === null ? performance.now() - q.terminalMs > 30000
        : q.settledFrameMs !== null || performance.now() - q.terminalMs > 4000; },
      PAGE_KEY, { timeout, polling: 100 });
    const memory = sampler.stop(); sampler = null;
    const m = await page.evaluate(key => ({ ...globalThis[key] }), PAGE_KEY);
    const state = await page.evaluate(readState);
    if (m.errors.length) throw new Error(`page instrumentation: ${m.errors.join('; ')}`);
    const adapter = await raceWithTimeout(gpuIdentity(page), 30000, 'gpu adapter');
    const losses = deviceLossCount(browser.consoleLines);
    const ua = await raceWithTimeout(userAgentMemory(page), 120000, 'measureUserAgentSpecificMemory');
    Object.assign(row, { gpuAdapter: adapter, softwareAdapter: isSoftwareAdapter(adapter), webgpuDeviceLosses: losses,
      userAgent: state.userAgent, hardwareConcurrency: state.hardwareConcurrency, crossOriginIsolated: state.crossOriginIsolated, loadTraceMilestonesMs: state.milestones,
      uaMemory: ua, uaMemoryBytes: ua.bytes, longTaskMs: m.longTaskMs, drawCallsAtFirstFrame: m.drawCallsAtFirstFrame,
      browserPeakHwmKiB: memory.maxIndividualHwmKiB, browserPeakConcurrentRssKiB: memory.maxObservedConcurrentRssKiB,
      browserPeakConcurrentPssKiB: memory.maxObservedConcurrentPssKiB, browserMemorySamples: memory.samples, pssCoverage: memory.pssCoverage,
      browserProcesses: Object.values(memory.byPid).map(p => ({ type: p.type ?? 'browser', hwmKiB: p.hwmKiB, peakPssKiB: p.peakPssKiB })),
      browserMemoryCaveat: memory.caveat, pageErrors: browser.pageErrors });
    if (losses > 0) throw new Error(`WebGPU device lost ${losses} time(s) during the sample; contaminated`);
    if (options['require-hardware-gpu'] && row.softwareAdapter) throw new Error(`software WebGPU adapter ${JSON.stringify(adapter)} under --require-hardware-gpu`);
    if (options['require-ua-memory'] && ua.bytes === null) throw new Error(`measureUserAgentSpecificMemory unavailable: ${ua.reason}`);
    assertViewerRetained({ state, requests: browser.requests, spans: state.spans, expectation,
      servedManifestSha256: await servedManifestSha256(preview.origin), expectedManifestSha256: arm.identity.engine.manifestSha256 });
    // The origin is the file input's `change` (canonical loadFile invocation); the trace start rides along as a cross-check.
    const since = value => (value === null ? null : value - m.loadChangeMs);
    const milestones = { loadChangeMs: m.loadChangeMs, firstProductMs: m.firstProductMs, sceneHeldMs: m.sceneHeldMs,
      firstRetainedFrameMs: m.firstRetainedFrameMs, terminalMs: m.terminalMs, settledFrameMs: m.settledFrameMs };
    assertMilestones(milestones);
    Object.assign(row, { ok: true, productMs: since(m.firstProductMs), sceneHeldMs: since(m.sceneHeldMs),
      firstRetainedFrameMs: since(m.firstRetainedFrameMs), terminalMs: since(m.terminalMs),
      settledFrameMs: m.settledFrameMs === null ? null : since(m.settledFrameMs),
      settledNote: m.settledFrameMs === null ? 'no completed frame after the terminal state within 4 s (on-demand renderer); value withheld' : undefined,
      loadTraceStartOffsetMs: state.traceStartMs === null ? null : state.traceStartMs - m.loadChangeMs,
      candidates: state.summary.candidates, published: state.summary.published, refused: state.summary.refused.length, meshes: state.meshCount,
      completeness: state.summary.completeness });
  } catch (error) {
    row.cleanupFailed = error?.cleanupFailed === true;
    row.error = error instanceof Error ? error.message : String(error);
    row.pageErrors = browser?.pageErrors ?? [];
    row.consoleTail = browser?.consoleLines.slice(-15) ?? [];
  } finally {
    sampler?.stop();
    const closeError = browser ? await browser.close() : null;
    if (closeError) { row.cleanupFailed = true; row.ok = false; row.error = `${row.error ?? 'ok'}; browser cleanup failed: ${closeError}`; }
  }
  return row;
}

export async function main(argv) {
  const { options } = parseArgs(argv, { values: ['out', 'rounds', 'seed', 'timeout-ms', 'gpu', 'channel', 'browser-executable', 'expect', 'port-base', 'exclusive-receipt'],
    repeated: ['arm', 'fixture'], flags: ['headed', 'require-ua-memory', 'require-hardware-gpu', 'require-quiet'] });
  if (options.seed !== undefined && !Number.isFinite(Number(options.seed))) throw new Error('--seed must be finite');
  if (!options.out || !options.fixture.length) throw new Error('--out DIR and at least one --fixture are required');
  if (options['require-quiet'] && unreleasedQuietWindows().length) throw new Error(`Unreleased quiet window blocks Pop work: ${unreleasedQuietWindows().join(', ')}`);
  const rounds = Number(options.rounds ?? 7);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  const arms = parseArms(options.arm);
  const expectations = options.expect ? JSON.parse(readFileSync(options.expect, 'utf8')) : {};
  for (const arm of arms) {
    arm.identity = { git: gitIdentity(arm.checkout), engine: await engineIdentity(arm.checkout, arm.engine) };
    if (!existsSync(join(arm.checkout, 'apps/viewer/dist/index.html'))) {
      throw new Error(`${arm.checkout}: no apps/viewer/dist; build it with VITE_RETAINED_GEOMETRY=on IFCLITE_RETAINED_ENGINE=<engine> pnpm build:e2e`);
    }
    arm.dist = treeDigest(join(arm.checkout, 'apps/viewer/dist'));
  }
  const fixtures = [];
  for (const path of options.fixture.map(f => resolve(f))) fixtures.push({ path, bytes: statSync(path).size, sha256: await sha256File(path) });
  const started = Date.now(), out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const result = resultEnvelope({ kind: 'viewer-first-retained-frame', options, arms, identities: arms.map(a => a.identity), fixtures, started });
  result.arms.forEach((entry, i) => { entry.servedDist = arms[i].dist; });
  const base = Number(options['port-base'] ?? 4290);
  let previews = new Map();
  const rows = [];
  try {
    previews = await startPreviews(arms, base);
    const order = await roundSides(arms, rounds, options.seed === undefined ? undefined : Number(options.seed));
    result.order = order;
    samples: for (let round = 1; round <= rounds; round++) for (const side of order[round - 1]) for (const fixture of fixtures) {
      const arm = arms.find(a => a.side === side);
      console.log(`retained-qual-viewer: ${side} ${basename(fixture.path)} round ${round}/${rounds}`);
      const row = await viewerSample({ arm, preview: previews.get(side), fixture, round, options, distTree: arm.dist,
        expectation: pinFor(expectations, side, basename(fixture.path)) });
      rows.push(row);
      appendFileSync(join(out, 'runs.partial.jsonl'), JSON.stringify(row) + '\n');
      if (row.cleanupFailed) break samples;
      console.log(row.ok ? `  ok first retained frame ${row.firstRetainedFrameMs.toFixed(1)} ms (published ${row.published}/${row.candidates})` : `  FAILED ${row.error}`);
    }
  } catch (error) {
    rows.push({ ok: false, phase: 'preview', error: String(error) });
  } finally { await Promise.all([...previews.values()].map(preview => preview.stop())); }
  Object.assign(result, { finishedAt: new Date().toISOString(), rounds, samples: rows.filter(r => r.ok).length, rows: rows.length,
    failures: rows.filter(r => !r.ok).map(r => ({ side: r.side, path: r.path, round: r.round, error: r.error })),
    summary: summarizeRows(rows, COLUMNS), originNote: 'times are ms from the file input change event (canonical loadFile invocation)' });
  writeResult(out, result, rows);
  writeFileSync(join(out, 'DONE'), result.finishedAt);
  console.log(`retained-qual-viewer: ${result.samples}/${rows.length} samples ok; ${out}/result.json`);
  return result.failures.length ? 1 : 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
