/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installWorkerObserver } from './worker-observer.mjs';

const source = process.env.SOURCE_CHECKOUT!;
const manifestPath = process.env.DISTRIBUTION_MANIFEST!;
const output = process.env.COHORT_OUTPUT!;
assert(source && manifestPath && output, 'Source, frozen distribution manifest and fresh output are required');
const contrast = process.env.COHORT_CONTRAST ?? 'rollout';
assert(['default-control', 'rollout', 'pool-isolation'].includes(contrast), 'Unknown comparison');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const mod = (path: string) => import(pathToFileURL(join(source, path)).href);
const require = createRequire(join(source, 'package.json'));
const { chromium } = require('@playwright/test');
const { startStaticServer } = await mod('scripts/perf/browser-static-server.ts');
const { ViewerBenchmarkPage } = await mod('tests/benchmark/viewer-benchmark-page.ts');
const { readGpuHealth } = await mod('tests/benchmark/gpu-health.ts');
const { raceWithTimeout, closeBrowserWithTimeout } = await mod('scripts/perf/browser-cold-teardown.ts');
const { readLinuxHostObservation } = await mod('scripts/perf/frame-gpu-host.ts');
const names = ['ara3d/AC20-FZK-Haus.ifc', 'various/01_Snowdon_Towers_Sample_Structural(1).ifc',
  'ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc', 'various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc'];
const fixtureManifest = JSON.parse(readFileSync(join(source, 'tests/models/manifest.json'), 'utf8'));
const fixtures = names.map(path => {
  const file = join(source, 'tests/models', path);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(sha256, fixtureManifest.files.find((entry: { path: string }) => entry.path === path)?.sha256);
  return { path, file, sha256 };
});
const schedule = fixtures.flatMap((fixture, fixtureIndex) => Array.from({ length: 5 }, (_, index) => {
  const pair = index + 1;
  const sides = (index + fixtureIndex) % 2 === 0 ? ['base', 'candidate'] : ['candidate', 'base'];
  return sides.map(side => ({ fixture: fixture.path, pair, side, contrast }));
}).flat());
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ manifestPath, fixtures, schedule, claims: 'Plan only, no browser or measurement' }, null, 2));
  process.exit(0);
}
assert(process.env.IFC_WORKER_ACTIVE_STATE, 'An admitted exclusive benchmark is required');
assert.equal(process.env.IFC_WORKER_KIND, 'benchmark', 'Ordinary admission cannot qualify timings');
mkdirSync(output);
writeFileSync(join(output, 'schedule.json'), JSON.stringify(schedule, null, 2));
writeFileSync(join(output, 'distributions.json'), JSON.stringify(manifest, null, 2));
const rows: Array<Record<string, unknown>> = [];
let currentRoot = manifest.base.dist;
const served = new Set<string>();
const server = await startStaticServer({ port: 0, host: '127.0.0.1', root: () => currentRoot,
  extra: new Map([['/__perf/frames.js', join(source, 'packages/load-trace/dist/frames.js')]]),
  onServe: (_pathname: string, path: string) => served.add(path),
});
const address = server.address();
assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const args = ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
  '--use-angle=vulkan', '--ignore-gpu-blocklist'];
const cohortErrors: unknown[] = [];
try {
  for (const planned of schedule) {
    const admission = await readLinuxHostObservation();
    assert.equal(admission.activeGraphs.length, 0, 'Concurrent named build/test graph refuses timing');
    assert(admission.MemAvailableKiB >= 41_943_040, 'Available-memory floor refuses timing');
    const fixture = fixtures.find(fixture => fixture.path === planned.fixture)!;
    currentRoot = manifest[planned.side].dist;
    const row: Record<string, unknown> = { ...planned, round: planned.pair, source: manifest[planned.side].source, admission, ok: false };
    rows.push(row);
    let browser;
    const sampleErrors: unknown[] = [];
    try {
      console.log(JSON.stringify({ sample: rows.length, ...planned }));
      browser = await chromium.launch({ executablePath: '/home/louistrue/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
        headless: false, args, timeout: 30_000 });
      const context = await raceWithTimeout(browser.newContext({ viewport: { width: 1440, height: 1000 } }), 30_000, 'newContext');
      await context.addInitScript(installWorkerObserver, { capturePayloads: false });
      const page = await raceWithTimeout(context.newPage(), 30_000, 'newPage');
      const bp = new ViewerBenchmarkPage(page, origin);
      const enabled = contrast === 'pool-isolation' || (contrast === 'rollout' && planned.side === 'candidate');
      const query = `?perfTrace=1&perfMem=1&geomWorkers=4&perf.warmPool=${enabled ? '1' : '0'}`;
      row.query = query;
      await bp.setup({ query });
      await page.evaluate(async () => {
        const module = await import('/__perf/frames.js');
        globalThis.__PRIVATE_FRAME_MONITOR__ = module.startFrameMonitor();
        globalThis.__PRIVATE_SUMMARIZE_FRAMES__ = module.summarizeFrames;
      });
      const isolation = await page.evaluate(() => ({ isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined' }));
      assert(isolation.isolated && isolation.sab, 'A genuine isolated worker-pool path is required');
      await bp.loadUntilReady(fixture.file, 600_000);
      row.metrics = bp.getMetrics();
      Object.assign(row, row.metrics);
      row.metricSources = bp.getMetricSources();
      row.loadCounters = bp.getLoadCounters();
      row.memoryPhaseLogs = bp.getConsoleLogs().filter((line: string) => /^\[mem(?:-summary)?\]/.test(line));
      assert((row.memoryPhaseLogs as string[]).some(line => line.startsWith('[mem-summary]')), 'Missing perfMem peak summary');
      const summary = (row.memoryPhaseLogs as string[]).findLast(line => line.startsWith('[mem-summary]'))!;
      row.memorySummary = Object.fromEntries([...summary.matchAll(/(peakJs|peakWasm|geom|source|transport)=([\d.]+)MB/g)]
        .map(match => [match[1] + 'LoggedMiB', Number(match[2])]));
      assert((row.memorySummary as Record<string, number>).peakWasmLoggedMiB > 0, 'Missing positive logged WASM peak');
      row.trace = bp.getLoadTrace();
      const metrics = row.metrics as Record<string, unknown>;
      assert(typeof metrics.totalMeshes === 'number' && metrics.totalMeshes > 0, 'No completed geometry');
      for (const name of ['firstBatchWaitMs', 'firstVisibleGeometryMs', 'totalWallClockMs', 'metadataRenderReadyMs']) {
        assert(typeof metrics[name] === 'number' && Number.isFinite(metrics[name]) && metrics[name] >= 0,
          `Missing actual ${name}`);
      }
      assert.equal((row.trace as { attrs?: { loadPath?: string } })?.attrs?.loadPath, 'wasm', 'Cold load bypassed WASM');
      row.workerEvents = await page.evaluate(() => globalThis.__PRIVATE_POOL_EVENTS__);
      row.frames = await page.evaluate(() => {
        const trace = globalThis.__IFC_LITE_LOAD_TRACE__.latest();
        const monitor = globalThis.__PRIVATE_FRAME_MONITOR__;
        const entries = monitor.entries();
        if (entries.length >= 20_000) throw new Error('Frame log capacity reached');
        return globalThis.__PRIVATE_SUMMARIZE_FRAMES__(entries, monitor.supported, trace.start,
          trace.end ?? performance.now(), trace.spans);
      });
      row.gpuHealth = await readGpuHealth(page, bp.getConsoleLogs());
      assert.equal((row.gpuHealth as { contaminated: boolean }).contaminated, false, 'GPU-contaminated sample');
      assert.equal((row.gpuHealth as { uncapturedErrors: number }).uncapturedErrors, 0, 'Uncaptured GPU error refuses timing');
      row.adapter = await page.evaluate(async () => {
        const adapter = await navigator.gpu.requestAdapter();
        return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
          isFallbackAdapter: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null } : null;
      });
      const adapter = row.adapter as { vendor: string; isFallbackAdapter: boolean } | null;
      assert(adapter && adapter.isFallbackAdapter === false && /nvidia|intel|amd|apple/i.test(adapter.vendor), 'Hardware GPU required');
      row.ok = true;
      writeFileSync(join(output, `sample-${rows.length}-trace.json`), JSON.stringify(row.trace));
      if (planned.pair === 1) await page.screenshot({ path: join(output, `sample-${rows.length}.png`) });
    } catch (error) {
      row.error = String(error);
      sampleErrors.push(error);
    } finally {
      row.cleanupError = await closeBrowserWithTimeout(browser, 30_000);
      appendFileSync(join(output, 'rows.jsonl'), JSON.stringify(row) + '\n');
    }
    if (row.cleanupError) sampleErrors.push(new Error(`Browser cleanup uncertain: ${row.cleanupError}`));
    if (sampleErrors.length > 0) throw new AggregateError(sampleErrors, `Sample ${rows.length} failed`);
  }
  writeFileSync(join(output, 'completion.json'), JSON.stringify({ complete: rows.length === schedule.length,
    samples: rows.length, allSucceeded: rows.every(row => row.ok), served: [...served],
    claims: 'Fresh-process cold timing with a hardware adapter; separate output-identity and resident-memory cohorts remain required.' }, null, 2));
} catch (error) {
  cohortErrors.push(error);
} finally {
  try {
    await raceWithTimeout(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      30_000, 'static server close');
  } catch (error) {
    cohortErrors.push(error);
  }
}
if (cohortErrors.length > 0) throw new AggregateError(cohortErrors, 'Recorded-cohort reproduction failed');
