// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// scripts/ci-base-stale.mjs: argument parsing, the path filters it derives
// from the real test.yml, and the per-PR evaluation over a fake I/O layer.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guarded imports (the scripts/perf-ratchet pattern, #6516): with the
// production modules reverted, every test fails on the presence assertion
// instead of the file dying at import with no assertion evaluated.
async function load(rel) {
  const url = new URL(rel, import.meta.url);
  return existsSync(url) ? import(url.href) : null;
}
const cli = await load('./ci-base-stale.mjs');
const core = await load('./lib/base-stale.mjs');
const { evaluatePr, loadCache, loadFilterGlobs, parseArgs, readFilterGlobs, run } = cli ?? {};
const { prRelevance } = core ?? {};
function ct(name, body) {
  test(name, () => {
    assert.ok(cli && core, 'scripts/ci-base-stale.mjs or scripts/lib/base-stale.mjs is absent');
    return body();
  });
}

const WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/test.yml', import.meta.url));

ct('parseArgs: the three modes and their required inputs', () => {
  assert.equal(parseArgs(['--sweep']).mode, 'sweep');
  assert.deepEqual({ ...parseArgs(['--pr', '12']) }, { mode: 'pr', pr: 12, dryRun: false });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--in-run', '--pr', '3']), /--head-sha, --merge-sha and --measured-dir/);
  assert.throws(() => parseArgs(['--pr', 'x']), /--pr <n> is required/);
  assert.throws(() => parseArgs(['--sweep', '--bogus']), /unknown option/);
});

ct("relevance follows test.yml's filters: the paths that run the perf-ratchet job and the Rust lanes", () => {
  const globs = loadFilterGlobs(WORKFLOW_PATH);
  assert.deepEqual(prRelevance(['rust/geometry/src/lib.rs'], globs), { perf: true, rust: true, editsCeilings: false });
  assert.deepEqual(prRelevance(['tests/perf-ratchets/bundle.json'], globs), { perf: true, rust: false, editsCeilings: true });
  assert.deepEqual(prRelevance(['apps/viewer/src/App.tsx'], globs), { perf: true, rust: false, editsCeilings: false });
  assert.deepEqual(prRelevance(['docs/guide/cli.md'], globs), { perf: false, rust: false, editsCeilings: false });
  // This script and its decision core are inputs of the job whose last step runs them.
  for (const f of ['scripts/ci-base-stale.mjs', 'scripts/lib/base-stale.mjs', 'scripts/lib/base-stale-io.mjs']) {
    assert.equal(prRelevance([f], globs).perf, true, `${f} must trigger the perf-ratchet job`);
  }
});

ct('readFilterGlobs refuses a workflow whose perf-ratchet gate it cannot read', () => {
  const noJob = ['jobs:', '  changes:', '    steps:', '      - with:', '          filters: |', '            rust:', "              - 'rust/**'", ''].join('\n');
  assert.throws(() => readFilterGlobs(noJob), /no perf-ratchet job/);
});

const PROV = { commit: 'abcdef1234567', measuredAt: '2026-11-22T00:00:00.000Z' };
const ceilings = new Map([['bundle', { family: 'bundle', entries: [{ id: 'eager', metric: 'raw-bytes', unit: 'bytes', ceiling: 1000, tolerance: { kind: 'exact', value: 0 }, provenance: PROV }] }]]);
const fam = (value, commit = 'cafe0000001') => ({ family: 'bundle', commit, measuredAt: PROV.measuredAt, metrics: [{ id: 'eager', value }] });
const globs = { perfGlobs: ['apps/**', 'rust/**'], rustGlobs: ['rust/**'] };

function fakeIo(over = {}) {
  const calls = [];
  const io = {
    prFiles: () => ['apps/viewer/src/a.ts'],
    prMeasurement: () => ({ runId: 7, mergeSha: 'cafe0000001', testedBase: 'base0000001', families: [fam(990)] }),
    mergeParents: () => 'base0000001',
    mainMeasurementAt: () => ({ sha: 'base0000001', families: [fam(500)] }),
    latestMainMeasurement: () => ({ sha: 'tip00000001', behindTip: 0, families: [fam(520)] }),
    movedSince: () => ({ files: [], commits: 0, capped: false }),
    ...over,
  };
  return new Proxy(io, { get: (t, k) => { calls.push(k); return t[k]; } });
}

ct('evaluatePr: main grew past the ceiling since the PR measured -> stale', () => {
  const r = evaluatePr(fakeIo(), { pr: 1, headSha: 'h', mainTip: 'tip00000001', ceilings, globs });
  assert.equal(r.verdict, 'stale');
  assert.equal(r.testedBase, 'base0000001');
  assert.equal(r.prRun, 7);
});

ct('evaluatePr: main has not moved -> zero drift by construction, no main lookups', () => {
  const io = fakeIo({
    mainMeasurementAt: () => { throw new Error('must not look up main'); },
    latestMainMeasurement: () => { throw new Error('must not look up main'); },
  });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 'base0000001', ceilings, globs });
  assert.equal(r.verdict, 'fresh');
});

ct('evaluatePr: in-run measurement with an unreadable base is unknown, not fresh', () => {
  const io = fakeIo({ mergeParents: () => null });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs, measured: { families: [fam(10)], mergeSha: 'm' } });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reasons[0], /base could not be read/);
});

ct('evaluatePr: no measurement for a relevant PR is unknown', () => {
  const r = evaluatePr(fakeIo({ prMeasurement: () => null }), { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs });
  assert.equal(r.verdict, 'unknown');
});

ct('evaluatePr: an irrelevant PR is not-relevant without reading any measurement', () => {
  const io = fakeIo({ prFiles: () => ['docs/a.md'], prMeasurement: () => { throw new Error('must not read'); } });
  assert.equal(evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs }).verdict, 'not-relevant');
});

ct('evaluatePr: an I/O fault becomes an unknown verdict naming it, never a throw or a pass', () => {
  const io = fakeIo({ prFiles: () => { throw new Error('HTTP 502\nmore'); } });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs });
  assert.equal(r.verdict, 'unknown');
  assert.deepEqual(r.reasons, ['harness: HTTP 502']);
});

ct('evaluatePr: the Rust half uses the same tested base', () => {
  let seen;
  const io = fakeIo({
    prFiles: () => ['rust/core/src/a.rs'],
    movedSince: (base, tip) => { seen = [base, tip]; return { files: ['rust/core/src/b.rs'], commits: 2, capped: false }; },
    latestMainMeasurement: () => ({ sha: 'tip00000001', behindTip: 0, families: [fam(500)] }),
  });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 'tip00000001', ceilings, globs });
  assert.deepEqual(seen, ['base0000001', 'tip00000001']);
  assert.equal(r.verdict, 'stale');
  assert.deepEqual(r.rust.overlap, ['rust/core']);
});

// run(): what each mode posts, over a fake I/O layer and a temporary cache.

const STALE_PR = { number: 5, headRefOid: 'head5', isDraft: false, isCrossRepository: false };
const FORK_PR = { number: 6, headRefOid: 'head6', isDraft: false, isCrossRepository: true };
const realCeilings = () => new Map([['bundle', ceilings.get('bundle')]]);

function runFake({ gate, cacheData = null, prs = [STALE_PR], existing = 'failure', opts = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-run-'));
  const cachePath = join(dir, 'cache.json');
  if (cacheData) writeFileSync(cachePath, JSON.stringify(cacheData));
  const posts = [];
  const reads = [];
  const makeIo = ({ cache }) => {
    const store = { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...(cache ?? {}) };
    return {
      ...fakeIo(),
      store,
      stats: { calls: 0, downloads: 0, cacheHits: 0 },
      mainTip: () => 'tip00000001',
      ceilingsAt: realCeilings,
      coreRemaining: () => 5000,
      queueCandidates: () => prs,
      existingStatus: (sha) => { reads.push(sha); return existing; },
      postStatus: (sha, context, status) => { posts.push({ sha, context, ...status }); store.posted[sha] = status.state; },
    };
  };
  const env = { GITHUB_REPOSITORY: 'o/r', CI_BASE_STALE_GATE: gate };
  const log = console.log;
  console.log = () => {};
  try {
    run({ mode: 'sweep', cache: cachePath, dryRun: false, ...opts }, env, makeIo);
  } finally {
    console.log = log;
  }
  return { posts, reads, saved: loadCache(cachePath) };
}

ct('run, on: a stale labelled PR gets a failure status; a fork gets nothing', () => {
  const { posts } = runFake({ gate: 'on', prs: [STALE_PR, FORK_PR] });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sha, 'head5');
  assert.equal(posts[0].context, 'PR base staleness');
  assert.equal(posts[0].state, 'failure');
});

ct('run, shadow: a settled sweep reads no status and posts nothing, even for a stale PR', () => {
  const { posts, reads, saved } = runFake({ gate: undefined, cacheData: { version: 1, lastMode: 'shadow' } });
  assert.deepEqual(posts, []);
  assert.deepEqual(reads, []);
  assert.equal(saved.lastMode, 'shadow');
});

ct('run, rollback: the first shadow sweep after `on` releases a failure the gate left', () => {
  const { posts, reads } = runFake({ gate: 'shadow', cacheData: { version: 1, lastMode: 'on' } });
  assert.deepEqual(reads, ['head5']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].state, 'success');
  assert.match(posts[0].description, /shadow/);
});

ct('run, shadow: a head the gate already left green is not posted again', () => {
  const { posts } = runFake({ gate: 'shadow', cacheData: { version: 1, lastMode: 'on' }, existing: 'success' });
  assert.deepEqual(posts, []);
});

ct('run, dry run: nothing is read or posted in either mode', () => {
  for (const gate of ['on', 'shadow']) {
    const { posts, reads } = runFake({ gate, cacheData: { version: 1, lastMode: 'on' }, opts: { dryRun: true } });
    assert.deepEqual([posts, reads], [[], []]);
  }
});

ct('run: a single-PR run keeps the sweep cache entries of other heads', () => {
  const cacheData = { version: 1, lastMode: 'shadow', prFiles: { other: ['a'] }, prMeasurements: {}, mainMeasurements: {}, posted: {} };
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-run-'));
  const cachePath = join(dir, 'cache.json');
  writeFileSync(cachePath, JSON.stringify(cacheData));
  const makeIo = ({ cache }) => ({
    ...fakeIo(),
    store: { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...cache },
    stats: { calls: 0, downloads: 0, cacheHits: 0 },
    mainTip: () => 'tip00000001',
    ceilingsAt: realCeilings,
    pull: () => ({ head: { sha: 'head5', repo: { full_name: 'o/r' } } }),
    existingStatus: () => null,
    postStatus: () => {},
  });
  const log = console.log;
  console.log = () => {};
  try {
    run({ mode: 'pr', pr: 5, cache: cachePath, dryRun: false }, { GITHUB_REPOSITORY: 'o/r' }, makeIo);
  } finally {
    console.log = log;
  }
  assert.deepEqual(loadCache(cachePath).prFiles.other, ['a']);
});
