#!/usr/bin/env -S npx tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native (real-GPU) structural count driver for #6993 acceptance. Manual and
 * local, like frame-gpu-rig.mts, whose Windows Chrome lifecycle, host and
 * physical-session admission and static server it reuses:
 *
 *   pnpm build && pnpm fixtures
 *   flock /tmp/ifclite-perf.lock npx tsx scripts/perf/native-count-driver.mts \
 *     --branch-revision <built revision> [--require-host-idle] [--require-physical-display]
 *
 * Two fresh loads each of FZK and Snowdon, one fresh Windows Chrome profile
 * per sample, at exactly NATIVE_COUNT_QUERY, loaded through the canonical
 * file input (a Buffer payload: Windows Chrome cannot open a WSL path). The
 * load, readiness and counter settling are ViewerBenchmarkPage's own; the
 * per-sample verdict and the repeat summary are native-count-evidence.ts.
 * Forced device-loss recovery is out of scope (evidence/recovery-replay-6993).
 * `--plan` prints the samples and URL without launching anything.
 */

import { chromium, type Browser } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { requireSpanSource } from './browser-span-source.mjs';
import { startStaticServer } from './browser-static-server.js';
import { closeBrowserWithTimeout, raceWithTimeout } from './browser-cold-teardown.js';
import { validateBrowserFixtures } from './browser-cold-fixtures.js';
import { isPhysicalConsole, readPhysicalSession } from './frame-gpu-session.js';
import { isHardwareAdapter } from './hardware-adapter.mjs';
import { readHostAdmission, type HostAdmission } from './frame-gpu-host.js';
import { findWindowsChrome, launchWindowsChrome } from './frame-gpu-chrome.js';
import { ViewerBenchmarkPage } from '../../tests/benchmark/viewer-benchmark-page.js';
import { measureInteractionCommits } from '../../tests/benchmark/interaction-commits.js';
import { readGpuHealth, type GpuHealth } from '../../tests/benchmark/gpu-health.js';
import {
  assessCountSample, decodeCountQuery, fixtureReceipt, nativeCountPlan, sha256File, summarizeCountSamples,
  NATIVE_COUNT_FIXTURES, NATIVE_COUNT_QUERY, type PlannedSample, type SampleVerdict,
} from './native-count-evidence.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const argv = process.argv.slice(2);
const VALUE_FLAGS = ['--branch-revision', '--dist', '--out-dir', '--chrome', '--timeout-ms'];
const BOOLEAN_FLAGS = ['--plan', '--require-host-idle', '--require-physical-display'];
const fail = (message: string): never => { console.error(`native-count-driver: ${message}`); process.exit(2); };
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.includes(argv[i])) { if (argv[++i] === undefined) fail(`${argv[i - 1]} needs a value`); }
  else if (!BOOLEAN_FLAGS.includes(argv[i])) fail(`unknown argument ${argv[i]} (the query, fixtures and sample count are fixed)`);
}
const flag = (name: string) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const TIMEOUT_MS = Number(flag('--timeout-ms') ?? 600_000);
if (!Number.isInteger(TIMEOUT_MS) || TIMEOUT_MS <= 0) fail('--timeout-ms must be a positive integer');
const REQUIRE_HOST_IDLE = argv.includes('--require-host-idle');
const REQUIRE_PHYSICAL = argv.includes('--require-physical-display');
const SETTINGS = decodeCountQuery(NATIVE_COUNT_QUERY);
const DIST = resolve(ROOT, flag('--dist') ?? 'apps/viewer/dist');

if (argv.includes('--plan')) {
  console.log(JSON.stringify({
    query: NATIVE_COUNT_QUERY, settings: SETTINGS, dist: DIST, lock: 'flock /tmp/ifclite-perf.lock',
    samples: nativeCountPlan('http://127.0.0.1:<port>'),
  }, null, 2));
  process.exit(0);
}

// Admit the source, build and fixtures before any host or browser work (#7005).
const BRANCH_REVISION = requireSpanSource(ROOT, flag('--branch-revision'));
const fixtures = NATIVE_COUNT_FIXTURES.map((fixture) => ({ ...fixture, abs: join(ROOT, fixture.path) }));
try { validateBrowserFixtures(fixtures.map(({ key, abs }) => ({ name: key, path: abs }))); }
catch (error) { fail(`${String(error)} (public fixtures: \`pnpm fixtures\`)`); }
if (!existsSync(join(DIST, 'index.html'))) fail(`not a viewer build: ${DIST}`);
const manifest = JSON.parse(readFileSync(join(ROOT, 'tests/models/manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
// A manifest mismatch is an admission refusal like the checks above (exit 2), not a crash.
const fixtureReceipts = (() => {
  try { return fixtures.map((fixture) => fixtureReceipt(ROOT, fixture, manifest)); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
})();
const CHROME = findWindowsChrome(flag('--chrome'));
const OUT_DIR = resolve(ROOT, flag('--out-dir') ?? `scripts/perf/.native-count-results/run-${Date.now()}`);
mkdirSync(OUT_DIR, { recursive: true });

const pkgWasm = join(ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm');
const servedWasm = new Map<string, string>();
const server = await startStaticServer({
  port: 0, host: '127.0.0.1', root: () => DIST,
  onServe: (_pathname, file) => { if (file.endsWith('.wasm') && !servedWasm.has(file)) servedWasm.set(file, sha256File(file)); },
});
const ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const receipt = {
  driver: 'native-count-driver', issue: 6993, startedAt: new Date().toISOString(), branchRevision: BRANCH_REVISION,
  query: NATIVE_COUNT_QUERY, settings: SETTINGS, route: 'input[type=file] -> useIfcLoader.loadFile',
  chrome: { executable: CHROME, versions: [] as string[] },
  dist: { path: DIST, indexSha256: sha256File(join(DIST, 'index.html')),
    wasm: (existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')) : []).filter((f) => f.endsWith('.wasm')).map((f) => ({ file: `assets/${f}`, sha256: sha256File(join(DIST, 'assets', f)) })) },
  pkgWasm: existsSync(pkgWasm) ? { path: 'packages/wasm/pkg/ifc-lite_bg.wasm', sha256: sha256File(pkgWasm) } : null,
  servedWasm: [] as { file: string; sha256: string }[],
  fixtures: fixtureReceipts,
  admission: { requireHostIdle: REQUIRE_HOST_IDLE, requirePhysicalDisplay: REQUIRE_PHYSICAL },
  scope: 'Structural GPU allocation/static-upload and sender transfer counts over fresh count-mode loads. No latency, throughput or CPU mesh byte-identity claim; forced device-loss recovery is covered separately.',
};
writeFileSync(join(OUT_DIR, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

interface SampleRecord extends PlannedSample {
  verdict: SampleVerdict; error: string | null; chromeVersion: string | null; adapter: unknown;
  hostBefore: HostAdmission | null; hostAfter: HostAdmission | null; sessionBefore: unknown; sessionAfter: unknown;
  loadCounters: unknown; interactionCommits: unknown; gpuHealth: unknown; pageErrors: string[]; trace: unknown;
}

async function runSample(planned: PlannedSample, abs: string): Promise<SampleRecord> {
  const refusals: string[] = [], pageErrors: string[] = [];
  const record: Partial<SampleRecord> = { ...planned, error: null, chromeVersion: null, adapter: null, hostBefore: null, hostAfter: null, pageErrors };
  let bench: ViewerBenchmarkPage | null = null, settled = false, interactionErrors: Record<string, string> = {};
  let gpuHealth: GpuHealth | null = null;
  let chrome: Awaited<ReturnType<typeof launchWindowsChrome>> | undefined, browser: Browser | undefined;
  try {
    record.hostBefore = await readHostAdmission();
    if (REQUIRE_HOST_IDLE && !record.hostBefore.quiet) throw new Error('host pre-admission refused');
    const sessionBefore = readPhysicalSession();
    record.sessionBefore = sessionBefore;
    if (REQUIRE_PHYSICAL && !isPhysicalConsole(sessionBefore)) throw new Error('physical-console admission refused');
    chrome = await launchWindowsChrome(CHROME);
    browser = await raceWithTimeout(chromium.connectOverCDP(chrome.cdpUrl), 30_000, 'connectOverCDP');
    record.chromeVersion = browser.version();
    const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 500)));
    page.on('crash', () => pageErrors.push('page crashed'));
    bench = new ViewerBenchmarkPage(page, ORIGIN);
    await bench.setup({ query: NATIVE_COUNT_QUERY });
    await page.bringToFront();
    await bench.loadUntilCountReady({ name: basename(abs), mimeType: 'application/octet-stream', buffer: readFileSync(abs) }, TIMEOUT_MS);
    settled = await bench.settleLoadCounters();
    record.loadCounters = bench.getLoadCounters();
    record.adapter = await page.evaluate(() => (globalThis as { __ifc_lite_render_stats__?: () => { adapter?: unknown } }).__ifc_lite_render_stats__?.().adapter ?? null);
    if (REQUIRE_PHYSICAL && !isHardwareAdapter(record.adapter)) refusals.push('renderer adapter missing or software');
    const commits = await measureInteractionCommits(page);
    record.interactionCommits = commits;
    interactionErrors = commits.errors;
    // GPU health last: session counters are totals since boot, interactions included.
    gpuHealth = await readGpuHealth(page, bench.getConsoleLogs());
    record.gpuHealth = gpuHealth;
    const sessionAfter = readPhysicalSession();
    record.sessionAfter = sessionAfter;
    if (REQUIRE_PHYSICAL && (!isPhysicalConsole(sessionAfter) || sessionBefore.currentSession !== sessionAfter.currentSession)) refusals.push('physical-console session changed during the sample');
    record.hostAfter = await readHostAdmission();
    if (REQUIRE_HOST_IDLE && !record.hostAfter.quiet) refusals.push('host post-admission refused');
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    refusals.push(`sample error: ${record.error}`);
  } finally {
    const closeError = await closeBrowserWithTimeout(browser, 15_000);
    const disposeError = (await chrome?.dispose()) ?? null;
    if (closeError) console.error(`native-count-driver: cleanup: ${closeError}`);
    if (disposeError) refusals.push(`owned profile cleanup: ${disposeError}`);
  }
  record.trace = bench?.getLoadTrace() ?? null;
  record.verdict = assessCountSample({
    trace: bench?.getLoadTrace() ?? null, countersSettled: settled, gpuHealth,
    pageErrors, interactionErrors, refusals,
  });
  if (bench) writeFileSync(join(OUT_DIR, `${planned.fixture}-${planned.iteration}.console.log`), bench.getConsoleLogs().join('\n'));
  return record as SampleRecord;
}

const samples: SampleRecord[] = [];
try {
  for (const planned of nativeCountPlan(ORIGIN)) {
    console.log(`native-count-driver: ${planned.fixture} load ${planned.iteration}`);
    const sample = await runSample(planned, join(ROOT, planned.path));
    samples.push(sample);
    // Failed evidence is kept: every sample is written, healthy or not.
    writeFileSync(join(OUT_DIR, `${planned.fixture}-${planned.iteration}.json`), JSON.stringify(sample, null, 2) + '\n');
    console.log(`  ${sample.verdict.healthy ? 'healthy' : `REFUSED: ${sample.verdict.refusals.join('; ')}`}`);
  }
} finally {
  server.close();
}
receipt.chrome.versions = [...new Set(samples.map((s) => s.chromeVersion).filter((v): v is string => v !== null))];
receipt.servedWasm = [...servedWasm].map(([file, sha256]) => ({ file: file.slice(DIST.length + 1), sha256 }));
writeFileSync(join(OUT_DIR, 'receipt.json'), JSON.stringify({ ...receipt, finishedAt: new Date().toISOString() }, null, 2) + '\n');
const fixturesSummary = summarizeCountSamples(samples);
const ok = samples.every((s) => s.verdict.healthy) && fixturesSummary.every((f) => f.repeat === true);
const summary = {
  ok, fixtures: fixturesSummary,
  samples: samples.map((s) => ({ fixture: s.fixture, iteration: s.iteration, healthy: s.verdict.healthy, refusals: s.verdict.refusals, chromeVersion: s.chromeVersion, hostQuietBefore: s.hostBefore?.quiet ?? null, hostQuietAfter: s.hostAfter?.quiet ?? null })),
};
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary.fixtures.map(({ fixture, healthy, repeat }) => ({ fixture, healthy, repeat }))));
console.log(`native-count-driver: ${ok ? 'all samples healthy and repeating' : 'NOT accepted'}; ${OUT_DIR}`);
process.exit(ok ? 0 : 1);
