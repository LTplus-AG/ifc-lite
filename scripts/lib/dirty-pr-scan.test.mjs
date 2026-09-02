/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the pure half of the #3443 gate.
 *
 * Two fixtures anchor everything else: #3411 (live, `CONFLICTING`/`DIRTY`,
 * none of the 15 `test.yml` lanes present) must report, and #3417 (live,
 * also `CONFLICTING`, but all 15 lanes already ran before it went dirty) must
 * NOT -- distinguishing those two is the entire point of comparing lane NAMES
 * rather than a row-count floor. See scripts/lib/dirty-pr-scan.mjs.
 *
 * A third axis the row count cannot see either: WHY the lanes are missing.
 * #3411's real base is `fix-3353-snap-f32-invisible-floor`, so it is silent
 * because of `test.yml`'s `branches: [main]` filter as well as its conflict,
 * and only the retarget remedy works on it. The fixtures below keep a
 * `main`-based conflicted PR and a stacked one apart, and assert that each is
 * given the remedy that can actually restore a lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DirtyPrScanError,
  missingLanes,
  pullRequestBaseBranches,
  classifyPr,
  scanPrs,
  report,
} from './dirty-pr-scan.mjs';
import { matrixSkipAliases } from './pr-review-signal.mjs';

const REQUIRED = ['Lint', 'Node tests', 'Rust tests', 'Typecheck'];
const BASES = ['main'];

function lane(name) {
  return { name };
}

test('missingLanes: empty rollup means every required lane is missing', () => {
  assert.deepEqual(missingLanes(REQUIRED, []), [...REQUIRED].sort());
});

test('missingLanes: only names absent from the rollup are returned', () => {
  assert.deepEqual(missingLanes(REQUIRED, [lane('Lint'), lane('Typecheck')]), ['Node tests', 'Rust tests']);
});

test('missingLanes: falls back to `context` for commit-status style entries', () => {
  assert.deepEqual(missingLanes(['CodeRabbit'], [{ context: 'CodeRabbit' }]), []);
});

test('classifyPr: RED fixture -- CONFLICTING/DIRTY with no required lane present is silent', () => {
  // Shape of live PR #3411 the night #3443 was filed: Vercel/CodeRabbit rows
  // only, none of the compile/test lanes.
  const pr = {
    number: 3411,
    title: 'fix(core): order-independence',
    url: 'https://github.com/LTplus-AG/ifc-lite/pull/3411',
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    isDraft: false,
    statusCheckRollup: [lane('Vercel Agent Review'), lane('Vercel Preview Comments')],
  };
  const result = classifyPr(pr, REQUIRED, BASES);
  assert.equal(result.silent, true);
  assert.equal(result.rollupCount, 2);
  assert.deepEqual(result.missing, [...REQUIRED].sort());
});

test('classifyPr: GREEN fixture -- CONFLICTING but every required lane already ran is not silent', () => {
  // Shape of live PR #3417: went dirty AFTER its lanes ran. Row-counting alone
  // cannot separate this from #3411 -- #3417 had 40 rows, #3411 had 19 -- so
  // this must key off lane NAMES, not a count.
  const pr = {
    number: 3417,
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    isDraft: false,
    statusCheckRollup: REQUIRED.map(lane).concat([lane('Vercel Agent Review')]),
  };
  const result = classifyPr(pr, REQUIRED, BASES);
  assert.equal(result.silent, false);
  assert.deepEqual(result.missing, []);
});

test('classifyPr: GREEN fixture -- clean, mergeable PR with lanes missing is not this gate\'s finding', () => {
  // A missing lane on an otherwise-mergeable PR is a different problem (still
  // queued, a path filter, a real failure) -- out of scope on purpose.
  const pr = {
    number: 9001,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [],
  };
  const result = classifyPr(pr, REQUIRED, BASES);
  assert.equal(result.silent, false);
});

test('classifyPr: UNKNOWN mergeable with missing lanes is advisory, never silent', () => {
  const pr = {
    number: 9002,
    baseRefName: 'main',
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    statusCheckRollup: [],
  };
  const result = classifyPr(pr, REQUIRED, BASES);
  assert.equal(result.silent, false);
  assert.equal(result.unknownAdvisory, true);
});

test('classifyPr: fails closed on a PR object missing a numeric `number`', () => {
  assert.throws(() => classifyPr({ mergeable: 'CONFLICTING' }, REQUIRED, BASES), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'BAD_PR');
    return true;
  });
});

test('classifyPr: fails closed on an empty required set', () => {
  assert.throws(() => classifyPr({ number: 1 }, [], BASES), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'EMPTY_REQUIRED_SET');
    return true;
  });
});

test('scanPrs: fails closed on a non-array input rather than reading it as "no open PRs"', () => {
  assert.throws(() => scanPrs({ not: 'an array' }, REQUIRED, BASES), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'BAD_INPUT');
    return true;
  });
});

test('scanPrs + report: RED -- a scan containing the #3411 shape fails and names the PR', () => {
  const prs = [
    {
      number: 3411,
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: [lane('Vercel Agent Review')],
    },
    {
      number: 3417,
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: REQUIRED.map(lane),
    },
  ];
  const results = scanPrs(prs, REQUIRED, BASES);
  const { ok, lines } = report(results, REQUIRED, BASES);
  assert.equal(ok, false);
  assert.ok(lines.some((l) => l.includes('#3411')));
  assert.ok(!lines.some((l) => l.includes('#3417 ')));
});

test('scanPrs + report: GREEN -- an all-clean scan with lanes present passes', () => {
  const prs = [
    {
      number: 1,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: REQUIRED.map(lane),
    },
    {
      number: 2,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: REQUIRED.map(lane),
    },
  ];
  const results = scanPrs(prs, REQUIRED, BASES);
  const { ok, lines } = report(results, REQUIRED, BASES);
  assert.equal(ok, true);
  assert.ok(lines.some((l) => l.startsWith('✅')));
});

test('scanPrs + report: GREEN -- zero open PRs passes trivially', () => {
  const { ok, lines } = report(scanPrs([], REQUIRED), REQUIRED);
  assert.equal(ok, true);
  assert.ok(lines[0].includes('Scanned 0 open PR'));
});

test('classifyPr: RED -- a stacked PR is BASE_FILTERED, not CONFLICTED, even when it is also dirty', () => {
  // #3411's real shape: base `fix-3353-snap-f32-invisible-floor`. `test.yml`
  // fires `pull_request` only for `main`, so resolving the conflict restores
  // nothing -- the cause that survives the merge is the one to report.
  const pr = {
    number: 3411,
    baseRefName: 'fix-3353-snap-f32-invisible-floor',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [lane('Vercel Agent Review')],
  };
  const result = classifyPr(pr, REQUIRED, BASES);
  assert.equal(result.silent, true);
  assert.equal(result.cause, 'BASE_FILTERED');
});

test('classifyPr: RED -- a stacked PR that is perfectly mergeable is still silent', () => {
  // #3411 and #3405 both read MERGEABLE/CLEAN with 0 of 15 lanes: no conflict
  // anywhere, and no CI either. The conflict clause alone would miss them.
  const pr = {
    number: 3405,
    baseRefName: 'fix-3338-isolate-expansion-gate',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [lane('Vercel Agent Review')],
  };
  const result = classifyPr(pr, REQUIRED, BASES);
  assert.equal(result.silent, true);
  assert.equal(result.cause, 'BASE_FILTERED');
});

test('classifyPr: a stacked PR whose lanes are all present is not flagged', () => {
  const pr = {
    number: 3406,
    baseRefName: 'some-feature-branch',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: REQUIRED.map(lane),
  };
  assert.equal(classifyPr(pr, REQUIRED, BASES).cause, null);
});

test('classifyPr: a `main`-based conflicted PR is CONFLICTED, not BASE_FILTERED', () => {
  const pr = {
    number: 2931,
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [],
  };
  assert.equal(classifyPr(pr, REQUIRED, BASES).cause, 'CONFLICTED');
});

test('classifyPr: fails closed rather than guessing when `baseRefName` is absent', () => {
  // Defaulting either way hands out a remedy that may not work -- which is the
  // defect this argument exists to remove.
  assert.throws(
    () => classifyPr({ number: 7, mergeable: 'CONFLICTING', statusCheckRollup: [] }, REQUIRED, BASES),
    (err) => {
      assert.ok(err instanceof DirtyPrScanError);
      assert.equal(err.reason, 'NO_BASE_REF');
      return true;
    },
  );
});

test('classifyPr: a workflow with no base filter (null) makes nothing base-filtered', () => {
  const pr = { number: 8, baseRefName: 'anything', mergeable: 'MERGEABLE', statusCheckRollup: [] };
  assert.equal(classifyPr(pr, REQUIRED, null).cause, null);
});

test('report: the stacked group gets the retarget remedy and NOT the resolve-the-conflict one', () => {
  const results = scanPrs(
    [
      {
        number: 3411,
        baseRefName: 'fix-3353-snap-f32-invisible-floor',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [],
      },
    ],
    REQUIRED,
    BASES,
  );
  const { ok, lines } = report(results, REQUIRED, BASES);
  const text = lines.join('\n');
  assert.equal(ok, false);
  assert.match(text, /#3411/);
  assert.match(text, /retarget the PR/i);
  assert.doesNotMatch(text, /only resolving the\s+conflict/i);
});

test('classifyPr: a stacked AND conflicted PR is flagged as needing both remedies', () => {
  const both = {
    number: 3411,
    baseRefName: 'fix-3353-snap-f32-invisible-floor',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [lane('Vercel Agent Review')],
  };
  assert.equal(classifyPr(both, REQUIRED, BASES).alsoConflicted, true);

  // The other direction, so the flag tracks the conflict rather than just the
  // base filter: #3405 is stacked and perfectly mergeable.
  const stackedOnly = {
    number: 3405,
    baseRefName: 'fix-3338-isolate-expansion-gate',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [lane('Vercel Agent Review')],
  };
  assert.equal(classifyPr(stackedOnly, REQUIRED, BASES).alsoConflicted, false);

  // And a `main`-based conflicted PR is not "also" anything -- it is the
  // CONFLICTED group, whose header already carries the resolve remedy.
  const conflictedOnly = {
    number: 2931,
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [],
  };
  assert.equal(classifyPr(conflictedOnly, REQUIRED, BASES).alsoConflicted, false);
});

test('report: RED -- the stacked AND conflicted PR carries the second remedy, not just the retarget', () => {
  // Following the retarget line alone on this shape restores no lane: the PR is
  // still DIRTY afterwards and GitHub fires no `pull_request` for it. The
  // stacked-only PR beside it must NOT pick the extra line up.
  const results = scanPrs(
    [
      {
        number: 3411,
        baseRefName: 'fix-3353-snap-f32-invisible-floor',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        statusCheckRollup: [],
      },
      {
        number: 3405,
        baseRefName: 'fix-3338-isolate-expansion-gate',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
      },
    ],
    REQUIRED,
    BASES,
  );
  const { lines } = report(results, REQUIRED, BASES);
  const text = lines.join('\n');
  assert.match(text, /retarget the PR/i);
  assert.equal(lines.filter((l) => /ALSO conflicted/i.test(l)).length, 1, text);
  assert.match(text, /resolve the conflict as well/i);
  const flagged = lines.findIndex((l) => /ALSO conflicted/i.test(l));
  assert.ok(lines[flagged - 2].includes('#3411'), text);
});

test('report: both causes present are reported as separate groups with separate remedies', () => {
  const results = scanPrs(
    [
      { number: 3411, baseRefName: 'a-feature-branch', mergeable: 'MERGEABLE', statusCheckRollup: [] },
      { number: 2931, baseRefName: 'main', mergeable: 'CONFLICTING', statusCheckRollup: [] },
    ],
    REQUIRED,
    BASES,
  );
  const { ok, lines } = report(results, REQUIRED, BASES);
  const text = lines.join('\n');
  assert.equal(ok, false);
  assert.match(text, /retarget the PR/i);
  assert.match(text, /only resolving the conflict/i);
});

// ------------------------------------- a matrix job skipped BEFORE expanding (#3584 shape)

/**
 * Verbatim shape of PR #3581's rollup: a matrix job skipped by `if:` before
 * its `strategy.matrix` fanned out publishes ONE check run, under the
 * unexpanded template, never the per-shard names. `expandJobNames` derives
 * `Viewer tests (shard 0)`..`(shard 3)`; this file's own `missingLanes` used
 * to compare those names against the rollup with plain Set membership, which
 * could never find them present -- a conflicted PR touching neither
 * `frontend` nor `rust` paths would report `CONFLICTED` even though every
 * lane the workflow actually publishes had run. See
 * scripts/lib/pr-review-signal.mjs's `matrixSkipAliases`/`missingLanes`.
 */
// The literal `${{ }}` below is DATA, not a template this file means to interpolate: it is what
// GitHub publishes as the check-run name for a matrix job skipped before it expanded.
// oxlint-disable-next-line no-template-curly-in-string
const MATRIX_TEMPLATE = 'Viewer tests (shard ${{ matrix.shard }})';
const MATRIX_WF = `on:
  pull_request:
jobs:
  viewer-tests:
    name: ${MATRIX_TEMPLATE}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - run: true
`;
const MATRIX_REQUIRED = [0, 1, 2, 3].map((n) => `Viewer tests (shard ${n})`);

test('missingLanes: a wholesale-skipped matrix job counts as present given its aliases', () => {
  const aliases = matrixSkipAliases(MATRIX_WF);
  const rollup = [{ name: MATRIX_TEMPLATE, state: 'skipped' }];
  assert.deepEqual(missingLanes(MATRIX_REQUIRED, rollup, aliases), []);
});

test('classifyPr: GREEN -- a PR whose matrix job skipped wholesale before expanding is not silent', () => {
  const pr = {
    number: 3581,
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [{ name: MATRIX_TEMPLATE, state: 'skipped' }],
  };
  const aliases = matrixSkipAliases(MATRIX_WF);
  const result = classifyPr(pr, MATRIX_REQUIRED, BASES, aliases);
  assert.equal(result.silent, false, 'every shard is covered by the wholesale-skip alias');
  assert.deepEqual(result.missing, []);
});

test('pullRequestBaseBranches: reads pull_request`s filter, not push`s', () => {
  assert.deepEqual(
    pullRequestBaseBranches('on:\n  push:\n    branches: [dev]\n  pull_request:\n    branches: [main]\njobs:\n'),
    ['main'],
  );
});

test('pullRequestBaseBranches: `pull_request:` with no `branches:` means no filter', () => {
  assert.equal(pullRequestBaseBranches('on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n'), null);
});

test('pullRequestBaseBranches: reads a block list', () => {
  assert.deepEqual(
    pullRequestBaseBranches('on:\n  pull_request:\n    branches:\n      - main\n      - release\n  push:\n    branches: [dev]\n'),
    ['main', 'release'],
  );
});

test('pullRequestBaseBranches: refuses a glob it cannot evaluate rather than guessing', () => {
  assert.throws(() => pullRequestBaseBranches('on:\n  pull_request:\n    branches: [main, "releases/**"]\n'), (err) => {
    assert.equal(err.reason, 'UNSUPPORTED_BRANCH_PATTERN');
    return true;
  });
});

test('pullRequestBaseBranches: fails closed on a workflow with no `pull_request` trigger', () => {
  assert.throws(() => pullRequestBaseBranches('on:\n  push:\n    branches: [main]\n'), (err) => {
    assert.equal(err.reason, 'NO_PULL_REQUEST_TRIGGER');
    return true;
  });
});
