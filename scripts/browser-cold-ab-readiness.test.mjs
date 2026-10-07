/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

/**
 * #7032: the cold A/B (`scripts/perf/browser-cold-ab.mts`) must enable tracing
 * and decide readiness exactly as `ViewerBenchmarkPage` does, because both read
 * the span tree on `window.__IFC_LITE_LOAD_TRACE__`, which only exists when
 * tracing was switched on before boot. It used to be at risk of drifting into
 * a private copy; these tests pin it to the page.
 */
const COLD_AB = new URL('./perf/browser-cold-ab.mts', import.meta.url);
const SAMPLE = new URL('./perf/browser-cold-sample.ts', import.meta.url);
const PAGE = new URL('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);
const SPAN_SPANS = ['parser.complete', 'geometry.streamComplete', 'scene.finalize'];

test('the cold A/B and the benchmark page modules exist', () => {
  assert.ok(existsSync(COLD_AB), 'scripts/perf/browser-cold-ab.mts');
  assert.ok(existsSync(PAGE), 'tests/benchmark/viewer-benchmark-page.ts');
});

test('the cold A/B script still loads and its sample runner exists (child process: fixture-less run refuses with its own message)', () => {
  assert.ok(existsSync(COLD_AB), 'cold A/B source missing');
  assert.ok(existsSync(SAMPLE), 'scripts/perf/browser-cold-sample.ts');
  const run = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(COLD_AB), '--dist-branch', fileURLToPath(new URL('./perf', import.meta.url))], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /no fixtures/);
});

/** A Playwright `Page` double: enough surface for setup + one load. */
function fakePage({ spans, legacyLines }) {
  const initScripts = [];
  const consoleHandlers = [];
  const done = new Set();
  const page = {
    initScripts,
    on: (event, handler) => { if (event === 'console') consoleHandlers.push(handler); },
    addInitScript: async (fn, arg) => { initScripts.push([fn, arg]); },
    goto: async () => {},
    waitForSelector: async () => {},
    waitForLoadState: async () => {},
    reload: async () => {},
    waitForTimeout: () => new Promise((resolve) => setTimeout(resolve, 1)),
    locator: () => ({ first: () => ({ setInputFiles: async () => {
      // The viewer finishes its load right after the file is chosen.
      if (spans) for (const name of SPAN_SPANS) done.add(name);
      for (const text of legacyLines) for (const handler of consoleHandlers) handler({ text: () => text });
    } }) }),
    // The page's in-page reads: the readiness probe (arg has `names`), the trace
    // snapshot (arg is the global's name) and the canvas check (no arg).
    evaluate: async (_fn, arg) => {
      if (arg && typeof arg === 'object' && 'names' in arg) {
        return spans ? { ended: done.size > 0, done: [...done], failed: [] } : null;
      }
      if (typeof arg === 'string') return null;
      return true;
    },
  };
  return page;
}

async function loadPage() {
  assert.ok(existsSync(PAGE), 'benchmark page source missing');
  const { ViewerBenchmarkPage } = await tsImport('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);
  return ViewerBenchmarkPage;
}

test('setup() switches span tracing on before boot, the flag the viewer reads to publish __IFC_LITE_LOAD_TRACE__', async () => {
  const ViewerBenchmarkPage = await loadPage();
  const page = fakePage({ spans: true, legacyLines: [] });
  await new ViewerBenchmarkPage(page, 'http://localhost:0').setup();
  const host = globalThis;
  const before = host.__IFC_LITE_PERF_TRACE;
  try {
    delete host.__IFC_LITE_PERF_TRACE;
    for (const [fn, arg] of page.initScripts) fn(arg);
    assert.equal(host.__IFC_LITE_PERF_TRACE, 1);
  } finally {
    if (before === undefined) delete host.__IFC_LITE_PERF_TRACE;
    else host.__IFC_LITE_PERF_TRACE = before;
  }
});

test('loadUntilReady() completes a sample from the span tree', async () => {
  const ViewerBenchmarkPage = await loadPage();
  const bp = new ViewerBenchmarkPage(fakePage({ spans: true, legacyLines: [] }), 'http://localhost:0');
  await bp.setup();
  await bp.loadUntilReady('model.ifc', 2000);
  assert.equal(bp.getMetrics().canvasHasContent, true);
  assert.ok(bp.getMetrics().metadataRenderReadyMs >= 0);
});

test('loadUntilReady() falls back to the console lines for a base build that predates the span API', async () => {
  const ViewerBenchmarkPage = await loadPage();
  const bp = new ViewerBenchmarkPage(fakePage({ spans: false, legacyLines: [
    '[useIfc] Data model parsing complete for model.ifc: 265ms',
    '[useIfc] Stream complete for model.ifc: 194ms',
    '[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches',
  ] }), 'http://localhost:0');
  await bp.setup();
  await bp.loadUntilReady('model.ifc', 2000);
  assert.equal(bp.getMetrics().canvasHasContent, true);
});

test('loadUntilReady() fails finitely when the viewer never reports readiness', async () => {
  const ViewerBenchmarkPage = await loadPage();
  const bp = new ViewerBenchmarkPage(fakePage({ spans: false, legacyLines: [] }), 'http://localhost:0');
  await bp.setup();
  await assert.rejects(bp.loadUntilReady('model.ifc', 50), /Timed out/);
});

test('runColdSample() runs setup, the caller checks, then loadUntilReady with metadata/render readiness required, all on the page itself', async () => {
  const ViewerBenchmarkPage = await loadPage();
  assert.ok(existsSync(SAMPLE), 'sample runner missing');
  const { runColdSample } = await tsImport('./perf/browser-cold-sample.ts', import.meta.url);
  const bp = new ViewerBenchmarkPage(fakePage({ spans: true, legacyLines: [] }), 'http://localhost:0');
  const order = [];
  for (const name of ['setup', 'loadFile', 'waitForCompletion']) {
    const original = ViewerBenchmarkPage.prototype[name];
    bp[name] = async (...args) => { order.push([name, ...args.slice(1)]); return original.apply(bp, args); };
  }
  const metrics = await runColdSample(bp, { fixturePath: 'model.ifc', timeoutMs: 2000, afterSetup: async () => { order.push(['afterSetup']); } });
  assert.deepEqual(order.map((entry) => entry[0]), ['setup', 'afterSetup', 'loadFile', 'waitForCompletion']);
  assert.equal(order[3][1], true, 'waitForCompletion must require metadata + render readiness');
  assert.equal(metrics.canvasHasContent, true);
});
