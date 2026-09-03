/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the #3726 base-freshness signal.
 *
 * The two replay cases are the incident itself, taken from the merged file
 * lists of #3668, #3689 and #3686, not invented: if the rule cannot say STALE
 * for those it does not address the issue it cites.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recordedFiles,
  discoverSnapshots,
  evaluateFreshness,
  formatSweepSummary,
  formatVerdict,
  rowsChangedInPatch,
} from './lib/base-freshness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'check-base-freshness.mjs');
const REPO_ROOT = resolve(HERE, '..');

const ALLOWLIST = 'scripts/module-size-allowlist.txt';

/** The rows #3689 wrote, and the files #3668 had already grown past them. */
const GROWN_BY_3668 = [
  'scripts/review/run-reviewer.mjs',
  'scripts/review/build-context-pack.mjs',
  'scripts/review/build-review-input.mjs',
];

const snapshotWith = (inputs) => [{ path: ALLOWLIST, inputs: new Set(inputs) }];

test('#3726: recordedFiles takes the row, not the paths cited in its note', () => {
  const text = [
    '# see scripts/check-module-size.mjs for the gate',
    '   524 apps/viewer-embed/src/bridge/handler.ts',
    'packages/data/x.test.ts   # compares against tools/other/thing.ts',
    '',
  ].join('\n');
  const files = recordedFiles(text, (p) =>
    ['apps/viewer-embed/src/bridge/handler.ts', 'packages/data/x.test.ts', 'scripts/check-module-size.mjs', 'tools/other/thing.ts'].includes(p)
  );
  assert.deepEqual(
    [...files].sort(),
    ['apps/viewer-embed/src/bridge/handler.ts', 'packages/data/x.test.ts']
  );
});

test('#3726: discoverSnapshots keeps path-recording snapshots and drops the rest', () => {
  const tree = {
    'scripts/module-size-allowlist.txt': '  427 scripts/review/run-reviewer.mjs\n',
    'tests/benchmark/baseline.json': '{ "AC20-FZK-Haus.ifc": { "timestamp": "x" } }',
    'scripts/check-module-size.mjs': 'not a snapshot, wrong extension',
    'scripts/review/run-reviewer.mjs': 'source',
  };
  const found = discoverSnapshots({
    trackedFiles: Object.keys(tree),
    readFile: (p) => tree[p],
    isRepoFile: (p) => p in tree,
  });
  assert.deepEqual(
    found.map((s) => s.path),
    ['scripts/module-size-allowlist.txt']
  );
  assert.deepEqual([...found[0].inputs], ['scripts/review/run-reviewer.mjs']);
});

test('#3726: the discovery scan finds this repo\'s real snapshots', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  const found = discoverSnapshots({
    trackedFiles: tracked,
    readFile: (p) => readFileSync(join(REPO_ROOT, p), 'utf8'),
    isRepoFile: (p) => {
      try {
        return statSync(join(REPO_ROOT, p)).isFile();
      } catch {
        return false;
      }
    },
  });
  // The gate refuses to run below three; a scan that silently found nothing is
  // the failure mode this asserts against.
  assert.ok(found.length >= 3, `expected >= 3 snapshots, found ${found.length}`);
  assert.ok(found.some((s) => s.path === ALLOWLIST));
});

test('#3726 replay: #3689 re-recorded the allowlist on a tree that predated #3668', () => {
  const result = evaluateFreshness({
    // #3689's own diff.
    prFiles: [
      'scripts/check-module-size.mjs',
      'scripts/check-module-size.test.mjs',
      'scripts/lib/module-size-ratchet.mjs',
      'scripts/lib/module-size-ratchet.test.mjs',
      ALLOWLIST,
    ],
    // What #3668 landed on main between #3689's run and its merge.
    movedFiles: [...GROWN_BY_3668, '.github/workflows/claude-review.yml'],
    snapshots: snapshotWith(GROWN_BY_3668),
  });
  assert.equal(result.stale, true);
  assert.equal(result.couplings[0].direction, 'pr-recorded');
  assert.deepEqual(result.couplings[0].overlap.sort(), [...GROWN_BY_3668].sort());
});

test('#3726 replay: #3686 grew allowlisted files after #3689 re-recorded the allowlist', () => {
  const result = evaluateFreshness({
    // #3686's own diff (the part the allowlist pins).
    prFiles: [
      'scripts/review/run-reviewer.mjs',
      'scripts/review/rubric-eval.mjs',
      'scripts/review/post-review.mjs',
      '.github/workflows/claude-review.yml',
    ],
    // #3689 landed the allowlist rewrite in between, moving run-reviewer's row.
    movedFiles: [ALLOWLIST, 'scripts/check-module-size.mjs'],
    snapshots: snapshotWith(GROWN_BY_3668),
    rowsChangedOnMain: new Map([[ALLOWLIST, new Set(GROWN_BY_3668)]]),
  });
  assert.equal(result.stale, true);
  assert.equal(result.couplings[0].direction, 'main-recorded');
  assert.deepEqual(result.couplings[0].overlap, ['scripts/review/run-reviewer.mjs']);
});

test('#3726: rowsChangedInPatch reads the moved rows, not the diff context', () => {
  const patch = [
    '@@ -1,4 +1,4 @@',
    ' # header mentioning scripts/check-module-size.mjs',
    '-  427 scripts/review/run-reviewer.mjs',
    '+  513 scripts/review/run-reviewer.mjs',
    '   524 apps/viewer-embed/src/bridge/handler.ts',
  ].join('\n');
  const rows = rowsChangedInPatch(patch, () => true);
  assert.deepEqual([...rows], ['scripts/review/run-reviewer.mjs']);
});

test("#3726: main re-recording a row for ANOTHER file is not this PR's problem", () => {
  // The measured cost of getting this wrong: with whole-file granularity, the
  // #3723 allowlist re-record flagged 21 of 55 open PRs, none of whose files
  // had a row moved.
  const result = evaluateFreshness({
    prFiles: ['apps/viewer/src/components/viewer/CesiumOverlay.tsx'],
    movedFiles: [ALLOWLIST],
    snapshots: snapshotWith([
      ...GROWN_BY_3668,
      'apps/viewer/src/components/viewer/CesiumOverlay.tsx',
    ]),
    rowsChangedOnMain: new Map([[ALLOWLIST, new Set(GROWN_BY_3668)]]),
  });
  assert.equal(result.stale, false);
});

test('#3726: an unreadable snapshot patch falls back to the whole pinned set', () => {
  // GitHub omits `patch` on a large file. Over-reporting is arguable in review;
  // an omission would be silent, so the fallback goes the loud way.
  const result = evaluateFreshness({
    prFiles: ['apps/viewer/src/components/viewer/CesiumOverlay.tsx'],
    movedFiles: [ALLOWLIST],
    snapshots: snapshotWith([
      ...GROWN_BY_3668,
      'apps/viewer/src/components/viewer/CesiumOverlay.tsx',
    ]),
    rowsChangedOnMain: new Map(),
  });
  assert.equal(result.stale, true);
  assert.equal(result.couplings[0].direction, 'main-recorded');
});

test('#3726: two re-records of the same snapshot from two trees are coupled', () => {
  const result = evaluateFreshness({
    prFiles: [ALLOWLIST],
    movedFiles: [ALLOWLIST],
    snapshots: snapshotWith(GROWN_BY_3668),
    rowsChangedOnMain: new Map([[ALLOWLIST, new Set()]]),
  });
  assert.equal(result.stale, true);
  assert.equal(result.couplings[0].direction, 'both-recorded');
  assert.match(
    formatVerdict({ pr: 1, baseSha: 'abc1234567', commitsBehind: 1, movedFileCount: 1, result }),
    /each re-recorded it, from two different trees/
  );
});

test('#3726: a moved base with no snapshot coupling is OK, however far it moved', () => {
  const result = evaluateFreshness({
    prFiles: ['apps/viewer/src/components/Thing.tsx', 'apps/viewer/src/components/Thing.test.tsx'],
    movedFiles: [...GROWN_BY_3668, ALLOWLIST],
    snapshots: snapshotWith(GROWN_BY_3668),
  });
  assert.equal(result.stale, false);
  assert.deepEqual(result.couplings, []);
});

test('#3726: a PR editing a pinned file is OK while main leaves that snapshot alone', () => {
  // This is the narrowing that makes the signal worth reading. Every open PR is
  // behind main, so "behind" alone would say STALE here too.
  const result = evaluateFreshness({
    prFiles: ['scripts/review/run-reviewer.mjs'],
    movedFiles: ['apps/viewer/src/components/Other.tsx', 'docs/guide/cli.md'],
    snapshots: snapshotWith(GROWN_BY_3668),
  });
  assert.equal(result.stale, false);
});

test('#3726: the two verdict lines are not confusable and both name the PR', () => {
  const base = { pr: 3689, baseSha: '463daae54bad7dd211108a4eeb0728f103400422', commitsBehind: 3, movedFileCount: 26 };
  const ok = formatVerdict({ ...base, result: { stale: false, couplings: [] } });
  const stale = formatVerdict({
    ...base,
    result: {
      stale: true,
      couplings: [{ snapshot: ALLOWLIST, direction: 'pr-recorded', overlap: GROWN_BY_3668 }],
    },
  });
  assert.match(ok, /^base-freshness: OK -- /);
  assert.match(stale, /^base-freshness: STALE -- /);
  assert.ok(!ok.includes('STALE'));
  for (const line of [ok, stale]) assert.match(line, /PR #3689/);
  assert.match(stale, /scripts\/review\/run-reviewer\.mjs/);
});

/** Exit codes, because a verdict nobody can act on in a script is not a gate. */
function runReplay(input) {
  const dir = mkdtempSync(join(tmpdir(), 'base-freshness-'));
  const file = join(dir, 'case.json');
  writeFileSync(file, JSON.stringify(input));
  try {
    const stdout = execFileSync('node', [CLI, '--from-json', file], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '' };
  }
}

test('#3726: the CLI exits 1 on STALE and 0 on OK', () => {
  const snapshots = [{ path: ALLOWLIST, inputs: GROWN_BY_3668 }];
  const stale = runReplay({
    pr: 3689,
    baseSha: '463daae54bad7dd211108a4eeb0728f103400422',
    commitsBehind: 3,
    prFiles: [ALLOWLIST],
    movedFiles: GROWN_BY_3668,
    snapshots,
  });
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /base-freshness: STALE/);

  const ok = runReplay({
    pr: 3689,
    baseSha: '463daae54bad7dd211108a4eeb0728f103400422',
    commitsBehind: 3,
    prFiles: ['apps/viewer/src/components/Thing.tsx'],
    movedFiles: GROWN_BY_3668,
    snapshots,
  });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /base-freshness: OK/);
});

test('#3726: an unevaluated PR is counted, and never labelled STALE', () => {
  // A base missing from the checkout is a failure to LOOK, not a verdict about
  // the PR. Two runs proved why this matters: from a `--depth 1` clone every
  // PR came back STALE and was told to "rebase and re-record", which is advice
  // about the wrong repository; and a sweep where all 35 PRs threw still
  // printed `0 of 35 open PR(s) STALE`, which reads exactly like a clean run.
  // So the count and the message are asserted together here.
  const line = formatSweepSummary({ stale: [3551], open: 36, unevaluated: [3610, 3205] });
  assert.match(line, /1 of 36 open PR\(s\) STALE/);
  assert.match(line, /2 COULD NOT BE EVALUATED \(3610, 3205\)/);
  assert.match(line, /not labelled/);

  const clean = formatSweepSummary({ stale: [], open: 36, unevaluated: [] });
  assert.match(clean, /0 of 36 open PR\(s\) STALE\./);
  assert.doesNotMatch(clean, /COULD NOT BE EVALUATED/);
});
