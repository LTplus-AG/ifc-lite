// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// scripts/ci-base-stale.mjs: argument parsing, the path filters it derives
// from the real test.yml, and the per-PR evaluation over a fake I/O layer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluatePr, parseArgs, readFilterGlobs } from './ci-base-stale.mjs';
import { matchesAny } from './lib/ci-path-coverage.mjs';

const WORKFLOW = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');

test('parseArgs: the three modes and their required inputs', () => {
  assert.equal(parseArgs(['--sweep']).mode, 'sweep');
  assert.deepEqual({ ...parseArgs(['--pr', '12']) }, { mode: 'pr', pr: 12, dryRun: false });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--in-run', '--pr', '3']), /--head-sha, --merge-sha and --measured-dir/);
  assert.throws(() => parseArgs(['--pr', 'x']), /--pr <n> is required/);
  assert.throws(() => parseArgs(['--sweep', '--bogus']), /unknown option/);
});

test('the filters come from test.yml: the perf-ratchet job gates on rust, frontend and perf_ratchet', () => {
  const { perfGlobs, rustGlobs } = readFilterGlobs(WORKFLOW);
  assert.ok(rustGlobs.includes('rust/**'));
  assert.ok(perfGlobs.includes('rust/**'), 'Rust inputs move the bundle and native ratchets');
  assert.ok(perfGlobs.includes('tests/perf-ratchets/**'));
  // This script and its decision core are inputs of the job whose last step runs them.
  for (const f of ['scripts/ci-base-stale.mjs', 'scripts/lib/base-stale.mjs', 'scripts/lib/base-stale-io.mjs']) {
    assert.ok(matchesAny(f, perfGlobs), `${f} must trigger the perf-ratchet job`);
  }
});

test('readFilterGlobs refuses a perf-ratchet job it cannot read the gate of', () => {
  assert.throws(() => readFilterGlobs(WORKFLOW.replace(/\n {2}perf-ratchet:\n/, '\n  perf-ratchet-renamed:\n')), /no perf-ratchet job/);
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

test('evaluatePr: main grew past the ceiling since the PR measured -> stale', () => {
  const r = evaluatePr(fakeIo(), { pr: 1, headSha: 'h', mainTip: 'tip00000001', ceilings, globs });
  assert.equal(r.verdict, 'stale');
  assert.equal(r.testedBase, 'base0000001');
  assert.equal(r.prRun, 7);
});

test('evaluatePr: main has not moved -> zero drift by construction, no main lookups', () => {
  const io = fakeIo({
    mainMeasurementAt: () => { throw new Error('must not look up main'); },
    latestMainMeasurement: () => { throw new Error('must not look up main'); },
  });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 'base0000001', ceilings, globs });
  assert.equal(r.verdict, 'fresh');
});

test('evaluatePr: in-run measurement with an unreadable base is unknown, not fresh', () => {
  const io = fakeIo({ mergeParents: () => null });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs, measured: { families: [fam(10)], mergeSha: 'm' } });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reasons[0], /base could not be read/);
});

test('evaluatePr: no measurement for a relevant PR is unknown', () => {
  const r = evaluatePr(fakeIo({ prMeasurement: () => null }), { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs });
  assert.equal(r.verdict, 'unknown');
});

test('evaluatePr: an irrelevant PR is not-relevant without reading any measurement', () => {
  const io = fakeIo({ prFiles: () => ['docs/a.md'], prMeasurement: () => { throw new Error('must not read'); } });
  assert.equal(evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs }).verdict, 'not-relevant');
});

test('evaluatePr: an I/O fault becomes an unknown verdict naming it, never a throw or a pass', () => {
  const io = fakeIo({ prFiles: () => { throw new Error('HTTP 502\nmore'); } });
  const r = evaluatePr(io, { pr: 1, headSha: 'h', mainTip: 't', ceilings, globs });
  assert.equal(r.verdict, 'unknown');
  assert.deepEqual(r.reasons, ['harness: HTTP 502']);
});

test('evaluatePr: the Rust half uses the same tested base', () => {
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
