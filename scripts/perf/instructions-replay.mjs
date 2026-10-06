#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Ledger replay for instruction counts (#6958): do instruction-count deltas
// predict the end-to-end verdicts the lever ledger recorded?
//
// For every candidate in the candidates file, both sides (the commit before
// and the commit after a shipped change, or a base and the base plus a
// rejected patch) are built in throwaway worktrees by build-at-ref.sh with
// rust/processing/examples/instructions_driver.rs injected, then each fixture
// is run once under callgrind. The driver dumps around one process_geometry
// call, so each count is one whole processing call, single-threaded. Old
// commits have no phase markers; this replay compares whole calls only.
//
//   node scripts/perf/instructions-replay.mjs --candidates <file> --out <results.json> \
//     [--work <dir>] [--only <id>]... [--jobs N] [--runs N]
//   node scripts/perf/instructions-replay.mjs --report <results.json> [--candidates <file>] [--write]
//
// --report re-derives every verdict and the table from recorded measurements
// without building anything; with --candidates the expectations and claims
// come from that file, and --write stores the re-judged verdicts.
//
// Candidate shape: { id, title, class: "win" | "dead-end" | "scheduling",
//   ledger: "<end-to-end verdict as recorded>", expect: "fewer" | "more" | "flat",
//   before: { ref, patch? }, after: { ref, patch? }, fixtures: [path...],
//   claims?: [path...] }   (fixtures the ledger verdict covers; default all)
// `patch` is a file path or `<commit>:<path>` (applied with --unidiff-zero).
//
// `expect` is the direction the ledger's END-TO-END verdict implies for work:
// a win should retire fewer instructions, a net-loss dead end more, and a
// pure scheduling change none (it moves work between threads, not amounts).
// A side that cannot be built at its ref is recorded as such, never filled in.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DRIVER = join(ROOT, 'rust/processing/examples/instructions_driver.rs');
const DRIVER_REL = 'rust/processing/examples/instructions_driver.rs';

/**
 * The smallest relative change ever read as a direction. Today's code repeats
 * to ~1e-6 (std HashMap per-process hash seeds), but historical binaries
 * repeat only to ~1e-3: their glibc malloc path lengths (_int_malloc,
 * unlink_chunk) vary run to run. So every side is run several times and the
 * flat band is widened to the measured spread of the two sides.
 */
export const FLAT_THRESHOLD = 1e-4;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Relative run-to-run spread of one side ((max - min) / median); 0 for one run. */
export function spread(side) {
  const runs = side.runs ?? [side.ir];
  return (Math.max(...runs) - Math.min(...runs)) / median(runs);
}

/** Direction of a before -> after change in instruction count. */
export function direction(before, after, threshold = FLAT_THRESHOLD) {
  const rel = (after - before) / before;
  if (Math.abs(rel) <= threshold) return 'flat';
  return rel < 0 ? 'fewer' : 'more';
}

/**
 * Verdict for one candidate x fixture: does the count direction agree with
 * the ledger's end-to-end direction? A delta inside the two sides' combined
 * spread is flat. Unmeasurable sides stay unmeasured.
 */
export function judge(candidate, measurement) {
  const { before, after } = measurement;
  if (!before?.ir || !after?.ir) {
    return { verdict: 'not-replayed', reason: before?.error ?? after?.error ?? 'missing measurement' };
  }
  const relDelta = (after.ir - before.ir) / before.ir;
  const noise = Math.max(FLAT_THRESHOLD, spread(before) + spread(after));
  const observed = direction(before.ir, after.ir, noise);
  const outputChanged = ['meshes', 'vertices', 'triangles'].some((k) => before[k] !== after[k]);
  // A fixture outside the ledger's claim is context: its count is shown, but
  // the ledger said nothing about it to agree or disagree with.
  const claimed = !candidate.claims || candidate.claims.includes(measurement.fixture);
  return {
    verdict: !claimed ? 'no-ledger-claim' : observed === candidate.expect ? 'tracks' : 'does-not-track',
    observed,
    relDelta,
    noise,
    outputChanged,
  };
}

/**
 * Re-derive every verdict in a results document. With `definitions` (the
 * candidates file), each candidate's expectation and claims come from there,
 * so a corrected expectation re-judges recorded counts without re-measuring.
 */
export function judgeAll(results, definitions) {
  return results.candidates.map((recorded) => {
    const c = { ...recorded, ...(definitions?.find((d) => d.id === recorded.id) ?? {}), fixtures: recorded.fixtures };
    return { ...c, fixtures: c.fixtures.map((f) => ({ ...f, ...judge(c, f) })) };
  });
}

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)}%`;
const big = (n) => (n === undefined ? '-' : (n / 1e6).toFixed(1) + 'M');

export function formatTable(judged) {
  const lines = [
    '| candidate | class | fixture | before Ir | after Ir | delta | flat band | expected | observed | verdict |',
    '|---|---|---|---:|---:|---:|---:|---|---|---|',
  ];
  for (const c of judged) {
    for (const f of c.fixtures) {
      const name = basename(f.fixture).replace(/\.ifc$/, '').slice(0, 24);
      if (f.verdict === 'no-ledger-claim') {
        lines.push(`| ${c.id} | ${c.class} | ${name} | ${big(f.before.ir)} | ${big(f.after.ir)} | ${pct(f.relDelta)} | ±${(f.noise * 100).toFixed(3)}% | - | ${f.observed} | no ledger claim${f.outputChanged ? ' (output counts changed)' : ''} |`);
        continue;
      }
      if (f.verdict === 'not-replayed') {
        lines.push(`| ${c.id} | ${c.class} | ${name} | - | - | - | - | ${c.expect} | - | not replayed: ${f.reason} |`);
        continue;
      }
      const note = f.outputChanged ? ' (output counts changed)' : '';
      lines.push(`| ${c.id} | ${c.class} | ${name} | ${big(f.before.ir)} | ${big(f.after.ir)} | ${pct(f.relDelta)} | ±${(f.noise * 100).toFixed(3)}% | ${c.expect} | ${f.observed} | ${f.verdict}${note} |`);
    }
  }
  return lines.join('\n');
}

// --- measurement ------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

const tail = (text, n = 12) => text.trim().split('\n').slice(-n).join('\n');

/**
 * A patch is a repo path, or `<commit>:<path>` for one kept only in history
 * (the rejected candidates live in evidence commits, not on main).
 */
function patchText(patch) {
  const local = resolve(ROOT, patch);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  const r = spawnSync('git', ['show', patch], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`cannot read patch ${patch}`);
  return r.stdout;
}

/** Build the driver for one side (ref + optional patch); cached by identity. */
async function buildSide(side, work) {
  const patch = side.patch ? patchText(side.patch) : '';
  const key = createHash('sha256').update(side.ref).update(patch).digest('hex').slice(0, 16);
  const bin = join(work, 'bin', `driver-${key}`);
  const log = join(work, 'logs', `build-${key}.log`);
  if (existsSync(bin)) return { bin };
  mkdirSync(dirname(log), { recursive: true });
  const args = ['--ref', side.ref, '--out', bin, '--example', 'instructions_driver',
    '--inject', `${DRIVER}=${DRIVER_REL}`, '--target-dir', join(work, 'target'),
    '--worktree-root', join(work, 'worktrees'), '--log', log];
  if (side.patch) {
    const patchFile = join(work, 'patches', `${key}.patch`);
    mkdirSync(dirname(patchFile), { recursive: true });
    writeFileSync(patchFile, patch);
    args.push('--patch', patchFile);
  }
  console.error(`replay: building ${side.ref}${side.patch ? ` + ${basename(side.patch)}` : ''} ...`);
  const r = await run(join(HERE, 'build-at-ref.sh'), args, { cwd: ROOT });
  if (r.status !== 0) {
    const text = existsSync(log) ? readFileSync(log, 'utf8') : r.stderr;
    return { error: `build failed at ${side.ref}`, log: tail(text) };
  }
  return { bin };
}

/** One callgrind run of the driver: Ir of the measured call + output counts. */
async function measure(bin, fixture) {
  const dir = mkdtempSync(join(dirname(bin), 'cg-'));
  try {
    const r = await run('valgrind', ['--tool=callgrind', `--callgrind-out-file=${join(dir, 'cg.out')}`,
      '--dump-before=*::measured_pipeline', '--dump-after=*::measured_pipeline',
      '--dump-instr=no', '--dump-line=no', bin, fixture], { cwd: ROOT });
    if (r.status !== 0) return { error: `driver exited ${r.status}`, log: tail(r.stderr) };
    const after = readdirSync(dir).map((n) => readFileSync(join(dir, n), 'utf8'))
      .find((t) => /^desc: Trigger: --dump-after=.*measured_pipeline$/m.test(t));
    const ir = Number(after?.match(/^summary:\s*(\d+)/m)?.[1]);
    if (!Number.isSafeInteger(ir)) return { error: 'no --dump-after dump (driver symbol missing?)' };
    return { ir, ...JSON.parse(r.stdout.trim().split('\n').at(-1)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A counting semaphore: at most `jobs` callgrind runs at once. */
function limiter(jobs) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= jobs) await new Promise((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

async function replay({ candidatesPath, outPath, work, only, jobs, runs }) {
  const candidates = JSON.parse(readFileSync(candidatesPath, 'utf8')).candidates
    .filter((c) => only.length === 0 || only.includes(c.id));
  mkdirSync(work, { recursive: true });
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const valgrind = spawnSync('valgrind', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const results = { tool: 'scripts/perf/instructions-replay.mjs', harnessCommit: commit, valgrind, runsPerSide: runs, flatThreshold: FLAT_THRESHOLD, candidates: [] };
  const limit = limiter(jobs);
  const pending = [];
  // Builds are sequential (one shared target dir); each candidate's runs start
  // as soon as both its sides are built, overlapping the next builds.
  for (const c of candidates) {
    const sides = {};
    for (const s of ['before', 'after']) sides[s] = await buildSide(c[s], work);
    const measureSide = async (fixture, s) => {
      if (!sides[s].bin) return sides[s];
      const each = await Promise.all(Array.from({ length: runs }, () => limit(() => measure(sides[s].bin, resolve(ROOT, fixture)))));
      const failed = each.find((m) => m.error);
      if (failed) return failed;
      const counts = ['meshes', 'vertices', 'triangles'];
      if (each.some((m) => counts.some((k) => m[k] !== each[0][k]))) return { error: 'output counts differ between runs of one binary' };
      return { ir: median(each.map((m) => m.ir)), runs: each.map((m) => m.ir), ...Object.fromEntries(counts.map((k) => [k, each[0][k]])) };
    };
    pending.push((async () => {
      const fixtures = await Promise.all(c.fixtures.map(async (fixture) => {
        const [before, after] = await Promise.all([measureSide(fixture, 'before'), measureSide(fixture, 'after')]);
        return { fixture, before, after };
      }));
      const done = { ...c, fixtures };
      console.error(formatTable(judgeAll({ candidates: [done] })));
      return done;
    })());
  }
  results.candidates = await Promise.all(pending);
  writeFileSync(outPath, JSON.stringify({ ...results, candidates: judgeAll(results) }, null, 2) + '\n');
  return results;
}

async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const reportPath = opt('--report');
  if (reportPath) {
    const definitions = opt('--candidates') && JSON.parse(readFileSync(opt('--candidates'), 'utf8')).candidates;
    const judged = judgeAll(JSON.parse(readFileSync(reportPath, 'utf8')), definitions);
    if (argv.includes('--write')) {
      const doc = JSON.parse(readFileSync(reportPath, 'utf8'));
      writeFileSync(reportPath, JSON.stringify({ ...doc, candidates: judged }, null, 2) + '\n');
    }
    console.log(formatTable(judged));
    return exitCodeFor(judged);
  }
  const candidatesPath = opt('--candidates');
  const outPath = opt('--out');
  if (!candidatesPath || !outPath) {
    console.error('usage: instructions-replay.mjs --candidates <file> --out <results.json> [--work <dir>] [--only <id>]... [--jobs N] [--runs N]\n       instructions-replay.mjs --report <results.json> [--candidates <file>] [--write]');
    return 2;
  }
  const only = argv.flatMap((a, i) => (a === '--only' ? [argv[i + 1]] : []));
  const work = resolve(opt('--work') ?? join(process.env.TMPDIR ?? '/tmp', 'ifc-instructions-replay'));
  const jobs = positiveInt(opt('--jobs') ?? '4', '--jobs');
  const runs = positiveInt(opt('--runs') ?? '3', '--runs');
  if (jobs === null || runs === null) return 2;
  const results = await replay({ candidatesPath, outPath: resolve(outPath), work, only, jobs, runs });
  const judged = judgeAll(results);
  console.log(formatTable(judged));
  return exitCodeFor(judged);
}

/** `--jobs`/`--runs` must be positive integers: 0 would hang the limiter, NaN would empty the runs. */
function positiveInt(raw, flag) {
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  console.error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  return null;
}

/**
 * A replay that could not measure something must not read as success: exit 3
 * when any fixture is `not-replayed` (build or valgrind failure). A measured
 * `does-not-track` is a verdict, not a tool failure, so it still exits 0.
 */
export function exitCodeFor(judged) {
  const fixtures = judged.flatMap((c) => c.fixtures ?? []);
  return fixtures.some((f) => f.verdict === 'not-replayed') ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
