#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rebuild apps/viewer/test-durations.json from green CI runs.
 *
 *   node scripts/refresh-viewer-test-durations.mjs --run <run-id> [--run <id> ...]
 *       [--repo owner/name] [--log-cache <dir>] [--dry-run]
 *
 * For each run: reads every successful `Viewer tests (shard n)` job log (via
 * `gh`), reconstructs that shard's ordered file list exactly as the run's
 * commit selected it (its file tree and its own manifest, through
 * viewer-test-shards.mjs), and attributes the TAP timestamps to files (see
 * lib/viewer-test-durations.mjs for the method and its known biases). A
 * file's manifest value is the MEDIAN across the given runs; pass two or
 * three runs, since per-shard wall time varies by +-25% run to run on hosted
 * runners. Only files present at HEAD are written.
 *
 * A maintenance tool, run by hand when the shard loads drift apart; it gates
 * nothing. The selection it feeds is tested in viewer-test-shards.test.mjs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_MANIFEST, MANIFEST_PATH, packManifest, parseManifest, selectShard } from './viewer-test-shards.mjs';
import { attributeFiles, median, parseTapLog } from './lib/viewer-test-durations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = 'apps/viewer/';
const TEST_FILE = /^apps\/viewer\/src\/.*\.test\.tsx?$/;
const JOB_NAME = /^Viewer tests \(shard (\d+)\)$/;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parseArgs(argv) {
  const opts = { runs: [], repo: 'LTplus-AG/ifc-lite', cache: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') opts.runs.push(argv[++i]);
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--log-cache') opts.cache = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.runs.length === 0 || opts.runs.some((r) => !/^\d+$/.test(r ?? ''))) {
    throw new Error('pass at least one --run <numeric run id>');
  }
  return opts;
}

/** `sha:path` -> text for many paths, through one `git cat-file --batch`. */
function readBlobs(sha, paths) {
  const input = paths.map((p) => `${sha}:${p}\n`).join('');
  const out = spawnSync('git', ['cat-file', '--batch'], { cwd: ROOT, input, maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(`git cat-file failed: ${out.stderr}`);
  const buf = out.stdout;
  const texts = [];
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString();
    const size = Number(header.split(' ')[2]);
    if (!/ blob \d+$/.test(header)) throw new Error(`cannot read ${sha}:${p} (${header})`);
    texts.push(buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    pos = nl + 1 + size + 1;
  }
  return texts;
}

function jobLog(opts, runId, shard, jobId) {
  const cached = opts.cache && join(opts.cache, runId, `shard${shard}.log`);
  if (cached && existsSync(cached)) return readFileSync(cached, 'utf8');
  const text = run('gh', ['api', '--allow-escape-sequences', `repos/${opts.repo}/actions/jobs/${jobId}/logs`]);
  if (cached) {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, text);
  }
  return text;
}

function measureRun(opts, runId) {
  const sha = run('gh', ['api', `repos/${opts.repo}/actions/runs/${runId}`, '-q', '.head_sha']).trim();
  if (spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT }).status !== 0) {
    run('git', ['fetch', '--quiet', 'origin', sha]);
  }
  const jobs = run('gh', [
    'api', '--paginate', `repos/${opts.repo}/actions/runs/${runId}/jobs?per_page=100`,
    '-q', '.jobs[] | "\\(.id)\\t\\(.conclusion)\\t\\(.name)"',
  ]).trim().split('\n').map((l) => l.split('\t'))
    .filter(([, , name]) => JOB_NAME.test(name));
  const files = run('git', ['ls-tree', '-r', '--name-only', sha, '--', `${VIEWER}src`])
    .split('\n').filter((p) => TEST_FILE.test(p)).sort(byPath);
  const sources = new Map(readBlobs(sha, files).map((t, i) => [files[i].slice(VIEWER.length), t]));
  const relFiles = files.map((p) => p.slice(VIEWER.length));
  const manifestAtSha = spawnSync('git', ['show', `${sha}:apps/viewer/test-durations.json`], { cwd: ROOT, encoding: 'utf8' });
  const manifest = manifestAtSha.status === 0 ? parseManifest(manifestAtSha.stdout) : EMPTY_MANIFEST;

  const seconds = new Map();
  const shards = [];
  for (const [jobId, conclusion, name] of jobs) {
    const shard = Number(JOB_NAME.exec(name)[1]);
    if (conclusion !== 'success') {
      console.warn(`run ${runId} shard ${shard}: ${conclusion}, skipped`);
      continue;
    }
    const log = jobLog(opts, runId, shard, jobId);
    const count = Number(/TEST_SHARDS: '?(\d+)/.exec(log)?.[1]);
    if (!Number.isInteger(count)) throw new Error(`run ${runId} shard ${shard}: no TEST_SHARDS in log`);
    const mine = selectShard(relFiles, manifest, shard, count);
    const res = attributeFiles(mine, mine.map((f) => sources.get(f)), parseTapLog(log));
    const attributed = [...res.seconds.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(attributed - res.wall) > 1) {
      throw new Error(`run ${runId} shard ${shard}: attributed ${attributed.toFixed(1)}s of a ${res.wall.toFixed(1)}s wall`);
    }
    for (const [f, s] of res.seconds) seconds.set(f, s);
    shards.push({ shard, files: mine.length, wall: res.wall, unmatched: res.unmatched.length, silent: res.silentFiles.length });
  }
  shards.sort((a, b) => a.shard - b.shard);
  return { runId, sha, seconds, shards };
}

/** `TEST_SHARDS` of the viewer-tests job in the workflow at HEAD. */
function ciShardCount() {
  const wf = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const job = wf.slice(wf.indexOf('\n  viewer-tests:'));
  const m = /TEST_SHARDS: '(\d+)'/.exec(job);
  if (!m) throw new Error('cannot find TEST_SHARDS in the viewer-tests job of .github/workflows/test.yml');
  return Number(m[1]);
}

function summarize(walls) {
  const s = [...walls].sort((a, b) => a - b);
  return `min ${s[0].toFixed(0)}s, median ${median(s).toFixed(0)}s, max ${s[s.length - 1].toFixed(0)}s`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const measured = opts.runs.map((r) => measureRun(opts, r));
  for (const m of measured) {
    console.log(`run ${m.runId} @ ${m.sha.slice(0, 10)}: test-step wall ${summarize(m.shards.map((s) => s.wall))}`);
    for (const s of m.shards) {
      console.log(`  shard ${String(s.shard).padStart(2)}: ${s.files} files, ${s.wall.toFixed(0)}s, ` +
        `${s.unmatched} unmatched titles, ${s.silent} files without a matched result`);
    }
  }
  const head = new Set(run('git', ['ls-files', '--', `${VIEWER}src`]).split('\n')
    .filter((p) => TEST_FILE.test(p)).map((p) => p.slice(VIEWER.length)));
  const perFile = new Map();
  for (const m of measured) {
    for (const [f, s] of m.seconds) if (head.has(f)) perFile.set(f, [...(perFile.get(f) ?? []), s]);
  }
  const seconds = {};
  for (const f of [...perFile.keys()].sort(byPath)) seconds[f] = Math.round(median(perFile.get(f)) * 10) / 10;
  // Packed for the shard count CI runs at HEAD; another count ignores it.
  const count = ciShardCount();
  const manifest = { shards: count, seconds };
  const packed = packManifest(seconds, count);
  for (const m of measured) {
    const load = new Array(count).fill(0);
    for (const [f, s] of m.seconds) if (packed.has(f)) load[packed.get(f)] += s;
    console.log(`run ${m.runId} re-packed with the new manifest (in-sample): ${summarize(load)}`);
  }
  const n = Object.keys(seconds).length;
  console.log(`${n} files measured; ${head.size - n} at HEAD unmeasured (hash fallback); packed for ${count} shards`);
  if (!opts.dryRun) {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${MANIFEST_PATH}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`refresh-viewer-test-durations: ${err.message}`);
  process.exit(1);
}
