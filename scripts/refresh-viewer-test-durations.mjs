#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rebuild apps/viewer/test-durations.json from green CI runs.
 *
 *   node scripts/refresh-viewer-test-durations.mjs [--run <serial-id> ...]
 *       [--concurrent-run <id> ...] [--repo owner/name] [--log-cache <dir>] [--dry-run]
 *
 * Serial runs use the TAP timestamps and the run commit's file list and
 * manifest. Concurrent runs use the per-file timing artifacts. Use two or
 * three complete runs per mode and refresh either table or both. Only
 * files present at HEAD are written.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_MANIFEST, MANIFEST_PATH, packManifest, parseManifest, selectShard } from './viewer-test-shards.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { attributeFiles, median, parseTapLog } from './lib/viewer-test-durations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = 'apps/viewer/';
const TEST_FILE = /^apps\/viewer\/src\/.*\.test\.tsx?$/;
const JOB_NAME = /^Viewer tests \(shard (\d+)\)$/;
const CONCURRENCY_TWO = /^.*Z +VIEWER_TEST_CONCURRENCY: '?2'?\s*$/m;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parseArgs(argv) {
  const opts = { runs: [], concurrentRuns: [], repo: 'LTplus-AG/ifc-lite', cache: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') opts.runs.push(argv[++i]);
    else if (a === '--concurrent-run') opts.concurrentRuns.push(argv[++i]);
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--log-cache') opts.cache = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const ids = [...opts.runs, ...opts.concurrentRuns];
  if (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id ?? ''))) {
    throw new Error('pass at least one --run or --concurrent-run with a numeric run ID');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('provide each run ID only once');
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

function runInventory(opts, runId) {
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
  return { sha, jobs, files };
}

function measureSerialRun(opts, runId) {
  const { sha, jobs, files } = runInventory(opts, runId);
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
    if (CONCURRENCY_TWO.test(log)) {
      throw new Error(`run ${runId} shard ${shard}: serial TAP attribution requires concurrency 1`);
    }
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

/**
 * Read one artifact per shard and verify that each file in the run's
 * inventory appears exactly once with a usable duration.
 */
function readConcurrentTimings(directory, shardIds, expectedFiles) {
  const expected = new Set(expectedFiles);
  const seconds = new Map();
  for (const shard of shardIds) {
    const path = join(directory, `viewer-file-timings-${shard}`, 'viewer-test-file-durations.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
      throw new Error(`shard ${shard}: expected a non-empty file-duration object`);
    }
    for (const [file, duration] of Object.entries(data)) {
      if (!expected.has(file)) throw new Error(`shard ${shard}: unexpected file ${file}`);
      if (seconds.has(file)) throw new Error(`shard ${shard}: duplicate file ${file}`);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`shard ${shard}: invalid duration for ${file}`);
      seconds.set(file, duration);
    }
  }
  if (seconds.size !== expected.size) {
    const missing = [...expected].find((file) => !seconds.has(file));
    throw new Error(`recorded ${seconds.size}/${expected.size} files; missing ${missing}`);
  }
  return seconds;
}

function measureConcurrentRun(opts, runId) {
  const { sha, jobs, files } = runInventory(opts, runId);
  const shardIds = jobs.map(([jobId, conclusion, name]) => {
    const shard = Number(JOB_NAME.exec(name)[1]);
    if (conclusion !== 'success') throw new Error(`run ${runId} shard ${shard}: ${conclusion}`);
    if (!CONCURRENCY_TWO.test(jobLog(opts, runId, shard, jobId))) {
      throw new Error(`run ${runId} shard ${shard}: expected VIEWER_TEST_CONCURRENCY=2`);
    }
    return shard;
  });
  if (shardIds.length === 0) throw new Error(`run ${runId}: no viewer shard jobs`);
  const directory = mkdtempSync(join(tmpdir(), 'viewer-file-timings-'));
  try {
    run('gh', ['run', 'download', runId, '--repo', opts.repo, '--pattern', 'viewer-file-timings-*', '--dir', directory]);
    const seconds = readConcurrentTimings(directory, shardIds, files.map((file) => file.slice(VIEWER.length)));
    console.log(`run ${runId} @ ${sha.slice(0, 10)}: measured ${seconds.size} concurrent files in ${shardIds.length} shards`);
    return { seconds };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function refreshedWeights(measured, head, roundDuration) {
  const perFile = new Map();
  for (const m of measured) {
    for (const [file, duration] of m.seconds) {
      if (head.has(file)) perFile.set(file, [...(perFile.get(file) ?? []), duration]);
    }
  }
  return Object.fromEntries([...perFile.keys()].sort(byPath).map((file) => [
    file, roundDuration(median(perFile.get(file))),
  ]));
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
  const measured = opts.runs.map((r) => measureSerialRun(opts, r));
  const concurrent = opts.concurrentRuns.map((r) => measureConcurrentRun(opts, r));
  for (const m of measured) {
    console.log(`run ${m.runId} @ ${m.sha.slice(0, 10)}: test-step wall ${summarize(m.shards.map((s) => s.wall))}`);
    for (const s of m.shards) {
      console.log(`  shard ${String(s.shard).padStart(2)}: ${s.files} files, ${s.wall.toFixed(0)}s, ` +
        `${s.unmatched} unmatched titles, ${s.silent} files without a matched result`);
    }
  }
  const head = new Set(run('git', ['ls-files', '--', `${VIEWER}src`]).split('\n')
    .filter((p) => TEST_FILE.test(p)).map((p) => p.slice(VIEWER.length)));
  const count = ciShardCount();
  const oldManifest = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
  const currentFiles = (table) => Object.fromEntries(Object.entries(table).filter(([file]) => head.has(file)));
  const seconds = measured.length
    ? refreshedWeights(measured, head, (duration) => Number(duration.toFixed(1)))
    : currentFiles(oldManifest.seconds);
  const manifest = { shards: count, seconds };
  if (concurrent.length) {
    manifest.concurrentSeconds = refreshedWeights(concurrent, head, (duration) => Math.max(1e-6, Number(duration.toFixed(6))));
  } else if (oldManifest.concurrentSeconds) {
    manifest.concurrentSeconds = currentFiles(oldManifest.concurrentSeconds);
  }
  const packed = packManifest(seconds, count);
  for (const m of measured) {
    const load = new Array(count).fill(0);
    for (const [f, s] of m.seconds) if (packed.has(f)) load[packed.get(f)] += s;
    console.log(`run ${m.runId} re-packed with the new manifest (in-sample): ${summarize(load)}`);
  }
  const n = Object.keys(seconds).length;
  console.log(`${n} serial files measured; ${head.size - n} at HEAD unmeasured; packed for ${count} shards`);
  if (manifest.concurrentSeconds) {
    const n = Object.keys(manifest.concurrentSeconds).length;
    console.log(`${n} concurrency-2 files measured; ${head.size - n} at HEAD unmeasured; packed for ${count} shards`);
  }
  if (!opts.dryRun) {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${MANIFEST_PATH}`);
  }
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`refresh-viewer-test-durations: ${err.message}`);
    process.exit(1);
  }
}
