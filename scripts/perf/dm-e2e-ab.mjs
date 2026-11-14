#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Interleaved base-vs-branch A/B of a REAL end-to-end server parse, for both
// `data_model_entities` variants (#9582).
//
// `rust/processing/examples/dm_peak.rs` measures `extract_data_model_with`
// alone. That is the lever, but it is not what a caller sees: a parse also
// runs geometry, symbolic extraction and two Parquet serializations beside the
// extraction, and the process's peak is the whole pipeline's. This harness
// answers the second question — it starts the actual `ifc-lite-server` binary
// built from each side, POSTs the fixture to `/api/v1/parse/parquet`, and
// measures the server process, not a library call.
//
//   node scripts/perf/dm-e2e-ab.mjs tests/models/ara3d/schependomlaan.ifc --iters 5
//   node scripts/perf/dm-e2e-ab.mjs <fixture> --iters 7 --base origin/main --json /tmp/dm-e2e.json
//
// Flags:
//   --iters <N>      interleaved rounds per side (default 5)
//   --base <ref>     git ref to treat as "before" (default: merge-base with the
//                    canonical main — see scripts/lib/canonical-main-ref.mjs).
//                    The WORKING TREE, including uncommitted edits, is "after".
//   --variants <csv> entities variants to measure (default all,rooted)
//   --json <path>    also write the machine-readable report
//   --keep-logs      keep each server's stderr log (printed path) instead of
//                    deleting it with the scratch directory
//
// How each measurement is isolated:
//   - ONE server process per (side, variant, round), under `/usr/bin/time`, so
//     its reported peak RSS belongs to exactly one parse of one variant. A
//     long-lived server measured across both variants would report one
//     high-water mark for both and could not attribute it.
//   - A FRESH CACHE_DIR per process, so no run is answered from another run's
//     cache. A cache hit skips the parse entirely and would read as a 100% win.
//   - Within a round both sides run the same variant order; which SIDE runs
//     first is balanced and randomized across rounds by ab-order.mjs (#4221),
//     because interleaving alone does not cancel a penalty tied to position.
//
// Output identity is byte identity here: the SHA-256 of the geometry Parquet
// body and of the data-model Parquet the route cached, per run. See
// dm-e2e-report.mjs for the verdict rules.
//
// Requires `/usr/bin/time` (macOS `-l`, GNU `-v`); it is the only exact peak
// RSS available for a process this script did not compile instrumentation into.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundOrder } from './ab-order.mjs';
import { formatReport, parsePeakRss, summarize } from './dm-e2e-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PROFILE = 'server-release';
const SERVER_PKG = 'ifc-lite-server';
const ROUTE = '/api/v1/parse/parquet';

function die(message, code = 2) {
  console.error(`dm-e2e-ab: ${message}`);
  process.exit(code);
}

// --- arguments ------------------------------------------------------------
// Parsed positionally rather than by index lookup: `--json x.json` and a
// fixture path are both bare words, and a lookup that cannot tell them apart
// would silently measure the report file.
const VALUE_FLAGS = new Set(['--iters', '--base', '--variants', '--json']);
const BOOL_FLAGS = new Set(['--keep-logs']);
const opts = { iters: '5', base: null, variants: 'all,rooted', json: null, 'keep-logs': false };
const fixtures = [];
let wantHelp = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '-h' || arg === '--help') { wantHelp = true; continue; }
  if (VALUE_FLAGS.has(arg)) {
    const value = process.argv[i + 1];
    if (value === undefined) die(`${arg} needs a value`);
    opts[arg.slice(2)] = value;
    i += 1;
  } else if (BOOL_FLAGS.has(arg)) {
    opts[arg.slice(2)] = true;
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg} (see --help)`);
  } else {
    fixtures.push(arg);
  }
}
// The header comment IS the help text: one place to keep correct. Take the
// first unbroken run of `//` lines, so the `// ---` section markers further
// down the file cannot leak into it.
const HELP = (() => {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('//'));
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('//'));
  return lines.slice(start, end).map((line) => line.replace(/^\/\/ ?/, '')).join('\n');
})();
if (wantHelp || fixtures.length === 0) {
  console.log(HELP);
  process.exit(fixtures.length === 0 && !wantHelp ? 2 : 0);
}
if (fixtures.length > 1) {
  // One server process per measurement already: a second fixture silently
  // doubles a run that takes minutes, so ask for it explicitly instead.
  die(`one fixture at a time (got ${fixtures.length})`);
}
const fixtureArg = fixtures[0];
const iters = Number(opts.iters);
if (!Number.isInteger(iters) || iters < 1) die(`--iters must be a positive integer (got ${opts.iters})`);
const variants = String(opts.variants).split(',').map((v) => v.trim()).filter(Boolean);
if (variants.length === 0) die('--variants needs at least one entities variant');
// A repeated variant runs twice per round and lands in one bucket, so the
// report would call `--variants all,all --iters 3` six interleaved rounds and
// drop its own under-sampling warning. Refuse it before anything is built.
const duplicated = variants.filter((v, i) => variants.indexOf(v) !== i);
if (duplicated.length > 0) die(`--variants repeats ${[...new Set(duplicated)].join(', ')}`);
const jsonOut = opts.json;
const keepLogs = opts['keep-logs'];

const fixture = isAbsolute(fixtureArg) ? fixtureArg : resolve(ROOT, fixtureArg);
let fileBytes;
try {
  fileBytes = statSync(fixture).size;
} catch {
  die(`fixture not found: ${fixtureArg} (fetch it first, e.g. \`pnpm fixtures ${fixtureArg.replace(/^tests\/models\//, '')}\`)`);
}

// `/usr/bin/time` is the measurement, so its absence is a hard stop rather
// than a silently memory-free report.
const TIME_BIN = '/usr/bin/time';
const TIME_FLAG = process.platform === 'darwin' ? '-l' : '-v';
if (spawnSync(TIME_BIN, [TIME_FLAG, 'true'], { stdio: 'ignore' }).error) {
  die(`${TIME_BIN} ${TIME_FLAG} is not usable on this host; peak RSS cannot be measured`);
}

// --- base ref -------------------------------------------------------------
const git = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();
let baseRef = opts.base;
if (!baseRef) {
  let mainRef = 'origin/main';
  try {
    mainRef = execFileSync('node', [join(ROOT, 'scripts/lib/canonical-main-ref.mjs')], { cwd: ROOT }).toString().trim() || mainRef;
  } catch { /* fall back to origin/main, the default it always was */ }
  try {
    baseRef = git('merge-base', 'HEAD', mainRef);
  } catch {
    baseRef = git('rev-parse', 'HEAD~1');
  }
}
const baseSha = git('rev-parse', '--short', baseRef);
const dirty = git('status', '--porcelain').length > 0;
const branchDesc = git('rev-parse', '--short', 'HEAD') + (dirty ? '+dirty' : '');

const scratch = mkdtempSync(join(tmpdir(), 'ifc-dm-e2e.'));
// Logs live OUTSIDE the scratch directory, because a per-measurement cache of
// a 49 MB model also lives in there: keeping the logs by keeping `scratch`
// would retain every one of those caches too.
const logDir = keepLogs ? mkdtempSync(join(tmpdir(), 'ifc-dm-e2e-logs.')) : null;
// The server of the measurement in flight, so a signal can stop it. `measure`
// clears it in its own `finally`, which `process.exit` skips.
let activeChild = null;
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  rmSync(scratch, { recursive: true, force: true });
  if (logDir) console.error(`dm-e2e-ab: server logs kept in ${logDir}`);
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // A signal sent to this process alone leaves the measurement running, and
    // `process.exit` below skips the `finally` that would stop it. Each child
    // is its own process group, so one kill takes time(1) and its server
    // together; the summary line is lost, which does not matter on an abort.
    if (activeChild) {
      try { process.kill(-activeChild.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    cleanup();
    process.exit(130);
  });
}

// --- builds ---------------------------------------------------------------
console.error(`dm-e2e-ab: base=${baseSha} (${baseRef})  branch=${branchDesc}  iters=${iters}  variants=${variants.join(',')}`);
console.error('dm-e2e-ab: building the branch server (working tree)…');
const branchBuild = spawnSync('cargo', ['build', '--profile', PROFILE, '-p', SERVER_PKG], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
if (branchBuild.status !== 0) die('building the branch server failed', 1);
const branchBin = join(process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target'), PROFILE, SERVER_PKG);

console.error(`dm-e2e-ab: building the base server @ ${baseSha} in a throwaway worktree…`);
const baseBin = join(scratch, 'ifc-lite-server-base');
const baseBuild = spawnSync('bash', [
  join(HERE, 'build-at-ref.sh'),
  '--ref', baseRef, '--out', baseBin,
  '--package', SERVER_PKG, '--bin', SERVER_PKG, '--profile', PROFILE,
  '--worktree-root', scratch,
], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
if (baseBuild.status !== 0) die('building the base server failed', 1);

// --- one measurement ------------------------------------------------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** An OS-assigned free port, released immediately before the server claims
 * it. A fixed port would collide with a previous round's lingering socket. */
const freePort = () =>
  new Promise((ok, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start one server, parse the fixture once, stop it. Returns one report row. */
async function measure(side, variant, round, bin, content) {
  const port = await freePort();
  const cacheDir = mkdtempSync(join(scratch, `cache-${side}-${variant}-${round}-`));
  const child = spawn(TIME_BIN, [TIME_FLAG, bin], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CACHE_DIR: cacheDir,
      // Logging at info level writes a line per phase and shows up in the
      // wall time; warn keeps the server's own work in the measurement.
      RUST_LOG: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the signal handler above can stop time(1) and
    // the server it started with one kill.
    detached: true,
  });
  activeChild = child;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  // `close`, not `exit`: exit can fire while the stdio pipes still hold
  // buffered data, and time(1) writes its peak-RSS summary to stderr just
  // before exiting. Reading the buffer on `exit` can miss that line, which
  // this harness treats as a failed measurement.
  const closed = new Promise((done) => child.on('close', () => done()));

  const base = `http://127.0.0.1:${port}`;
  try {
    // Readiness: poll health rather than sleeping a fixed time, so a slow
    // first start does not land inside the measured request.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`server did not become healthy in 30s\n${stderr}`);
      try {
        // A server that accepts the connection and never answers would hold
        // this await past the deadline, which is only checked between
        // attempts. The signal also aborts the body read below.
        const r = await fetch(`${base}/api/v1/health`, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (r.ok) { await r.arrayBuffer(); break; }
      } catch { /* not listening yet, or the probe hit the deadline */ }
      await sleep(50);
    }

    const form = new FormData();
    form.append('file', new Blob([content]), fixture.split('/').pop());
    const url = `${base}${ROUTE}?data_model_entities=${encodeURIComponent(variant)}`;
    const started = performance.now();
    const response = await fetch(url, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`${ROUTE} answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    const header = response.headers.get('x-ifc-metadata');
    if (!header) throw new Error('response carried no X-IFC-Metadata header');
    const meta = JSON.parse(header);
    const geometryParquet = Buffer.from(await response.arrayBuffer());
    const requestMs = performance.now() - started;

    // The data model is cached by the route, not returned inline, so output
    // identity needs this second fetch — it is the bytes #9582 changes how we
    // build, and the ONLY place a narrowing bug could show on the wire.
    const dmUrl = `${base}/api/v1/parse/data-model/${encodeURIComponent(meta.cache_key)}?data_model_entities=${encodeURIComponent(variant)}`;
    let dataModelParquet = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const r = await fetch(dmUrl);
      if (r.status === 202) { await r.arrayBuffer(); await sleep(50); continue; }
      if (!r.ok) throw new Error(`data-model fetch answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
      dataModelParquet = Buffer.from(await r.arrayBuffer());
      break;
    }
    if (!dataModelParquet) throw new Error('data model never finished filling');

    return {
      side,
      variant,
      round,
      // `stats` is what the route reports for the parse itself; `requestMs`
      // is the client-observed round trip, which also carries the upload and
      // the response write and so is never the smaller of the two.
      parseMs: meta.stats.parse_time_ms,
      geometryMs: meta.stats.geometry_time_ms,
      totalMs: meta.stats.total_time_ms,
      requestMs,
      geometryDigest: sha256(geometryParquet),
      dataModelDigest: sha256(dataModelParquet),
      geometryBytes: geometryParquet.length,
      dataModelBytes: dataModelParquet.length,
      totalEntities: meta.data_model_stats?.entity_count ?? null,
      spatialNodes: meta.data_model_stats?.spatial_node_count ?? null,
      propertySets: meta.data_model_stats?.property_set_count ?? null,
      peakRssBytes: null, // filled below, once the process has exited
    };
  } finally {
    // Signal the SERVER, not `/usr/bin/time`: killing the wrapper would take
    // the summary line with it, and the summary is the measurement. time(1)
    // prints the rusage of the child it reaped, then re-raises the signal on
    // itself, so this path still yields the peak.
    let killed = false;
    try {
      const kids = execFileSync('pgrep', ['-P', String(child.pid)]).toString().trim().split('\n').filter(Boolean);
      for (const kid of kids) { process.kill(Number(kid), 'SIGTERM'); killed = true; }
    } catch { /* already gone */ }
    if (!killed) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    const hardStop = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
    await closed;
    clearTimeout(hardStop);
    activeChild = null;
    if (logDir) writeFileSync(join(logDir, `${side}-${variant}-r${round}.log`), stderr);
    measure.lastStderr = stderr;
  }
}

// --- the run --------------------------------------------------------------
const content = readFileSync(fixture);
const order = roundOrder(iters);
const rows = [];
for (const [round, pair] of order.entries()) {
  console.error(`dm-e2e-ab: round ${round + 1}/${iters} (${pair[0]} first)`);
  for (const side of pair) {
    const bin = side === 'base' ? baseBin : branchBin;
    for (const variant of variants) {
      let row;
      try {
        row = await measure(side, variant, round + 1, bin, content);
      } catch (error) {
        die(`round ${round + 1} ${side}/${variant} failed: ${error.message}`, 1);
      }
      const peak = parsePeakRss(measure.lastStderr ?? '');
      if (peak == null) {
        die(`round ${round + 1} ${side}/${variant}: ${TIME_BIN} printed no peak RSS:\n${(measure.lastStderr ?? '').slice(-800)}`, 1);
      }
      row.peakRssBytes = peak;
      rows.push(row);
      console.error(
        `    ${side.padEnd(6)} ${variant.padEnd(6)} peak ${(peak / 1024 / 1024).toFixed(0)} MiB  total ${row.totalMs} ms  dm ${row.dataModelBytes} B`
      );
    }
  }
}

const summary = summarize(rows, { minRounds: 5 });
console.log(formatReport(summary, { base: baseSha, branch: branchDesc, fixture, fileBytes }).join('\n'));

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify({ base: baseSha, baseRef, branch: branchDesc, fixture, fileBytes, iters, variants, platform: process.platform, runs: rows, summary }, null, 2)}\n`
  );
  console.error(`dm-e2e-ab: wrote ${jsonOut}`);
}

// A failed output-identity check is a failed run, not a footnote.
process.exitCode = summary.identityBroken || summary.unstable ? 1 : 0;
