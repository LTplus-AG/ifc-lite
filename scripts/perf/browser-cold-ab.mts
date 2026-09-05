#!/usr/bin/env -S npx tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser cold-load A/B harness (#3978).
 *
 * DELIBERATELY MANUAL — NOT WIRED INTO CI. This launches a real, dedicated
 * Chromium process per sample and can drive multi-hundred-MB private models;
 * neither belongs on a shared PR runner. `.github/workflows/benchmark.yml`
 * (advisory, small public fixtures, one shared browser per worker) is the
 * CI-wired sibling of this tool and is unaffected by it. Nothing here is
 * invoked by any workflow — `node scripts/check-test-wiring.mjs` does not
 * expect a `package.json` script for a script under `scripts/perf/`, the same
 * carve-out `ab.sh`/`probe.sh` already use for their native counterparts.
 *
 * WHAT "COLD" MEANS HERE, and what it does not:
 *   - Each sample gets a brand-new `chromium.launch()` with NO persistent
 *     profile, closed completely before the next sample starts. That forces
 *     a fresh WASM module instantiation, fresh geometry-worker pool startup,
 *     and an empty Cache API / localStorage / IndexedDB every time — the
 *     three things a warm second load in the SAME tab would short-circuit.
 *   - It does NOT control the OS file-cache: the IFC file and the served
 *     viewer bundle may already sit in the kernel page cache from a prior
 *     run. That is the same caveat #3921's own qualification recorded
 *     ("Fresh Chrome processes and empty application cache; OS file cache
 *     uncontrolled") — repeated here rather than silently assumed away.
 *   - "Full readiness" (`totalWallClockMs`, everything settled: metadata +
 *     geometry + renderer) is reported SEPARATELY from "first geometry
 *     submitted" (`firstBatchWaitMs`/`firstVisibleGeometryMs`) — never
 *     collapsed into one number, per the ViewerBenchmarkMetrics shape this
 *     reuses verbatim from tests/benchmark/viewer-benchmark-page.ts.
 *
 * REPEATABILITY: samples for base and branch are INTERLEAVED (base, branch,
 * base, branch, …), so a machine that drifts mid-run drags both sides
 * equally instead of faking a delta — the same discipline as
 * scripts/perf/ab.sh for the native probe. The reporter (browser-ab-report.mjs)
 * refuses to call a delta "real" unless it clears the base side's OWN
 * round-to-round spread (the measured noise floor for that run), and flags a
 * changed `totalMeshes` fingerprint as invalidating any timing comparison.
 *
 * TWO WAYS TO USE IT:
 *   1. Real base-vs-branch: build two viewer bundles (e.g. via
 *      `browser-cold-ab.sh`, which builds `--base <ref>` in a throwaway git
 *      worktree) and pass their `dist/` directories with --dist-base/--dist-branch.
 *   2. Self-mode (repeatability check / harness self-test): omit --dist-base.
 *      Both interleaved sides serve the SAME --dist-branch build. Add
 *      --fault-inject-ms/--fault-inject-side to prove the harness notices an
 *      artificial slowdown (see the README "Verifying this harness" section).
 *
 * PRIVATE/LARGE MODELS: pass --corpus <manifest.json>, a LOCAL, UNCOMMITTED
 * file of the shape `[{"name": "...", "path": "/abs/path/to/model.ifc"}]`.
 * Nothing here fetches, generates or commits large fixtures — see
 * scripts/perf/browser-corpus.example.json for the shape and .gitignore for
 * the local-manifest exclusion.
 *
 * Usage:
 *   npx tsx scripts/perf/browser-cold-ab.mts \
 *     tests/models/ara3d/AC20-FZK-Haus.ifc \
 *     "tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc" \
 *     --dist-branch apps/viewer/dist --iters 3
 *
 *   # harness self-test: inject a 2s delay on the .wasm fetch for the
 *   # "branch" side of each interleaved pair and confirm it is flagged
 *   npx tsx scripts/perf/browser-cold-ab.mts tests/models/ara3d/AC20-FZK-Haus.ifc \
 *     --dist-branch apps/viewer/dist --iters 3 \
 *     --fault-inject-ms 2000 --fault-inject-side branch
 */

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ViewerBenchmarkPage only touches a Playwright `Page`, not the test runner,
// so it is reusable outside `playwright test` — tsx transpiles the .ts import
// the same way it transpiles this file.
import { ViewerBenchmarkPage } from '../../tests/benchmark/viewer-benchmark-page.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
}
const FLAGS_WITH_VALUE = new Set([
  '--corpus', '--iters', '--dist-base', '--dist-branch', '--port',
  '--base-label', '--branch-label', '--jsonl', '--report-json', '--results-dir',
  '--fault-inject-ms', '--fault-inject-side', '--fault-inject-pattern', '--timeout-ms',
]);
function isFlagValue(i: number): boolean {
  const prev = argv[i - 1];
  return typeof prev === 'string' && prev.startsWith('--') && FLAGS_WITH_VALUE.has(prev);
}
const fixtureArgs = argv.filter((a, i) => !a.startsWith('--') && !isFlagValue(i));

const ITERS = Number(flag('--iters') ?? '3');
const DIST_BRANCH = resolve(ROOT, flag('--dist-branch') ?? 'apps/viewer/dist');
const DIST_BASE_ARG = flag('--dist-base');
const DIST_BASE = DIST_BASE_ARG ? resolve(ROOT, DIST_BASE_ARG) : null;
// ViewerBenchmarkPage.setup() hardcodes `http://localhost:3000` (shared with
// playwright.config.ts's e2e webServer), so this must match unless that file
// changes too.
const PORT = Number(flag('--port') ?? '3000');
const BASE_LABEL = flag('--base-label') ?? (DIST_BASE ? 'base' : 'run-A');
const BRANCH_LABEL = flag('--branch-label') ?? (DIST_BASE ? 'branch' : 'run-B');
const JSONL_OUT = resolve(ROOT, flag('--jsonl') ?? 'scripts/perf/.browser-cold-ab-results/runs.jsonl');
const REPORT_JSON = flag('--report-json') ? resolve(ROOT, flag('--report-json')!) : null;
const RESULTS_DIR = resolve(ROOT, flag('--results-dir') ?? 'scripts/perf/.browser-cold-ab-results');
const FAULT_MS = Number(flag('--fault-inject-ms') ?? '0');
const FAULT_SIDE = flag('--fault-inject-side') ?? 'branch'; // 'base' | 'branch'
const FAULT_PATTERN = flag('--fault-inject-pattern') ?? '\\.wasm(\\?|$)';
const TIMEOUT_MS = Number(flag('--timeout-ms') ?? '180000');

if (!existsSync(DIST_BRANCH)) {
  console.error(`browser-cold-ab: --dist-branch not found: ${DIST_BRANCH} (build it first, e.g. \`pnpm turbo build --filter=@ifc-lite/viewer\`)`);
  process.exit(2);
}
if (DIST_BASE && !existsSync(DIST_BASE)) {
  console.error(`browser-cold-ab: --dist-base not found: ${DIST_BASE}`);
  process.exit(2);
}
if (!Number.isFinite(ITERS) || ITERS < 1) {
  console.error(`browser-cold-ab: --iters must be a positive integer (got ${flag('--iters')})`);
  process.exit(2);
}

// Fixtures: positional repo-relative/absolute paths, plus anything named in
// a --corpus manifest (private, local-only, never committed).
type Fixture = { name: string; path: string };
const fixtures: Fixture[] = [];
for (const f of fixtureArgs) {
  const p = isAbsolute(f) ? f : join(ROOT, f);
  fixtures.push({ name: p.split('/').pop()!, path: p });
}
const corpusPath = flag('--corpus');
if (corpusPath) {
  const abs = isAbsolute(corpusPath) ? corpusPath : join(ROOT, corpusPath);
  if (!existsSync(abs)) {
    console.error(`browser-cold-ab: --corpus manifest not found: ${abs}`);
    process.exit(2);
  }
  const entries = JSON.parse(readFileSync(abs, 'utf-8')) as Fixture[];
  for (const e of entries) {
    if (!existsSync(e.path)) {
      console.error(`browser-cold-ab: corpus entry missing on disk, skipping: ${e.name} -> ${e.path}`);
      continue;
    }
    fixtures.push(e);
  }
}
if (fixtures.length === 0) {
  console.error('browser-cold-ab: no fixtures. Pass fixture paths and/or --corpus <manifest.json>.');
  process.exit(2);
}

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(JSONL_OUT, ''); // truncate; this run's results only

// ---------------------------------------------------------------------------
// Minimal static server, root swappable between rounds without a restart —
// avoids running two `vite preview` processes just to alternate which build
// ViewerBenchmarkPage's hardcoded `http://localhost:PORT` navigates to.
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
let currentRoot = DIST_BRANCH;
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = join(currentRoot, rel);
  // No directory traversal outside the served root.
  if (!filePath.startsWith(currentRoot)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  const type = MIME[extname(filePath)] ?? 'application/octet-stream';
  // no-store: cross-round correctness matters far more than repeat-load speed
  // here, and each round gets a brand-new browser profile anyway.
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  createReadStream(filePath).pipe(res);
});
await new Promise<void>((resolvePort, reject) => {
  server.once('error', reject);
  server.listen(PORT, resolvePort);
});
console.log(`browser-cold-ab: serving on http://localhost:${PORT} (root swaps per side)`);

// ---------------------------------------------------------------------------
// Interleaved sampling
// ---------------------------------------------------------------------------
type Side = 'base' | 'branch';
const sides: Side[] = DIST_BASE ? ['base', 'branch'] : ['branch', 'branch'];
const labelOf = (s: Side, slot: number) => (DIST_BASE ? (s === 'base' ? BASE_LABEL : BRANCH_LABEL) : slot === 0 ? BASE_LABEL : BRANCH_LABEL);
const rootOf = (s: Side) => (s === 'base' ? DIST_BASE! : DIST_BRANCH);

let failures = 0;
let ok = 0;

for (let iter = 1; iter <= ITERS; iter++) {
  for (let slot = 0; slot < sides.length; slot++) {
    const side = sides[slot];
    const label = labelOf(side, slot);
    currentRoot = rootOf(side);
    const injectHere = FAULT_MS > 0 && FAULT_SIDE === (DIST_BASE ? side : slot === 0 ? 'base' : 'branch');

    for (const fixture of fixtures) {
      const tag = `${label}/${fixture.name}/round${iter}`;
      console.log(`browser-cold-ab: ${tag}${injectHere ? `  [fault-inject +${FAULT_MS}ms on ${FAULT_PATTERN}]` : ''}`);

      // Brand-new process per sample: no persistent context, no shared cache,
      // WASM instantiation and worker startup both start from zero.
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      let record: Record<string, unknown> = { side: label, fixture: fixture.name, round: iter, ok: false };
      try {
        if (injectHere) {
          const pattern = new RegExp(FAULT_PATTERN);
          await context.route('**/*', async (route) => {
            if (pattern.test(route.request().url())) {
              await sleep(FAULT_MS);
            }
            await route.continue();
          });
        }

        const bp = new ViewerBenchmarkPage(page);
        await bp.setup();
        const sizeMB = statSync(fixture.path).size / (1024 * 1024);
        const timeoutMs = Math.max(TIMEOUT_MS, sizeMB > 200 ? 600000 : sizeMB > 50 ? 300000 : TIMEOUT_MS);
        await bp.loadFile(fixture.path);
        await bp.waitForCompletion(timeoutMs);
        const metrics = bp.getMetrics();
        if (metrics.streamCompleteMs == null || !metrics.totalMeshes) {
          throw new Error('load did not reach streamCompleteMs / produced 0 meshes');
        }
        record = { ...record, ok: true, ...metrics };
        ok++;
        writeFileSync(join(RESULTS_DIR, `${label}-${fixture.name.replace(/[^a-zA-Z0-9]/g, '_')}-r${iter}.json`), JSON.stringify(record, null, 2));
        writeFileSync(join(RESULTS_DIR, `${label}-${fixture.name.replace(/[^a-zA-Z0-9]/g, '_')}-r${iter}.console.log`), bp.getConsoleLogs().join('\n'));
      } catch (err) {
        // Never silently retry a product failure — record it, archive
        // whatever evidence exists, and move on. A retry-until-green loop
        // is exactly the shape that hid #3975's renderer SIGILLs.
        failures++;
        const message = err instanceof Error ? err.message : String(err);
        record = { ...record, ok: false, error: message };
        const failBase = join(RESULTS_DIR, `FAILED-${label}-${fixture.name.replace(/[^a-zA-Z0-9]/g, '_')}-r${iter}-${Date.now()}`);
        try {
          await page.screenshot({ path: `${failBase}.png`, fullPage: false });
        } catch {
          /* best-effort */
        }
        try {
          const bp = new ViewerBenchmarkPage(page);
          writeFileSync(`${failBase}.console.log`, bp.getConsoleLogs().join('\n'));
        } catch {
          /* logs unavailable if setup() itself threw */
        }
        writeFileSync(`${failBase}.error.txt`, message);
        console.error(`browser-cold-ab: FAILED ${tag}: ${message} (evidence: ${failBase}.*)`);
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }

      appendFileSync(JSONL_OUT, JSON.stringify(record) + '\n');
    }
  }
}

server.close();
console.log(`browser-cold-ab: ${ok} sample(s) ok, ${failures} failed. Runs: ${JSONL_OUT}`);

// Hand off to the reporter.
const reportArgs = [join(__dirname, 'browser-ab-report.mjs'), JSONL_OUT, '--base', BASE_LABEL, '--branch', BRANCH_LABEL];
if (REPORT_JSON) reportArgs.push('--json', REPORT_JSON);
const result = spawnSync(process.execPath, reportArgs, { stdio: 'inherit' });
process.exit(failures > 0 ? 1 : (result.status ?? 0));
