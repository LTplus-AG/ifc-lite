// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// scripts/ci-base-stale.mjs: argument parsing, the path filters it derives
// from the real test.yml, and the per-PR evaluation over a fake I/O layer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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
const { BudgetError, CANDIDATE_LIMIT, candidateList, changedPaths, compareMoved, createIo, IN_RUN_ON_ARTIFACT, isOwnRun, MEASURED_FILE_MAX_BYTES, measuredJsonFiles, pickTreeMeasurement } = ioMod ?? {};
function ct(name, body) {
  test(name, (t) => {
    assert.ok(cli && core && ioMod, 'scripts/ci-base-stale.mjs, scripts/lib/base-stale.mjs or scripts/lib/base-stale-io.mjs is absent');
    assert.equal(typeof callAllowance, 'function', 'callAllowance is not exported');
    assert.equal(typeof isOwnRun, 'function', 'isOwnRun is not exported');
    return body(t);
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
const globs = { perfGlobs: ['apps/**', 'rust/**'], nativeGlobs: ['rust/**'], rustGlobs: ['rust/**'] };

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

ct('evaluatePr #11350: missing native measurements are unknown only when the native job applies', () => {
  const native = { family: 'native-instructions', metrics: [{ id: 'scan', value: 90 }] };
  const nativeCeiling = { family: native.family, entries: [{ ...ceilings.get('bundle').entries[0], id: 'scan', ceiling: 100 }] };
  const options = { pr: 1, headSha: 'h', ceilings: new Map([...ceilings, [native.family, nativeCeiling]]), globs: loadFilterGlobs(WORKFLOW_PATH) };
  const judge = (path, mainTip, families = [fam(900)], mainFamilies = [fam(500), native]) => evaluatePr(fakeIo({
    prFiles: () => [path],
    prMeasurement: () => ({ runId: 7, testedBase: 'base0000001', families }),
    mainMeasurementAt: () => ({ sha: 'base0000001', families: mainFamilies }),
    latestMainMeasurement: () => ({ sha: 'tip00000001', behindTip: 0, families: [fam(520), native] }),
  }), { ...options, mainTip });

  const rust = 'rust/core/src/a.rs';
  for (const tip of ['base0000001', 'tip00000001']) {
    const missing = judge(rust, tip);
    assert.equal(missing.verdict, 'unknown');
    assert.equal(missing.perf.verdict, 'unknown');
    assert.equal(missing.rust.verdict, 'fresh');
    assert.ok(missing.perf.rows.some((row) => row.id === 'native-instructions/*' && row.verdict === 'unknown'));
    assert.equal(judge(rust, tip, [fam(900), native]).verdict, 'fresh');
    assert.equal(judge('apps/viewer/src/App.tsx', tip, [fam(900)], [fam(500)]).verdict, 'fresh');
  }
  assert.equal(judge('scripts/perf-ratchet/measure-native-instructions.mjs', 'tip00000001').verdict, 'unknown');
  assert.equal(judge(rust, 'tip00000001', [fam(990)]).verdict, 'stale', 'measured bundle regression still takes precedence');
});

ct('evaluatePr: in-run measurement with an unreadable base is unknown, not fresh', () => {
  const io = fakeIo({ mergeParents: () => null });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs, measured: { families: [fam(10)], mergeSha: 'm' } });
  assert.equal(r.verdict, 'unknown');
  assert.deepEqual(r.reasons, ["perf: the PR measurement's base could not be read"]);
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

const STALE_PR = { number: 5, headRefOid: 'head5', baseRefName: 'main', isDraft: false, isCrossRepository: false };
const FORK_PR = { number: 6, headRefOid: 'head6', baseRefName: 'main', isDraft: false, isCrossRepository: true };
const realCeilings = () => new Map([['bundle', ceilings.get('bundle')]]);

function runFake({ gate, cacheData = null, prs = [STALE_PR], existing = 'failure', opts = {}, remaining = () => 5000, ioOver = {}, baseRef = 'main' }) {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-run-'));
  const cachePath = join(dir, 'cache.json');
  if (cacheData) writeFileSync(cachePath, JSON.stringify(cacheData));
  const posts = [];
  const reads = [];
  const makeIo = ({ cache }) => {
    const store = { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...cache };
    return {
      ...fakeIo(),
      store,
      stats: { calls: 0, downloads: 0, cacheHits: 0 },
      mainTip: () => 'tip00000001',
      ceilingsAt: realCeilings,
      setBudget: () => {},
      inRunOnHeads: () => new Set(),
      coreRemaining: remaining,
      queueCandidates: () => ({ prs, capped: false }),
      existingStatus: (sha) => { reads.push(sha); return existing; },
      postStatus: (sha, context, status) => { posts.push({ sha, context, ...status }); store.posted[sha] = status.state; },
      ...ioOver,
    };
  };
  const env = { GITHUB_REPOSITORY: 'o/r', CI_BASE_STALE_GATE: gate, GITHUB_BASE_REF: baseRef };
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

ct('run: the legacy on value cannot enable status enforcement (#11350)', () => {
  const { posts, rows } = runFake({ gate: 'on', prs: [STALE_PR, FORK_PR], existing: null });
  assert.deepEqual(posts, []);
  assert.deepEqual(rows.map(row => [row.gateMode, row.verdict]), [['shadow', 'stale'], ['shadow', 'stale']]);
});

ct('run: in-run evidence does not read or release statuses (#11350)', () => {
  const { posts, reads, rows } = runFake({
    gate: 'on',
    opts: { mode: 'in-run', pr: 5, headSha: 'head5', measuredDir: '/does-not-exist/base-stale' },
    ioOver: { prMeasurement: () => ({ runId: 7, testedBase: 'base0000001', families: [fam(400)] }) },
  });
  assert.deepEqual([reads, posts], [[], []]);
  assert.deepEqual(rows.map(row => [row.gateMode, row.verdict]), [['shadow', 'unknown']]);
  assert.deepEqual(rows[0].reasons, ['harness: no measurement from the current Test attempt']);
  assert.equal(rows[0].prRun, null);
});

ct('run #11350: all entry points judge main and exclude release and stacked bases', () => {
  for (const baseRef of ['main', 'release', 'ci/stack-parent', '']) {
    const main = baseRef === 'main';
    let judged = 0;
    const ioOver = {
      pull: () => ({ head: { sha: 'head5', repo: { full_name: 'o/r' } }, base: { ref: baseRef } }),
      prFiles: () => { judged += 1; return ['apps/viewer/src/a.ts']; },
    };
    const sweep = runFake({ prs: [{ ...STALE_PR, baseRefName: baseRef }], ioOver });
    const dispatch = runFake({ opts: { mode: 'pr', pr: 5, trigger: 'dispatch' }, ioOver });
    const inRun = runFake({ opts: { mode: 'in-run', pr: 5, headSha: 'head5', measuredDir: '/does-not-exist/base-stale' }, ioOver, baseRef });
    assert.equal(judged, main ? 3 : 0, baseRef);
    for (const result of [sweep, dispatch, inRun]) {
      assert.equal(result.rows[0].verdict, main && result !== inRun ? 'stale' : baseRef && !main ? 'not-relevant' : 'unknown', baseRef);
    }
    assert.deepEqual(dispatch.posts.map((post) => post.state), ['success'], 'targeted dispatch still releases legacy holds');
    assert.deepEqual([inRun.reads, inRun.posts], [[], []]);
  }
});

ct('run #11350: the documented in-run CLI resolves an absent base against the supplied head', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-in-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(fam(400, 'cafe0000001')));
  const opts = parseArgs(['--in-run', '--pr', '5', '--head-sha', 'head5', '--merge-sha', 'cafe0000001', '--measured-dir', dir]);
  assert.throws(() => parseArgs(['--in-run', '--pr', '5', '--head-sha', 'head5', '--merge-sha', 'cafe0000001', '--measured-dir', dir, '--pr-run', '42']), /cannot replay/);
  const runAt = (ref, sha = 'head5') => runFake({ baseRef: '', opts, ioOver: {
    pull: () => ({ head: { sha, repo: { full_name: 'o/r' } }, base: { ref } }),
    prMeasurement: () => { assert.fail('the local measurement should be used'); },
  } });
  const main = runAt('main');
  assert.equal(main.rows[0].verdict, 'fresh');
  assert.equal(main.rows[0].testedBase, 'base0000001');
  assert.deepEqual([main.reads, main.posts], [[], []]);
  assert.equal(runAt('release').rows[0].verdict, 'not-relevant');
  assert.equal(runAt('main', 'new-head').rows[0].verdict, 'unknown');
  assert.equal(runAt(null).rows[0].verdict, 'unknown');
  const unreadable = runFake({ baseRef: '', opts, ioOver: { pull: () => { throw new Error('HTTP 503'); } } });
  assert.equal(unreadable.rows[0].verdict, 'unknown');
  assert.deepEqual(unreadable.rows[0].reasons, ["the PR's base branch could not be read (HTTP 503)"]);
  writeFileSync(join(dir, 'bundle.json'), '{');
  const malformed = runAt('main');
  assert.equal(malformed.rows[0].verdict, 'unknown');
  assert.equal(malformed.rows[0].reasons[0].split(':')[0], 'harness');
});

ct('run #11350: in-run native measurements require a valid bundle', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-native-only-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const native = { ...fam(10), family: 'native-instructions' };
  const nativeCeiling = { family: native.family, entries: ceilings.get('bundle').entries };
  writeFileSync(join(dir, 'native-instructions.json'), JSON.stringify(native));
  const evaluate = () => runFake({
    opts: { mode: 'in-run', pr: 5, headSha: 'head5', mergeSha: 'cafe0000001', measuredDir: dir },
    ioOver: {
      prFiles: () => ['rust/core/src/a.rs'],
      mainTip: () => 'base0000001',
      ceilingsAt: () => new Map([...ceilings, [native.family, nativeCeiling]]),
    },
  }).rows[0];
  const incomplete = evaluate();
  assert.equal(incomplete.verdict, 'unknown');
  assert.deepEqual(incomplete.reasons, ['harness: the in-run measurement directory must contain exactly one valid bundle measurement']);
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(fam(400)));
  assert.equal(evaluate().verdict, 'fresh');
  writeFileSync(join(dir, 'bundle.json'), '{');
  assert.equal(evaluate().verdict, 'unknown');
});

ct('run: same-head PRs keep separate evidence with the legacy switch set (#11350)', () => {
  const fresh = { ...STALE_PR, number: 6 };
  for (const prs of [[STALE_PR, fresh], [fresh, STALE_PR]]) {
    const ioOver = { prMeasurement: (_head, _run, pr) => ({
      runId: pr, testedBase: 'base0000001', families: [fam(pr === fresh.number ? 400 : 990)],
    }) };
    const shadow = runFake({ gate: 'on', prs, existing: null, ioOver });
    assert.deepEqual(shadow.posts, []);
    assert.deepEqual(shadow.rows.map(r => [r.pr, r.verdict]), prs.map(p => [p.number, p === fresh ? 'fresh' : 'stale']));
  }
});

ct('run, shadow: delayed verdicts against two main revisions remain evidence only (#11350)', () => {
  const judge = (mainTip) => runFake({
    gate: 'on',
    existing: null,
    ioOver: { mainTip: () => mainTip },
  });
  const newer = judge('base0000001');
  const delayed = judge('tip00000001');
  assert.deepEqual([newer.posts, delayed.posts], [[], []]);
  assert.deepEqual([newer, delayed].map(({ rows: [r] }) => [r.head, r.mainTip, r.verdict]), [
    ['head5', 'base0000001', 'fresh'],
    ['head5', 'tip00000001', 'stale'],
  ]);
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
  assert.equal(posts[0].description, 'Advisory base-stale signal: legacy hold released');
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

ct('run #11350: budget-limited sweeps resume from the first unjudged PR', () => {
  const prs = [STALE_PR, { ...STALE_PR, number: 7, headRefOid: 'head7' }, { ...STALE_PR, number: 8, headRefOid: 'head8' }];
  const pass = (cacheData) => {
    const left = [1000, RATE_FLOOR - 1];
    return runFake({ prs, cacheData, remaining: () => left.shift() ?? 0 });
  };
  const first = pass({ version: 1, lastMode: 'on' });
  const second = pass(first.saved);
  const third = pass(second.saved);
  assert.deepEqual([first, second, third].map(({ rows }) => rows.map((row) => [row.pr, row.verdict])), [
    [[5, 'stale'], [7, 'unknown'], [8, 'unknown']],
    [[7, 'stale'], [8, 'unknown'], [5, 'unknown']],
    [[8, 'stale'], [5, 'unknown'], [7, 'unknown']],
  ]);
  assert.deepEqual(third.saved.released, { head5: true, head7: true, head8: true });
});

ct('workflow #11350: a late targeted run cannot replace a newer sweep cache', (t) => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/base-stale.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.judge;
  const restore = job.steps.find((step) => step.uses?.split('@')[0] === 'actions/cache/restore');
  const save = job.steps.find((step) => step.uses?.split('@')[0] === 'actions/cache/save');
  const judge = job.steps.find((step) => step.id === 'judge');
  const temp = mkdtempSync(join(tmpdir(), 'base-stale-overlap-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const entries = new Map();
  const key = (pattern, id) => pattern
    .replace(/\$\{\{ github\.run_id \}\}/, String(id))
    .replace(/\$\{\{ github\.run_attempt \}\}/, '1');
  const begin = (id, PR) => {
    const runnerTemp = mkdtempSync(join(temp, 'runner-'));
    const args = execFileSync('bash', ['-c', `node() { printf '%s\\n' "$@"; }\n${judge.run}`], {
      env: { ...process.env, PR, RUNNER_TEMP: runnerTemp, TRIGGER: 'test' }, encoding: 'utf8',
    }).trim().split('\n');
    const exact = key(restore.with.key, id);
    // @source-text-assertion-ok Models GitHub's prefix matching against generated cache keys.
    const newest = [...entries].reverse().find(([candidate]) => candidate.startsWith(restore.with['restore-keys']));
    return { id, PR, opts: parseArgs(args.slice(1)), cache: entries.get(exact) ?? newest?.[1] ?? null };
  };
  const finishRun = (run, cache) => {
    // Evaluate the save step's equality guard against the job environment.
    const [variable, expected] = save.if.split(' == ');
    const saveAllowed = save.if === 'always()' || (variable === 'env.PR' && JSON.stringify(run.PR) === expected?.replaceAll("'", '"'));
    if (saveAllowed) entries.set(key(save.with.key, run.id), cache);
  };
  const second = { ...STALE_PR, number: 7, headRefOid: 'head7' };
  const sweep = (cacheData) => {
    const left = [1000, RATE_FLOOR - 1];
    return runFake({ prs: [STALE_PR, second], cacheData, remaining: () => left.shift() ?? 0 });
  };
  const initial = begin(1, '');
  finishRun(initial, sweep(initial.cache).saved);
  const targeted = begin(2, '5');
  assert.equal(targeted.opts.mode, 'pr');
  assert.equal(targeted.cache.nextSweepPr, 7);
  const advancing = begin(3, '');
  assert.equal(advancing.opts.mode, 'sweep');
  finishRun(advancing, sweep(advancing.cache).saved);
  const targetedResult = runFake({ cacheData: targeted.cache, opts: { mode: targeted.opts.mode, pr: targeted.opts.pr }, ioOver: {
    pull: () => ({ head: { sha: 'head5', repo: { full_name: 'o/r' } }, base: { ref: 'main' } }),
  } });
  finishRun(targeted, targetedResult.saved);
  const next = begin(4, '');
  assert.equal(next.cache.nextSweepPr, 5);
  assert.equal(sweep(next.cache).rows[0].pr, 5);
});

ct('run: under the floor at start nothing is read; the evidence file holds one skip row', () => {
  const { rows, reads, posts } = runFake({ gate: 'on', remaining: () => RATE_FLOOR });
  assert.deepEqual([reads, posts], [[], []]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skipped, 'rate-floor');
  assert.equal(rows[0].trigger, 'sweep');
  assert.equal(rows[0].verdict, undefined);
  assert.ok(rows[0].evaluatedAt);
});

ct('run: a budget spent during setup is a clean skip (exit 0, one skip row), not a harness fault', () => {
  let code;
  const { rows, reads, posts } = runFake({
    gate: 'on',
    ioOver: { queueCandidates: () => { throw new BudgetError('open PRs labelled mergify-trial'); } },
    opts: { onCode: (c) => { code = c; } },
  });
  assert.deepEqual([reads, posts], [[], []]);
  assert.deepEqual(rows.map((row) => [row.skipped, row.verdict]), [['budget', undefined]]);
  assert.equal(code, 0);
});

ct('io: an artifact file that is a symlink, or over the size cap, is refused, not followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-art-'));
  writeFileSync(join(dir, 'b.json'), '{}');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  assert.deepEqual(measuredJsonFiles(dir), [join(dir, 'b.json')]);
  symlinkSync('/dev/zero', join(dir, 'a.json'));
  assert.throws(() => measuredJsonFiles(dir), /a\.json is not a regular file/);
  const big = mkdtempSync(join(tmpdir(), 'base-stale-art-'));
  writeFileSync(join(big, 'x.json'), Buffer.alloc(MEASURED_FILE_MAX_BYTES + 1, 32));
  assert.throws(() => measuredJsonFiles(big), /over the \d+ cap/);
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
    const store = { mainMeasurements: {}, prMeasurements: {}, prFiles: {}, posted: {}, ...cache };
    return {
      ...fakeIo(),
      store,
      stats: { calls: 0, downloads: 0, cacheHits: 0 },
      setBudget: () => {},
      inRunOnHeads: () => new Set(),
      coreRemaining: () => 5000,
      mainTip: () => 'tip00000001',
      ceilingsAt: realCeilings,
      queueCandidates: () => ({ prs: [{ ...STALE_PR, number: 5, headRefOid: 'same' }, { ...STALE_PR, number: 6, headRefOid: 'same' }], capped: false }),
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
  for (const [flag, value] of [['--pr-run', '4503929569'], ['--main-sha', 'tip00000001']]) {
    assert.throws(() => parseArgs(['--sweep', flag, value]), /--sweep cannot replay/);
    const opts = parseArgs(['--pr', '5', flag, value]);
    const { posts, reads, rows } = runFake({ gate: 'on', opts, ioOver: {
      pull: () => ({ head: { sha: 'head5', repo: { full_name: 'o/r' } }, base: { ref: 'main' } }),
      prMeasurement: () => ({ runId: 4503929569, testedBase: 'base0000001', mergeSha: 'merge', families: [fam(900)] }),
      movedSince: () => ({ files: ['apps/viewer/src/a.ts'], capped: false }),
    } });
    assert.deepEqual([posts, reads], [[], []], flag);
    assert.equal(rows[0].verdict, 'fresh');
  }
});

ct('evaluatePr #11350: a replay classifies the tested merge diff before the live file list', () => {
  const judge = (capped) => evaluatePr(fakeIo({
    prFiles: () => ['docs/guide/a.md'],
    prMeasurement: () => ({ runId: 42, testedBase: 'old-base', mergeSha: 'old-merge', families: [fam(900)] }),
    movedSince: (base, tip) => {
      assert.equal(base, 'old-base');
      return { capped, files: tip === 'old-merge' ? ['rust/core/src/a.rs'] : ['rust/core/src/b.rs'] };
    },
  }), { pr: 5, prRun: 42, headSha: 'now', mainTip: 'tip', ceilings, globs });
  assert.equal(judge(false).rust.verdict, 'stale');
  assert.equal(judge(true).verdict, 'unknown');
});

// Review round 6 (PR #11350).

ct('evaluatePr: an unreadable main measurement makes perf unknown but still judges Rust', () => {
  const io = fakeIo({
    prFiles: () => ['rust/core/src/a.rs'],
    mainMeasurementAt: () => { throw new Error('HTTP 502'); },
    movedSince: () => ({ files: ['rust/core/src/b.rs'], commits: 3, capped: false }),
  });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 'tip00000001', ceilings, globs });
  assert.equal(r.perf.verdict, 'unknown');
  assert.equal(r.rust.verdict, 'stale', 'the Rust overlap is judged despite the perf fault');
  assert.equal(r.verdict, 'stale');
  assert.deepEqual(r.rust.overlap, ['rust/core']);
});

ct('evaluatePr: a budget cut while reading main still stops the PR as not judged', () => {
  const io = fakeIo({ mainMeasurementAt: () => { throw new BudgetError('the tested-tree artifact of base0000001'); } });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 'tip00000001', ceilings, globs });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.budget, true);
});

ct('io: a newer bundle-only run does not hide an older run that measured every family', () => {
  const byRun = { 9: [fam(1)], 8: [fam(2), fam(3)], 7: [fam(4), fam(5)] };
  const asked = [];
  const picked = pickTreeMeasurement([9, 8, 7], (id) => { asked.push(id); return byRun[id] ?? null; }, 2);
  assert.deepEqual([picked.runId, picked.full], [8, true]);
  assert.deepEqual(asked, [9, 8], 'stops at the first complete one');
  const partial = pickTreeMeasurement([9, 6], (id) => byRun[id] ?? null, 2);
  assert.deepEqual([partial.runId, partial.full], [9, false], 'no complete run: the newest partial one');
  assert.equal(pickTreeMeasurement([6], () => null, 2), null);
});

ct('io: a candidate list at the limit is reported as capped', () => {
  const many = Array.from({ length: CANDIDATE_LIMIT }, (_, i) => ({ number: i + 1, headRefOid: `h${i}`, isDraft: i === 0, isCrossRepository: false }));
  const full = candidateList(many);
  assert.equal(full.capped, true);
  assert.equal(full.prs.length, CANDIDATE_LIMIT - 1, 'drafts are dropped after the cap is judged');
  assert.equal(candidateList(many.slice(1)).capped, false);
});

ct('run, rollback: a capped candidate list does not mark the rollback done', () => {
  const { saved, reads } = runFake({ gate: 'shadow', cacheData: { version: 1, lastMode: 'on' }, ioOver: { queueCandidates: () => ({ prs: [STALE_PR], capped: true }) } });
  assert.deepEqual(reads, ['head5']);
  assert.equal(saved.lastMode, 'on');
});

/** A createIo over a fake `gh`: `routes` maps an API path prefix to its JSON. */
function ioOverGh(routes, options = {}) {
  const paths = [];
  const fakeGh = (args) => {
    const path = args[0] === 'api' ? args[1] : args.join(' ');
    paths.push(path);
    // @source-text-assertion-ok Dispatches fake GitHub CLI requests by API route.
    for (const [prefix, answer] of routes) if (path.startsWith(prefix)) return typeof answer === 'function' ? answer(path) : answer;
    throw new Error(`unexpected gh call ${path}`);
  };
  return { io: createIo({ repo: 'o/r', gh: fakeGh, cwd: tmpdir(), ...options }), paths };
}

ct('io #11350: PR measurement cache follows completed attempts of the same run', (t) => {
  const head = 'a'.repeat(40);
  const merges = ['b'.repeat(40), 'c'.repeat(40)];
  const bases = ['d'.repeat(40), 'e'.repeat(40)];
  const timestamp = (minute) => `2026-11-28T00:${minute}:00Z`;
  const run = { id: 42, status: 'completed', run_attempt: 1, run_started_at: timestamp('00'), updated_at: timestamp('10'),
    event: 'pull_request', path: '.github/workflows/test.yml', head_sha: head, head_repository: { id: 7 },
    pull_requests: [{ number: 5, base: { ref: 'main' } }] };
  const forkRun = { ...run, id: 43, head_repository: { id: 8 }, pull_requests: [] };
  const otherForkRun = { ...forkRun, id: 44, head_repository: { id: 9 } };
  let listedRuns = [run];
  const attempt2 = { ...run, run_attempt: 2, run_started_at: timestamp('20'), updated_at: timestamp('30') };
  const bundle = (id, minute) => ({ name: 'perf-ratchet-measured', id, created_at: timestamp(minute) });
  const firstBundle = bundle(1, '05');
  const secondBundle = bundle(2, '25');
  let artifacts = [firstBundle];
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-attempt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { io } = ioOverGh([
    ['repos/o/r/actions/workflows/test.yml/runs?', () => ({ workflow_runs: listedRuns })],
    ['repos/o/r/actions/runs/42/artifacts?', () => ({ artifacts, total_count: artifacts.length })],
    ['repos/o/r/actions/runs/42/attempts/2', attempt2],
    ['repos/o/r/actions/runs/43/artifacts?', { artifacts: [bundle(43, '05')], total_count: 1 }],
    ['repos/o/r/actions/runs/44/artifacts?', { artifacts: [bundle(44, '05')], total_count: 1 }],
    ['repos/o/r/actions/runs/42', run],
    ['repos/o/r/actions/runs/43', forkRun],
    ...merges.map((merge, i) => [`repos/o/r/commits/${merge}`, { parents: [{ sha: bases[i] }, { sha: head }] }]),
  ], {
    spawn: (file, args) => {
      assert.equal(file, 'gh');
      const artifactId = Number(args[1].split('/').at(-2));
      assert.ok([run.run_attempt, 43, 44].some((id) => id === artifactId));
      const i = artifactId === 1 ? 0 : 1;
      writeFileSync(join(dir, 'measured.json'), JSON.stringify({
        family: 'bundle', commit: merges[i], measuredAt: '2026-11-28T00:00:00Z',
        metrics: [{ id: 'bytes', value: i + 10 }],
      }));
      return { status: 0, stdout: execFileSync('zip', ['-q', '-', 'measured.json'], { cwd: dir }) };
    },
  });
  const key = `${head}#5`;
  io.store.prMeasurements[key] = { runId: 42, testedBase: 'legacy' };
  const measure = () => io.prMeasurement(head, null, 5);
  listedRuns = [forkRun, otherForkRun];
  assert.equal(measure(), null);
  assert.equal(io.prMeasurement(head, null, 6), null);
  assert.equal(io.prMeasurement(head, 43, 5), null);
  assert.equal(io.prMeasurement(head, 42, 6), null);
  assert.equal(io.stats.downloads, 0);
  listedRuns = [run, forkRun, otherForkRun];
  const first = measure();
  assert.equal(first.testedBase, bases[0]);
  assert.equal(first.runAttempt, 1);
  assert.equal(measure(), first);
  run.run_attempt = 2;
  run.status = 'in_progress';
  assert.equal(measure(), null);
  run.status = 'completed';
  const oldNative = { name: 'perf-ratchet-measured-native', id: 3, created_at: timestamp('06') };
  artifacts = [oldNative, firstBundle];
  assert.equal(measure(), null, 'a partial rerun with only prior-attempt artifacts has no measurement');
  artifacts = [bundle(4, '26'), secondBundle, firstBundle];
  assert.equal(measure(), null, 'two bundles in the same attempt are ambiguous');
  artifacts = [bundle(4, '20'), firstBundle];
  assert.equal(measure(), null, 'an upload at the attempt boundary is ambiguous');
  artifacts = [secondBundle, oldNative, firstBundle];
  const second = measure();
  assert.equal(second.testedBase, bases[1]);
  assert.equal(second.runAttempt, 2);
  assert.equal(second.families[0].metrics[0].value, 11);
  assert.equal(second.families.length, 1, 'a prior-attempt native upload cannot supplement a fresh bundle');
  assert.equal(measure(), second);
  assert.equal(io.stats.downloads, 2);
  assert.equal(io.stats.cacheHits, 2);
  delete io.store.prMeasurements[key];
  artifacts.reverse();
  assert.deepEqual(measure(), second, 'listing order does not determine the selected artifact');
  assert.equal(io.prMeasurement('different-live-head', 42, 5).testedBase, bases[1], 'attributed replay uses the run’s historical head');
});

ct('io #11350: main measurements require a bundle and a measured tree matching the marker', (t) => {
  const requested = 'a'.repeat(40);
  const measured = 'b'.repeat(40);
  const tree = 'c'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = { status: 'completed', run_attempt: 2, run_started_at: '2026-11-28T00:20:00Z', updated_at: '2026-11-28T00:30:00Z' };
  const marker = { id: 1, created_at: '2026-11-28T00:05:00Z', workflow_run: { id: 42, repository_id: 9, head_repository_id: 9 } };
  const artifacts = ['perf-ratchet-measured', 'perf-ratchet-measured-native'].map((name, i) => ({
    name, id: i + 2, created_at: '2026-11-28T00:25:00Z',
  }));
  const setup = (measuredTree, { emptyBundle = false, badIds = [], older = false } = {}) => {
    const invalidArtifacts = new Set(badIds);
    const newer = { ...marker, id: 2, workflow_run: { ...marker.workflow_run, id: 43 } };
    const { io } = ioOverGh([
      [`repos/o/r/git/commits/${requested}`, { tree: { sha: tree } }],
      [`repos/o/r/git/commits/${measured}`, { tree: { sha: measuredTree } }],
      [`repos/o/r/actions/artifacts?name=tested-tree-${tree}`, { artifacts: older ? [newer, marker] : [marker] }],
      ['repos/o/r/actions/runs/42/artifacts?', { artifacts, total_count: artifacts.length }],
      ['repos/o/r/actions/runs/43/artifacts?', { artifacts: [{ ...artifacts[0], id: 4 }], total_count: 1 }],
      ['repos/o/r/actions/workflows/test.yml/runs?', { workflow_runs: [{ ...run, id: 42, pull_requests: [{ number: 5, base: { ref: 'main' } }] }] }],
      [`repos/o/r/commits/${measured}`, { parents: [{ sha: 'base0000001' }, { sha: 'head5' }] }],
      ['repos/o/r/actions/runs/42', run],
      ['repos/o/r/actions/runs/43', run],
    ], {
      spawn: (_file, args) => {
        const id = Number(args[1].split('/').at(-2));
        const bundle = id !== 3;
        const file = bundle && emptyBundle ? 'README.txt' : 'measurement.json';
        writeFileSync(join(dir, file), file === 'README.txt' ? '' : invalidArtifacts.has(id) ? '{}' : JSON.stringify({
          family: bundle ? 'bundle' : 'native-instructions', commit: measured,
          measuredAt: run.run_started_at, metrics: [{ id: 'eager', value: 10 }],
        }));
        return { status: 0, stdout: execFileSync('zip', ['-q', '-', file], { cwd: dir }) };
      },
    });
    return io;
  };
  const check = (measuredTree, options) => {
    const io = setup(measuredTree, options);
    return { result: io.mainMeasurementAt(requested), downloads: io.stats.downloads };
  };
  assert.deepEqual(check('d'.repeat(40)), { result: null, downloads: 2 });
  assert.deepEqual(check(tree, { emptyBundle: true }), { result: null, downloads: 1 });
  const { result, downloads } = check(tree);
  assert.equal(downloads, 2);
  assert.equal(result.sha, requested);
  assert.deepEqual(result.families.map((m) => m.family), ['bundle', 'native-instructions']);
  assert.equal(check(tree, { older: true, badIds: [4] }).result.runId, 42, 'an invalid newest bundle does not hide an older valid run');
  assert.throws(() => check(tree, { badIds: [2] }), /invalid measured file/);
  const limited = setup(tree, { older: true, badIds: [4] });
  limited.setBudget(5);
  assert.throws(() => limited.mainMeasurementAt(requested), BudgetError);

  const brokenNative = setup(tree, { badIds: [3] });
  const evidence = evaluatePr({
    ...fakeIo({ prFiles: () => ['rust/core/src/a.rs'], movedSince: () => ({ files: ['rust/core/src/b.rs'], commits: 1, capped: false }) }),
    prMeasurement: brokenNative.prMeasurement,
  }, { pr: 5, headSha: 'head5', mainTip: 'tip00000001', ceilings, globs });
  assert.equal(evidence.perf.verdict, 'unknown');
  assert.equal(evidence.rust.verdict, 'stale', 'the valid bundle still establishes the tested base');
  assert.deepEqual(evidence.rust.overlap, ['rust/core']);
});

ct('io: the in-run markers are paged past the first 100', () => {
  const own = (sha) => ({ workflow_run: { id: 1, repository_id: 9, head_repository_id: 9, head_sha: sha } });
  const page = (n) => Array.from({ length: n }, (_, i) => own(`p${n}-${i}`));
  const { io, paths } = ioOverGh([[`repos/o/r/actions/artifacts?name=${IN_RUN_ON_ARTIFACT}`, (apiPath) => (apiPath.endsWith('page=1') ? { total_count: 130, artifacts: page(100) } : { total_count: 130, artifacts: page(30) })]]);
  const heads = io.inRunOnHeads();
  assert.equal(heads.size, 130);
  assert.ok(heads.has('p30-29'), 'a marker on the second page is found');
  assert.equal(paths.length, 2);
});

ct('io: an in-run marker list that cannot be read whole throws (the caller then reads every head)', () => {
  const own = { workflow_run: { id: 1, repository_id: 9, head_repository_id: 9, head_sha: 'x' } };
  const { io } = ioOverGh([['repos/o/r/actions/artifacts', { total_count: 1000, artifacts: Array(100).fill(own) }]]);
  assert.throws(() => io.inRunOnHeads(), /more than 500 in-run markers/);
  const short = ioOverGh([['repos/o/r/actions/artifacts', { total_count: 5, artifacts: [own] }]]).io;
  assert.throws(() => short.inRunOnHeads(), /listed 1 of 5 in-run markers/);
});

ct('io: a PR file list is refused when the head moves or the PR is retargeted during the read', () => {
  const files = [{ filename: 'rust/core/src/a.rs' }];
  const at = (sha, ref, base = 'b1') => ioOverGh([['repos/o/r/pulls/5/files', files], ['repos/o/r/pulls/5', { head: { sha }, base: { ref, sha: base } }]]).io;
  assert.throws(() => at('h2', 'main').prFiles(5, 'h1', 'main', 'b1'), /PR #5 moved to h2/);
  assert.throws(() => at('h1', 'release').prFiles(5, 'h1', 'main', 'b1'), /PR #5 was retargeted to release/);
  const changed = at('h1', 'main', 'b2');
  assert.throws(() => changed.prFiles(5, 'h1', 'main', 'b1'), /base advanced/);
  assert.deepEqual(changed.store.prFiles, {}, 'a racing read is never cached');
  const io = at('h1', 'main');
  assert.deepEqual(io.prFiles(5, 'h1', 'main'), ['rust/core/src/a.rs']);
  assert.deepEqual(io.store.prFiles, { 'h1#5@main': { baseSha: 'b1', files: ['rust/core/src/a.rs'] } });
  const retargeted = at('h1', 'ci/stack-parent');
  Object.assign(retargeted.store.prFiles, io.store.prFiles);
  assert.throws(() => retargeted.prFiles(5, 'h1', 'main', 'b1'), /PR #5 was retargeted to ci\/stack-parent/);
});

ct('io: an unchanged PR head can change relevance when the base lands its ancestor (#11350)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'base-stale-stack-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'rust/core'), { recursive: true });
  const rust = join(dir, 'rust/core/a.rs');
  writeFileSync(rust, 'fn old() {}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  let base = git('rev-parse', 'HEAD');
  writeFileSync(rust, 'fn new() {}\n');
  git('commit', '-qam', 'lower stack changes Rust');
  const ancestor = git('rev-parse', 'HEAD');
  writeFileSync(rust, 'fn old() {}\n');
  writeFileSync(join(dir, 'README.md'), 'upper stack edits docs\n');
  git('add', '-A');
  git('commit', '-qm', 'upper stack reverts Rust and edits docs');
  const head = git('rev-parse', 'HEAD');
  const { io } = ioOverGh([
    ['repos/o/r/pulls/5/files', () => git('diff', '--name-only', `${base}...${head}`).split('\n').map(filename => ({ filename }))],
    ['repos/o/r/pulls/5', () => ({ head: { sha: head }, base: { ref: 'main', sha: base } })],
  ]);
  io.store.prFiles[`${head}#5@main`] = ['README.md']; // old cache format has no revision
  const relevance = () => {
    const { rust, perf } = prRelevance(io.prFiles(5, head, 'main', base), globs);
    return [rust, perf];
  };
  assert.deepEqual(relevance(), [false, false]);
  base = ancestor;
  assert.deepEqual(relevance(), [true, true]);
  assert.deepEqual(relevance(), [true, true]);
  assert.equal(io.stats.cacheHits, 1, 'a stable base snapshot still hits the cache');
});

ct('run, rollback: a rollback cut short resumes past the heads it already released', () => {
  const second = { ...STALE_PR, number: 7, headRefOid: 'head7' };
  let n = 0;
  const first = runFake({
    gate: 'shadow',
    cacheData: { version: 1, lastMode: 'on' },
    prs: [STALE_PR, second],
    ioOver: { prFiles: () => { n += 1; if (n === 1) return ['apps/viewer/src/a.ts']; throw new BudgetError('files of PR #7'); } },
  });
  assert.deepEqual(first.reads, ['head5']);
  assert.equal(first.saved.lastMode, 'on');
  assert.deepEqual(first.saved.released, { head5: true });
  const next = runFake({ gate: 'shadow', cacheData: first.saved, prs: [STALE_PR, second] });
  assert.deepEqual(next.reads, ['head7'], 'the released head is not read again');
  assert.equal(next.saved.lastMode, 'shadow');
  assert.deepEqual(next.saved.released, {}, 'a settled rollback keeps no progress');
});

ct('run, rollback: a released head judged with the gate on since is read again', () => {
  const { reads } = runFake({
    gate: 'shadow',
    cacheData: { version: 1, lastMode: 'on', released: { head5: true } },
    ioOver: { inRunOnHeads: () => new Set(['head5']) },
  });
  assert.deepEqual(reads, ['head5']);
});
