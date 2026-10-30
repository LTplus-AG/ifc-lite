#!/usr/bin/env -S npx tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8341 measurement-debt cohort: the repository's fresh-process browser
 * worker-pool cold load (`scripts/perf/browser-cold-ab.mts` sample sequence,
 * unchanged), with three additions the stock harness lacks:
 *  - balanced, seeded, randomized within-pair order per fixture
 *    (`scripts/perf/ab-order.mjs`, the native ab.sh order) instead of base-first;
 *  - kernel peak RSS (`VmHWM`) of every Chrome process, read after readiness and
 *    before teardown: the renderer that hosts the page and its geometry workers,
 *    the GPU process, and the whole-browser sum (shared pages counted per process);
 *  - a CPU geometry payload root: SHA-256 over every retained mesh (expressId,
 *    colour, positions, normals, indices) plus instanced-only geometry hashes,
 *    computed after the memory read so hashing cannot inflate the peak.
 * Rows stay compatible with `scripts/perf/browser-ab-report.mjs` for timing.
 *
 * Usage: npx tsx tests/evidence/c4-browser-8341/browser-cohort.mts FIXTURE...
 *   --dist-base DIR --dist-branch DIR --base-revision SHA --branch-revision SHA
 *   --out DIR [--iters 5] [--seed N] [--port 38341] [--headed] [--browser-executable PATH]
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../../../scripts/perf/browser-static-server.ts';
import { runColdSample } from '../../../scripts/perf/browser-cold-sample.ts';
import { closeBrowserWithTimeout, closeContextWithTimeout, raceWithTimeout } from '../../../scripts/perf/browser-cold-teardown.ts';
import { requireSpanSource } from '../../../scripts/perf/browser-span-source.mjs';
import { roundOrder, seededRand } from '../../../scripts/perf/ab-order.mjs';
import { ViewerBenchmarkPage } from '../../benchmark/viewer-benchmark-page.ts';
import { readGpuHealth } from '../../benchmark/gpu-health.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const VALUED = new Set(['--dist-base', '--dist-branch', '--base-revision', '--branch-revision', '--out', '--iters', '--seed', '--port', '--browser-executable']);
const flag = (name: string) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const fixtures = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1] ?? '')).map((p) => resolve(p));
const need = (name: string) => { const v = flag(name); if (!v) throw new Error(`${name} is required`); return v; };
const DIST = { base: resolve(need('--dist-base')), branch: resolve(need('--dist-branch')) };
const REV = { base: requireSpanSource(ROOT, need('--base-revision')), branch: requireSpanSource(ROOT, need('--branch-revision')) };
const OUT = resolve(need('--out'));
const ITERS = Number(flag('--iters') ?? '5');
const SEED = Number(flag('--seed') ?? String(Date.now() % 2147483647));
const PORT = Number(flag('--port') ?? '38341');
const CLOSE_TIMEOUT_MS = 30_000;
if (!Number.isInteger(ITERS) || ITERS < 5) throw new Error('at least five paired rounds are required');
if (fixtures.length === 0 || !fixtures.every(existsSync)) throw new Error('existing fixture paths are required');
for (const d of Object.values(DIST)) if (!existsSync(join(d, 'index.html'))) throw new Error(`not a viewer dist: ${d}`);
if (existsSync(OUT)) throw new Error(`output exists; preserve it and choose a new directory: ${OUT}`);
mkdirSync(join(OUT, 'samples'), { recursive: true });

const executable = flag('--browser-executable');
const launchOptions = {
  headless: !argv.includes('--headed'),
  ...(executable ? { executablePath: resolve(executable) } : {}),
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist'],
};
const label = (side: 'base' | 'branch') => REV[side];
const rand = seededRand(SEED);
const order = Object.fromEntries(fixtures.map((f) => [basename(f), roundOrder(ITERS, rand)]));
writeFileSync(join(OUT, 'plan.json'), JSON.stringify({ seed: SEED, iters: ITERS, revisions: REV, dists: DIST, fixtures, order, launchOptions }, null, 2) + '\n');

/** Every live descendant of this process: Playwright spawns Chrome directly. */
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      parent.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* exited while listing */ }
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const [child, ppid] of parent) if (ppid === pid) { out.push(child); queue.push(child); }
  }
  return out;
}

type ProcessPeak = { pid: number; type: string; hwmKiB: number; rssKiB: number };
function chromePeaks(): ProcessPeak[] {
  const peaks: ProcessPeak[] = [];
  for (const pid of descendants(process.pid)) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!/chrom/i.test(cmd[0] ?? '')) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const kib = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? NaN);
      const type = cmd.find((a) => a.startsWith('--type='))?.slice(7) ?? 'browser';
      peaks.push({ pid, type, hwmKiB: kib('VmHWM'), rssKiB: kib('VmRSS') });
    } catch { /* exited */ }
  }
  return peaks;
}

function memorySummary(peaks: ProcessPeak[]) {
  const renderers = peaks.filter((p) => p.type === 'renderer');
  const finite = peaks.every((p) => Number.isFinite(p.hwmKiB));
  return {
    rendererPeakRssKiB: renderers.length && finite ? Math.max(...renderers.map((p) => p.hwmKiB)) : null,
    gpuPeakRssKiB: peaks.find((p) => p.type === 'gpu-process')?.hwmKiB ?? null,
    browserTreePeakRssSumKiB: peaks.length && finite ? peaks.reduce((a, p) => a + p.hwmKiB, 0) : null,
    processes: peaks,
  };
}

/** In-page sources stay plain strings: tsx keeps function names by wrapping named
 * closures in a `__name` helper that does not exist inside the page. */
const IN_PAGE_HEX = `(b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')`;

/** Order-independent root over the retained CPU payload; runs after readiness. */
async function payloadRoot(page: Page) {
  return page.evaluate(`(async () => {
    const hex = ${IN_PAGE_HEX};
    const bytes = (v) => (ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array());
    const store = globalThis.__ifc_lite_viewer_store__;
    if (!store) return { error: 'viewer store singleton absent' };
    const state = store.getState();
    const results = [...(state.models?.values() ?? [])].map((m) => m.geometryResult).filter(Boolean);
    if (results.length === 0 && state.geometryResult) results.push(state.geometryResult);
    const leaves = [];
    let meshes = 0, vertices = 0, triangles = 0, instanced = 0;
    for (const r of results) {
      for (const m of r.meshes) {
        const head = new TextEncoder().encode(JSON.stringify([m.expressId, m.color, m.geometryItemId ?? null]));
        const parts = [head, bytes(m.positions), bytes(m.normals), bytes(m.indices)];
        const joined = new Uint8Array(parts.reduce((a, p) => a + p.byteLength + 8, 0));
        let offset = 0;
        for (const p of parts) { new DataView(joined.buffer).setFloat64(offset, p.byteLength); joined.set(p, offset + 8); offset += p.byteLength + 8; }
        leaves.push(hex(await crypto.subtle.digest('SHA-256', joined)));
        meshes++; vertices += m.positions.length / 3; triangles += m.indices.length / 3;
      }
      for (const [id, h] of r.instancedGeometryHashes ?? []) { leaves.push('i' + id + ':' + h); instanced++; }
    }
    leaves.sort();
    const root = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(leaves.join('\\n'))));
    return { root, models: results.length, meshes, vertices, triangles, instanced };
  })()`) as Promise<Record<string, unknown>>;
}

async function textDigest(page: Page, text: string) {
  return page.evaluate(`(async () => (${IN_PAGE_HEX})(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(${JSON.stringify(text)}))))()`) as Promise<string>;
}

let current = DIST.branch;
const server = await startStaticServer({ port: PORT, root: () => current });
let failures = 0;
for (let round = 1; round <= ITERS; round++) {
  for (const fixture of fixtures) {
    for (const side of order[basename(fixture)][round - 1] as Array<'base' | 'branch'>) {
      current = DIST[side];
      const tag = `${side}-${basename(fixture)}-r${round}`;
      console.log(`c4-browser-8341: ${tag}`);
      let browser: Browser | undefined; let context: BrowserContext | undefined; let page: Page | undefined; let bp: ViewerBenchmarkPage | undefined;
      let record: Record<string, unknown> = { side: label(side), arm: side, fixture: basename(fixture), round, ok: false, launchOptions };
      try {
        browser = await chromium.launch(launchOptions);
        record.browserVersion = browser.version();
        context = await raceWithTimeout(browser.newContext(), CLOSE_TIMEOUT_MS, 'browser.newContext()');
        page = await raceWithTimeout(context.newPage(), CLOSE_TIMEOUT_MS, 'context.newPage()');
        bp = new ViewerBenchmarkPage(page, `http://localhost:${PORT}`);
        const metrics = await runColdSample(bp, { fixturePath: fixture, timeoutMs: 300_000, afterSetup: async () => {
          const isolated = await page!.evaluate(() => globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined');
          if (!isolated) throw new Error('viewer is not cross-origin isolated; worker-pool sample invalid');
        } });
        if (metrics.streamCompleteMs == null || !metrics.totalMeshes) throw new Error('load did not reach streamCompleteMs / produced 0 meshes');
        record = { ...record, ...metrics, memory: memorySummary(chromePeaks()) };
        const gpuHealth = await raceWithTimeout(readGpuHealth(page, bp.getConsoleLogs()), CLOSE_TIMEOUT_MS, 'gpu health');
        record.gpuHealth = gpuHealth;
        if (gpuHealth.contaminated) throw new Error(`GPU device lost during sample (${gpuHealth.reasons.join('; ')})`);
        record.gpuAdapter = await raceWithTimeout(page.evaluate(async () => {
          const a = await navigator.gpu?.requestAdapter();
          if (!a) return null;
          const fallback = 'isFallbackAdapter' in a ? (a as { isFallbackAdapter?: boolean }).isFallbackAdapter : (a.info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter;
          return { architecture: a.info?.architecture ?? '', vendor: a.info?.vendor ?? '', fallback: typeof fallback === 'boolean' ? fallback : null };
        }), CLOSE_TIMEOUT_MS, 'gpu adapter');
        record.payload = await raceWithTimeout(payloadRoot(page), 120_000, 'payload root');
        const diagnostics = bp.getConsoleLogs().filter((l) => /refus|diagnos|fallback|failed/i.test(l));
        record.diagnosticLines = diagnostics.length;
        record.diagnosticDigest = await textDigest(page, diagnostics.map((l) => l.replace(/\d+(\.\d+)?\s*ms/g, '#ms')).join('\n'));
        record.ok = true;
        writeFileSync(join(OUT, 'samples', `${tag}.console.log`), bp.getConsoleLogs().join('\n'));
      } catch (error) {
        record = { ...record, ok: false, error: error instanceof Error ? error.message : String(error) };
        try { writeFileSync(join(OUT, 'samples', `FAILED-${tag}.console.log`), bp?.getConsoleLogs().join('\n') ?? 'no page'); } catch { /* evidence best effort */ }
        console.error(`c4-browser-8341: FAILED ${tag}: ${record.error}`);
      } finally {
        const contextError = await closeContextWithTimeout(context, CLOSE_TIMEOUT_MS);
        const browserError = await closeBrowserWithTimeout(browser, CLOSE_TIMEOUT_MS);
        if (contextError || browserError) record = { ...record, ok: false, error: `owned browser cleanup failed: ${contextError ?? browserError}` };
      }
      if (!record.ok) failures++;
      appendFileSync(join(OUT, 'runs.jsonl'), JSON.stringify(record) + '\n');
    }
  }
}
server.close();
console.log(`c4-browser-8341: ${failures} failed sample(s); rows in ${join(OUT, 'runs.jsonl')}`);
process.exit(failures ? 1 : 0);
