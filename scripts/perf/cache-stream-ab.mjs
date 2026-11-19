#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Paired peak-RSS run for the native `.ifclite` cache (#9584): three writers,
// one format, interleaved per model, with the outputs hashed.
//
//   node scripts/perf/cache-stream-ab.mjs --base <merge-base> --head <head> --iters 5
//   node scripts/perf/cache-stream-ab.mjs --base ee77162e --head e8bd18ee \
//     --models "ara3d/AC20-FZK-Haus.ifc" --iters 3 --json /tmp/cache-rss.json
//
// Flags:
//   --base <ref>      the baseline ref (default: merge-base of --head with
//                     the canonical main). Measured with its OWN in-memory
//                     writer, built from that ref.
//   --head <ref>      the ref under acceptance (default HEAD)
//   --models <csv>    catalogued fixture paths, relative to tests/models
//                     (default: the two large cases and a small control)
//   --iters <N>       interleaved rounds per variant (default 5)
//   --threads <N>     RAYON_NUM_THREADS for every build (default: this host's
//                     logical CPU count). Pinned explicitly on both sides,
//                     because a fleet worker exports its reservation's count
//                     and an inherited value would differ between operators.
//   --profile <name>  cargo profile (default release)
//   --seed <N>        deterministic within-round ordering, for replay
//   --target-dir <d>  CARGO_TARGET_DIR shared by both builds (default: a
//                     scratch one; a warm shared directory saves ~10 minutes)
//   --json <path>     write the machine-readable report
//   --no-fetch        never download a missing fixture; fail instead
//   --no-warmup       skip the discarded first build of each variant
//   --keep-outputs    keep the written caches (they are large) for inspection
//
// WHY THREE VARIANTS: see cache-stream-report.mjs. Briefly — without the
// head's in-memory control, everything the branch changed is credited to the
// streaming writer.
//
// WHAT MAKES A RUN ADMISSIBLE, and what this script enforces rather than
// assumes:
//   - Both binaries are built from the named refs in throwaway worktrees
//     (build-at-ref.sh), never from the working tree, so an uncommitted edit
//     cannot reach a measurement.
//   - Both refs must pin the SAME toolchain; a differing rust-toolchain.toml
//     stops the run, because the comparison would then be of two compilers.
//   - Every fixture is hashed on disk and checked against the catalog
//     (tests/models/manifest.json). A fixture that is not the catalogued one
//     stops the run.
//   - Peak RSS comes from `/usr/bin/time` (macOS `-l`, GNU `-v`), the only
//     exact peak available for a process this script did not instrument. A
//     run whose summary carries no peak is a FAILED measurement, not a zero.
//   - Each round runs the three variants in a balanced, shuffled order, and
//     each writes to a fresh output path that is hashed and then deleted.
//
// Host load is recorded around every measurement but NOT gated on: whether
// the host was quiet enough is the admitting operator's call, and the numbers
// they need to make it are in the report.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, totalmem, tmpdir, release as osRelease } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { seededRand } from './ab-order.mjs';
import { VARIANT_KEYS, formatReport, parsePeakRss, summarize, variantOrder } from './cache-stream-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PACKAGE = 'ifc-lite-cache';
const DEFAULT_MODELS = [
  'various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc',
  'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
  'ara3d/AC20-FZK-Haus.ifc',
];

const die = (message, code = 2) => {
  console.error(`cache-stream-ab: ${message}`);
  process.exit(code);
};

// --- arguments ------------------------------------------------------------
const VALUE_FLAGS = new Set(['--base', '--head', '--models', '--iters', '--threads', '--profile', '--seed', '--target-dir', '--json']);
const BOOL_FLAGS = new Set(['--no-fetch', '--no-warmup', '--keep-outputs']);
const opts = {
  base: null, head: 'HEAD', models: DEFAULT_MODELS.join(','), iters: '5',
  threads: String(availableParallelism()), profile: 'release', seed: null,
  'target-dir': null, json: null, 'no-fetch': false, 'no-warmup': false, 'keep-outputs': false,
};
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
  } else {
    die(`unexpected argument ${arg} (see --help)`);
  }
}
if (wantHelp) {
  // The header comment IS the help text: one place to keep correct.
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('//'));
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('//'));
  console.log(lines.slice(start, end).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const iters = Number(opts.iters);
if (!Number.isInteger(iters) || iters < 1) die(`--iters must be a positive integer (got ${opts.iters})`);
const threads = Number(opts.threads);
if (!Number.isInteger(threads) || threads < 1) die(`--threads must be a positive integer (got ${opts.threads})`);
const models = String(opts.models).split(',').map((m) => m.trim()).filter(Boolean);
if (models.length === 0) die('--models needs at least one catalogued fixture path');
const rand = opts.seed == null ? Math.random : seededRand(Number(opts.seed));

// --- host capability ------------------------------------------------------
const TIME_BIN = '/usr/bin/time';
const TIME_FLAG = process.platform === 'darwin' ? '-l' : '-v';
if (spawnSync(TIME_BIN, [TIME_FLAG, 'true'], { stdio: 'ignore' }).error) {
  die(`${TIME_BIN} ${TIME_FLAG} is not usable on this host; peak RSS cannot be measured`);
}

// --- refs -----------------------------------------------------------------
const git = (...args) => execFileSync('git', args, { cwd: ROOT }).toString().trim();
const resolveRef = (ref, what) => {
  try {
    return git('rev-parse', `${ref}^{commit}`);
  } catch {
    return die(`${what} ref ${ref} is not in this clone — fetch the PR branch first (git fetch upstream 'refs/pull/*/head:refs/remotes/pr/*')`);
  }
};
const headSha = resolveRef(opts.head, 'head');
let baseRef = opts.base;
if (!baseRef) {
  let mainRef = 'origin/main';
  try {
    mainRef = execFileSync('node', [join(ROOT, 'scripts/lib/canonical-main-ref.mjs')], { cwd: ROOT }).toString().trim() || mainRef;
  } catch { /* fall back to origin/main */ }
  try {
    baseRef = git('merge-base', headSha, mainRef);
  } catch {
    die('could not derive the merge base; pass --base explicitly');
  }
}
const baseSha = resolveRef(baseRef, 'base');
if (baseSha === headSha) die('--base and --head resolve to the same commit; there is nothing to pair');
try {
  git('merge-base', '--is-ancestor', baseSha, headSha);
} catch {
  console.error(`cache-stream-ab: WARNING ${baseSha.slice(0, 9)} is not an ancestor of ${headSha.slice(0, 9)}; this is not a merge-base pairing.`);
}
// Two refs pinning different toolchains compare two compilers, not two
// writers. Stop rather than report the difference as the branch's.
const pinnedAt = (ref) => {
  try { return git('show', `${ref}:rust-toolchain.toml`); } catch { return null; }
};
const basePin = pinnedAt(baseSha);
if (basePin !== pinnedAt(headSha)) die('the base and head pin different toolchains (rust-toolchain.toml differs); this pairing is not like-for-like');
const toolchainPinned = /channel\s*=\s*"([^"]+)"/.exec(basePin ?? '')?.[1] ?? null;
const rustc = (() => {
  try { return execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return null; }
})();

// --- fixtures -------------------------------------------------------------
const MODELS_DIR = join(ROOT, 'tests/models');
const manifest = JSON.parse(readFileSync(join(MODELS_DIR, 'manifest.json'), 'utf8'));
const sha256File = async (path) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};
const fixtures = [];
for (const rel of models) {
  const entry = manifest.files.find((f) => f.path === rel);
  // An uncatalogued fixture has no checksum, so no later reader can confirm
  // which bytes were measured. That is not an admissible input.
  if (!entry) die(`${rel} is not in tests/models/manifest.json; an uncatalogued fixture cannot be checksummed`);
  const path = join(MODELS_DIR, rel);
  let present = false;
  try { present = statSync(path).isFile(); } catch { present = false; }
  if (!present) {
    if (opts['no-fetch']) die(`${rel} is missing and --no-fetch was given`);
    console.error(`cache-stream-ab: fetching ${rel} (${(entry.size / 1e6).toFixed(0)} MB)…`);
    const fetched = spawnSync('node', [join(ROOT, 'scripts/fixtures/fetch-fixtures.mjs'), rel], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    if (fetched.status !== 0) die(`fetching ${rel} failed`, 1);
  }
  const sha256 = await sha256File(path);
  if (sha256 !== entry.sha256) die(`${rel} on disk hashes ${sha256.slice(0, 12)}… but the catalog says ${entry.sha256.slice(0, 12)}…`);
  fixtures.push({ path: rel, absolute: path, sizeBytes: statSync(path).size, sha256, manifestSha256: entry.sha256, matchesManifest: true });
}

// --- builds ---------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'ifc-cache-rss.'));
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  rmSync(scratch, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}
const targetDir = opts['target-dir'] ? resolve(opts['target-dir']) : join(scratch, 'target');
// OUTSIDE the scratch directory: a failed build exits through `die`, which
// runs the cleanup that would otherwise delete the log it just told you to
// read.
const buildLog = join(tmpdir(), `ifc-cache-rss-build-${process.pid}.log`);
const build = ({ ref, out, example, bin }) => {
  const args = [join(HERE, 'build-at-ref.sh'), '--ref', ref, '--out', out, '--package', PACKAGE,
    '--profile', opts.profile, '--worktree-root', scratch, '--target-dir', targetDir, '--log', buildLog];
  args.push(...(bin ? ['--bin', bin] : ['--example', example]));
  const what = bin ? `bin ${bin}` : `example ${example}`;
  console.error(`cache-stream-ab: building ${what} @ ${ref.slice(0, 9)} (log ${buildLog})…`);
  const run = spawnSync('bash', args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (run.status !== 0) die(`building ${what} @ ${ref.slice(0, 9)} failed; see ${buildLog}`, 1);
  return out;
};
const BINARIES = {
  'base-inmem': build({ ref: baseSha, out: join(scratch, 'conformance_writer-base'), example: 'conformance_writer' }),
  'head-inmem': build({ ref: headSha, out: join(scratch, 'conformance_writer-head'), example: 'conformance_writer' }),
  'head-streamed': build({ ref: headSha, out: join(scratch, 'ifc-build-cache-head'), bin: 'ifc-build-cache' }),
};

// --- one measurement ------------------------------------------------------
// Kept outputs live OUTSIDE the scratch directory, which is removed on exit:
// a cache of a 327 MB model is large enough that "kept" has to mean kept.
const outDir = opts['keep-outputs'] ? mkdtempSync(join(tmpdir(), 'ifc-cache-rss-out.')) : join(scratch, 'out');
mkdirSync(outDir, { recursive: true });
const loads = [];
const env = { ...process.env, RAYON_NUM_THREADS: String(threads) };

async function measure({ model, variant, round, input }) {
  const out = join(outDir, `${variant}-r${round}.ifclite`);
  const loadBefore = loadavg()[0];
  loads.push(loadBefore);
  const started = performance.now();
  const child = spawnSync(TIME_BIN, [TIME_FLAG, BINARIES[variant], input, out], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  const elapsedMs = performance.now() - started;
  const row = { model, variant, round, loadBefore, elapsedMs, status: 'ok' };
  const fail = (error) => ({ ...row, status: 'failed', error });
  if (child.error) return fail(`${child.error.message}`);
  if (child.status !== 0) return fail(`exit ${child.status}: ${(child.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 400)}`);
  // A missing peak is a failed MEASUREMENT: reporting the run without it
  // would put a build with no memory number into a memory verdict.
  const peakRssBytes = parsePeakRss(child.stderr ?? '');
  if (peakRssBytes == null) return fail(`${TIME_BIN} printed no peak RSS: ${(child.stderr ?? '').trim().slice(-200)}`);
  let stats = null;
  try { stats = JSON.parse((child.stdout ?? '').trim().split('\n').pop()); } catch { return fail(`stats were not JSON: ${(child.stdout ?? '').slice(0, 200)}`); }
  let outputSha256;
  let outputBytes;
  try {
    outputBytes = statSync(out).size;
    outputSha256 = await sha256File(out);
  } catch (error) {
    return fail(`the build wrote no readable output: ${error.message}`);
  }
  if (!opts['keep-outputs']) unlinkSync(out);
  return { ...row, peakRssBytes, outputSha256, outputBytes, stats };
}

// --- the run --------------------------------------------------------------
const startedAt = new Date().toISOString();
console.error(
  `cache-stream-ab: base=${baseSha.slice(0, 9)} head=${headSha.slice(0, 9)} profile=${opts.profile} ` +
  `threads=${threads} iters=${iters} models=${fixtures.length}`
);
const rows = [];
for (const fixture of fixtures) {
  console.error(`\ncache-stream-ab: ${fixture.path} (${(fixture.sizeBytes / 1e6).toFixed(0)} MB)`);
  if (!opts['no-warmup']) {
    // Each variant, not just one: the first build of a model pays the cold
    // read of its source, and each BINARY separately pays its own first
    // exec. A smoke run on the 2.5 MB control measured 0.4 s for the first
    // round of a variant against 0.0 s for its second — a penalty that lands
    // entirely inside round 1 and that balanced ordering cannot split.
    console.error('    warm-up (discarded)…');
    for (const variant of VARIANT_KEYS) {
      await measure({ model: fixture.path, variant, round: 0, input: fixture.absolute });
    }
  }
  for (const [index, order] of variantOrder(iters, VARIANT_KEYS, rand).entries()) {
    const round = index + 1;
    console.error(`    round ${round}/${iters} (${order.join(' → ')})`);
    for (const variant of order) {
      const row = await measure({ model: fixture.path, variant, round, input: fixture.absolute });
      rows.push(row);
      console.error(
        row.status === 'ok'
          ? `      ${variant.padEnd(14)} peak ${(row.peakRssBytes / 1024 / 1024).toFixed(0).padStart(6)} MiB  ${(row.elapsedMs / 1000).toFixed(1).padStart(6)} s  sha ${row.outputSha256.slice(0, 12)}  load ${row.loadBefore.toFixed(1)}`
          : `      ${variant.padEnd(14)} FAILED: ${row.error}`
      );
    }
  }
}

const summary = summarize(rows, { minRounds: 5 });
const provenance = {
  baseSha, headSha, profile: opts.profile, threads, iters, seed: opts.seed,
  toolchain: rustc, toolchainPinned, fixtures,
  host: `${process.platform} ${osRelease()}, ${cpus()[0]?.model ?? 'unknown CPU'} × ${cpus().length}, ${(totalmem() / 1024 ** 3).toFixed(0)} GiB`,
  loadavg: loads.length ? `${Math.min(...loads).toFixed(1)} – ${Math.max(...loads).toFixed(1)}` : null,
  startedAt, finishedAt: new Date().toISOString(),
};
console.log(formatReport(summary, provenance).join('\n'));

if (opts.json) {
  const path = isAbsolute(opts.json) ? opts.json : resolve(opts.json);
  writeFileSync(path, `${JSON.stringify({ provenance, runs: rows, summary }, null, 2)}\n`);
  console.error(`cache-stream-ab: wrote ${path}`);
}
if (opts['keep-outputs']) console.error(`cache-stream-ab: outputs kept in ${outDir} — delete it yourself, it holds one cache per run`);

// A broken identity, a non-deterministic writer or a variant that never ran
// is a failed run, not a footnote on a memory table.
process.exitCode = summary.identityBroken || summary.unstable || summary.incomplete ? 1 : 0;
