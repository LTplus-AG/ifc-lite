// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// scripts/ci-base-stale.mjs: argument parsing, the path filters it derives
// from the real test.yml, and the per-PR evaluation over a fake I/O layer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guarded imports (the scripts/perf-ratchet pattern, #6516): with the
// production modules reverted, every test fails on the presence assertion
// instead of the file dying at import with no assertion evaluated.
// All three are checked before any is imported: the CLI imports the other
// two, so one reverted module would otherwise fail the CLI's import.
const MODULES = ['./ci-base-stale.mjs', './lib/base-stale.mjs', './lib/base-stale-io.mjs'].map((rel) => new URL(rel, import.meta.url));
const present = MODULES.every((url) => existsSync(url));
const [cli, core, ioMod] = present ? await Promise.all(MODULES.map((url) => import(url.href))) : [null, null, null];
const { callAllowance, CALL_CAP, evaluatePr, MIN_ALLOWANCE, loadCache, loadFilterGlobs, parseArgs, RATE_FLOOR, readFilterGlobs, run } = cli ?? {};
const { prRelevance } = core ?? {};
const { BudgetError, changedPaths, compareMoved, createIo, isOwnRun } = ioMod ?? {};
function ct(name, body) {
  test(name, () => {
    assert.ok(cli && core && ioMod, 'scripts/ci-base-stale.mjs, scripts/lib/base-stale.mjs or scripts/lib/base-stale-io.mjs is absent');
    assert.equal(typeof callAllowance, 'function', 'callAllowance is not exported');
    assert.equal(typeof isOwnRun, 'function', 'isOwnRun is not exported');
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

ct('parseArgs: a malformed --pr-run is refused, never read as "no replay"', () => {
  assert.equal(parseArgs(['--pr', '1', '--pr-run', '4503929569']).prRun, 4503929569);
  for (const bad of ['4503929569x', '0', '-3', '1.5', '9007199254740993']) {
    assert.throws(() => parseArgs(['--pr', '1', '--pr-run', bad]), /--pr-run needs a run id/, bad);
  }
});

ct('callAllowance: half the headroom above the floor, capped, never negative', () => {
  assert.equal(callAllowance(1000, CALL_CAP.sweep), CALL_CAP.sweep);
  assert.equal(callAllowance(RATE_FLOOR + 100, CALL_CAP.sweep), 50);
  assert.equal(callAllowance(RATE_FLOOR + 2 * MIN_ALLOWANCE - 1, CALL_CAP.sweep), 0, 'too small for the setup reads');
  assert.equal(callAllowance(RATE_FLOOR + 1, CALL_CAP.sweep), 0);
  assert.equal(callAllowance(RATE_FLOOR - 50, CALL_CAP.single), 0);
  assert.equal(callAllowance(null, CALL_CAP.single), CALL_CAP.single);
  // Back to back, runs converge on the floor and never cross it.
  let left = 1000;
  for (let i = 0; i < 50; i += 1) left -= callAllowance(left, CALL_CAP.sweep);
  assert.ok(left >= RATE_FLOOR, `reached ${left}`);
});

ct('io: only a same-repository run may supply a main measurement', () => {
  assert.equal(isOwnRun({ id: 1, repository_id: 9, head_repository_id: 9 }), true);
  assert.equal(isOwnRun({ id: 1, repository_id: 9, head_repository_id: 4 }), false, 'a fork run');
  assert.equal(isOwnRun({ id: 1 }), false, 'origin unknown');
  assert.equal(isOwnRun(null), false);
});

ct('io: a renamed file counts at both paths', () => {
  const paths = changedPaths([{ filename: 'rust/core/src/a.rs', previous_filename: 'rust/export/src/a.rs' }, { filename: 'docs/x.md' }]);
  assert.deepEqual(paths, ['rust/core/src/a.rs', 'rust/export/src/a.rs', 'docs/x.md']);
});

ct('io: past the budget a call throws BudgetError before reaching the API', () => {
  const io = createIo({ repo: 'o/r' });
  io.setBudget(0);
  assert.throws(() => io.mainTip(), (err) => err instanceof BudgetError);
  assert.equal(io.stats.calls, 0);
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

function runFake({ gate, cacheData = null, prs = [STALE_PR], existing = 'failure', opts = {}, remaining = () => 5000, ioOver = {} }) {
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
      setBudget: () => {},
      inRunOnHeads: () => new Set(),
      coreRemaining: remaining,
      queueCandidates: () => prs,
      existingStatus: (sha) => { reads.push(sha); return existing; },
      postStatus: (sha, context, status) => { posts.push({ sha, context, ...status }); store.posted[sha] = status.state; },
      ...ioOver,
    };
  };
  const env = { GITHUB_REPOSITORY: 'o/r', CI_BASE_STALE_GATE: gate };
  const log = console.log;
  console.log = () => {};
  const jsonOut = join(dir, 'verdicts.jsonl');
  try {
    const code = run({ mode: 'sweep', cache: cachePath, dryRun: false, jsonOut, ...opts }, env, makeIo);
    opts.onCode?.(code);
  } finally {
    console.log = log;
  }
  const rows = readFileSync(jsonOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { posts, reads, saved: loadCache(cachePath), rows };
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

ct('run, shadow: a head whose own run judged with the gate on is read and released, whatever its verdict now', () => {
  // The in-run step posted a failure during a brief `on` between two shadow
  // sweeps; the head has since turned fresh. Only the `-on` upload records it.
  const fresh = { prMeasurement: () => ({ runId: 7, mergeSha: 'cafe0000001', testedBase: 'base0000001', families: [fam(400)] }) };
  const second = { ...STALE_PR, number: 7, headRefOid: 'head7' };
  const { reads, posts } = runFake({
    gate: 'shadow',
    cacheData: { version: 1, lastMode: 'shadow' },
    prs: [STALE_PR, second],
    ioOver: { ...fresh, inRunOnHeads: () => new Set(['head7']) },
  });
  assert.deepEqual(reads, ['head7']);
  assert.deepEqual(posts.map((p) => [p.sha, p.state]), [['head7', 'success']]);
});

ct('run, shadow: when the in-run lookup fails, every head is read (the safe direction)', () => {
  const { reads } = runFake({
    gate: 'shadow',
    cacheData: { version: 1, lastMode: 'shadow' },
    ioOver: { inRunOnHeads: () => { throw new Error('HTTP 502'); } },
  });
  assert.deepEqual(reads, ['head5']);
});

ct('run, rollback: the first shadow sweep after `on` releases a failure the gate left', () => {
  const { posts, reads } = runFake({ gate: 'shadow', cacheData: { version: 1, lastMode: 'on' } });
  assert.deepEqual(reads, ['head5']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].state, 'success');
  assert.equal(posts[0].description, 'Gate in shadow (CI_BASE_STALE_GATE not on): not enforced');
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
    setBudget: () => {},
    coreRemaining: () => 5000,
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

ct('run, rollback: a single-PR run after `on` does not mark the rollback sweep done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-run-'));
  const cachePath = join(dir, 'cache.json');
  writeFileSync(cachePath, JSON.stringify({ version: 1, lastMode: 'on' }));
  const makeIo = ({ cache }) => ({
    ...fakeIo(),
    store: { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...cache },
    stats: { calls: 0, downloads: 0, cacheHits: 0 },
    setBudget: () => {},
    coreRemaining: () => 5000,
    mainTip: () => 'tip00000001',
    ceilingsAt: realCeilings,
    pull: () => ({ head: { sha: 'head9', repo: { full_name: 'o/r' } } }),
    existingStatus: () => null,
    postStatus: () => {},
  });
  const log = console.log;
  console.log = () => {};
  try {
    run({ mode: 'pr', pr: 9, cache: cachePath, dryRun: false }, { GITHUB_REPOSITORY: 'o/r' }, makeIo);
  } finally {
    console.log = log;
  }
  assert.equal(loadCache(cachePath).lastMode, 'on');
  // So the next shadow sweep still reads (and releases) every labelled head.
  const { reads, posts } = runFake({ gate: 'shadow', cacheData: loadCache(cachePath) });
  assert.deepEqual(reads, ['head5']);
  assert.equal(posts[0].state, 'success');
});

ct('run, budget: a sweep cut short posts nothing for the rest and keeps the rollback pending', () => {
  const second = { ...STALE_PR, number: 7, headRefOid: 'head7' };
  let n = 0;
  const { posts, reads, saved, rows } = runFake({
    gate: 'shadow',
    cacheData: { version: 1, lastMode: 'on' },
    prs: [STALE_PR, second],
    ioOver: { prFiles: () => { n += 1; if (n === 1) return ['apps/viewer/src/a.ts']; throw new BudgetError('files of PR #7'); } },
  });
  assert.deepEqual(reads, ['head5'], 'the cut-short head is not read');
  assert.deepEqual(posts.map((p) => p.sha), ['head5']);
  assert.equal(saved.lastMode, 'on', 'an incomplete sweep must not mark the rollback done');
  assert.equal(rows[1].verdict, 'unknown');
  assert.deepEqual(rows[1].reasons, ['not judged: API budget for this run spent before files of PR #7']);
  assert.equal(rows[1].posted, null);
});

ct('run, budget: the rate floor is re-read between PRs and stops the sweep', () => {
  const second = { ...STALE_PR, number: 7, headRefOid: 'head7' };
  const left = [1000, RATE_FLOOR - 1];
  const { rows, saved } = runFake({ gate: 'shadow', cacheData: { version: 1, lastMode: 'shadow' }, prs: [STALE_PR, second], remaining: () => left.shift() ?? 0 });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].verdict, 'unknown');
  assert.deepEqual(rows[1].reasons, [`not judged: ${RATE_FLOOR - 1} core API requests left (floor ${RATE_FLOOR})`]);
  assert.equal(saved.lastMode, 'shadow');
});

ct('run: under the floor at start nothing is read, an empty evidence file is written', () => {
  const { rows, reads, posts } = runFake({ gate: 'on', remaining: () => RATE_FLOOR });
  assert.deepEqual([rows, reads, posts], [[], [], []]);
});

ct('run: a budget spent during setup is a clean skip (exit 0, empty evidence), not a harness fault', () => {
  let code;
  const { rows, reads, posts } = runFake({
    gate: 'on',
    ioOver: { queueCandidates: () => { throw new BudgetError('open PRs labelled mergify-trial'); } },
    opts: { onCode: (c) => { code = c; } },
  });
  assert.deepEqual([rows, reads, posts], [[], [], []]);
  assert.equal(code, 0);
});

ct('io: a file main moved out of a crate still counts for that crate (local git, no rename folding)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-git-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'rust/core/src'), { recursive: true });
  writeFileSync(join(dir, 'rust/core/src/a.rs'), 'pub fn a() -> u32 { 1 }\n'.repeat(20));
  writeFileSync(join(dir, 'rust/core/src/café.rs'), 'pub fn c() {}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'docs'));
  git('mv', 'rust/core/src/a.rs', 'docs/a.rs');
  writeFileSync(join(dir, 'rust/core/src/café.rs'), 'pub fn c() -> u8 { 2 }\n');
  git('add', '-A');
  git('commit', '-qm', 'move');
  const moved = createIo({ repo: 'o/r', cwd: dir }).movedSince(base, git('rev-parse', 'HEAD'));
  // Both ends of the move, and the non-ASCII name as raw bytes, not C-quoted.
  assert.deepEqual([...moved.files].sort(), ['docs/a.rs', 'rust/core/src/a.rs', 'rust/core/src/café.rs']);
});

ct('io: the compare cap counts entries, not the two paths a rename expands to', () => {
  const renames = (n) => Array.from({ length: n }, (_, i) => ({ filename: `rust/b/src/f${i}.rs`, previous_filename: `rust/a/src/f${i}.rs` }));
  const under = compareMoved({ files: renames(200), total_commits: 4 });
  assert.equal(under.files.length, 400);
  assert.equal(under.capped, false, '200 entries is under the 300-entry cap');
  assert.equal(compareMoved({ files: renames(300), total_commits: 4 }).capped, true);
  assert.equal(compareMoved({ files: [], total_commits: 250 }).capped, true);
  assert.equal(compareMoved({ total_commits: 1 }).capped, true, 'no file list is no answer');
});

ct('run: two PRs sharing a head keep their own file lists in the cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-run-'));
  const cachePath = join(dir, 'cache.json');
  const lists = { 5: ['docs/a.md'], 6: ['rust/core/src/a.rs'] };
  const makeIo = ({ cache }) => {
    const store = { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...(cache ?? {}) };
    return {
      ...fakeIo(),
      store,
      stats: { calls: 0, downloads: 0, cacheHits: 0 },
      setBudget: () => {},
      inRunOnHeads: () => new Set(),
      coreRemaining: () => 5000,
      mainTip: () => 'tip00000001',
      ceilingsAt: realCeilings,
      queueCandidates: () => [{ ...STALE_PR, number: 5, headRefOid: 'same' }, { ...STALE_PR, number: 6, headRefOid: 'same' }],
      prFiles: (n, head) => (store.prFiles[`${head}#${n}`] ??= lists[n]),
      existingStatus: () => null,
      postStatus: () => {},
    };
  };
  const log = console.log;
  console.log = () => {};
  try {
    run({ mode: 'sweep', cache: cachePath, dryRun: true }, { GITHUB_REPOSITORY: 'o/r' }, makeIo);
  } finally {
    console.log = log;
  }
  const saved = loadCache(cachePath).prFiles;
  assert.deepEqual(saved, { 'same#5': ['docs/a.md'], 'same#6': ['rust/core/src/a.rs'] }, 'both survive the prune, neither overwrites the other');
});

ct('evaluatePr: an unreadable main diff makes the Rust half unknown but keeps a stale perf half', () => {
  const io = fakeIo({
    prFiles: () => ['rust/core/src/a.rs'],
    movedSince: () => { throw new Error('HTTP 502'); },
  });
  const log = console.log;
  console.log = () => {};
  let r;
  try {
    r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 'tip00000001', ceilings, globs });
  } finally {
    console.log = log;
  }
  assert.equal(r.verdict, 'stale', 'perf is stale on its own evidence');
  assert.equal(r.rust.verdict, 'unknown');
});

ct('run: a replay (--pr-run / --main-sha) is logged, never posted, even with the gate on', () => {
  for (const over of [{ prRun: 4503929569 }, { mainSha: 'tip00000001' }]) {
    const { posts, reads } = runFake({ gate: 'on', opts: over });
    assert.deepEqual([posts, reads], [[], []], JSON.stringify(over));
  }
});
