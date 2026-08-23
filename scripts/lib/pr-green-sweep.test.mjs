// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REPO,
  SEVERITY,
  SweepError,
  actionable,
  countRollup,
  disqualify,
  isStaleRun,
  severityOf,
  sweepPullRequests,
} from './pr-green-sweep.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

/** A PR with nothing wrong with it. Each test breaks exactly one field. */
const green = (overrides = {}) => ({
  number: 1,
  branch: 'fix/example',
  head: HEAD,
  headRepo: DEFAULT_REPO,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  runCount: 4,
  newestRunSha: HEAD,
  fail: 0,
  pending: 0,
  pass: 12,
  crState: 'REVIEWED',
  crReviewed: true,
  threads: 2,
  ...overrides,
});

test('a row with every signal healthy has no disqualifier', () => {
  assert.equal(disqualify(green()), null);
  assert.equal(severityOf(green()), SEVERITY.GREEN);
});

test('zero runs at head is a disqualifier even though fail and pending are both zero', () => {
  // The vacuous-pass shape. A PR that was DIRTY at push time never gets a run,
  // so statusCheckRollup is EMPTY -- and an empty rollup counts up to exactly
  // the same fail=0/pending=0 as a fully passing one.
  const row = green({ runCount: 0, newestRunSha: null, fail: 0, pending: 0, pass: 0 });
  const bad = disqualify(row);
  assert.ok(bad, 'zero runs with an empty rollup must not read as green');
  assert.equal(bad.severity, SEVERITY.NO_RUNS);
});

test('an unreadable run count is not treated as green', () => {
  // -1 is the "the runs API call failed" marker. Unknown must fail closed;
  // failing open here is the silent, terminal mistake.
  const bad = disqualify(green({ runCount: -1 }));
  assert.ok(bad);
  assert.equal(bad.severity, SEVERITY.NO_RUNS);
});

test('DIRTY disqualifies even with runs present and nothing failing', () => {
  const row = green({ mergeStateStatus: 'DIRTY', runCount: 6, fail: 0, pending: 0 });
  assert.equal(disqualify(row)?.severity, SEVERITY.DIRTY);
});

test('CONFLICTING mergeable disqualifies on its own', () => {
  // The two fields disagree in practice: mergeStateStatus lags while GitHub
  // recomputes. Either one alone is enough.
  const row = green({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' });
  assert.equal(disqualify(row)?.severity, SEVERITY.DIRTY);
});

test('a newest branch run against another commit is STALE', () => {
  const row = green({ newestRunSha: OLD_HEAD });
  assert.equal(isStaleRun(row), true);
  assert.equal(disqualify(row)?.severity, SEVERITY.STALE_RUN);
});

test('no branch run at all is not reported as stale', () => {
  // null means "the branch query returned nothing", which is a different claim
  // from "the newest run is against an older commit".
  assert.equal(isStaleRun(green({ newestRunSha: null })), false);
});

test('a fork PR disqualifies as not-ours regardless of its other columns', () => {
  const row = green({ headRepo: 'someone/ifc-lite', fail: 3, mergeStateStatus: 'DIRTY' });
  const bad = disqualify(row);
  assert.equal(bad?.severity, SEVERITY.NOT_OURS);
  assert.match(bad.reason, /not ours/);
});

test('not-ours sorts LAST while every other disqualifier sorts before green', () => {
  // The precedence order and the sort order deliberately disagree on this one
  // rank: a fork's row is not a task, so it must not head the report.
  const notOurs = severityOf(green({ headRepo: 'someone/ifc-lite' }));
  assert.ok(notOurs < severityOf(green()), 'a fork must sort below a healthy PR of ours');
  assert.ok(severityOf(green({ pending: 1 })) > notOurs);
});

test('disqualifier precedence is worst-first: DIRTY outranks runs, runs outrank stale', () => {
  const everything = green({
    mergeStateStatus: 'DIRTY',
    runCount: 0,
    newestRunSha: OLD_HEAD,
    fail: 5,
    crReviewed: false,
    crState: 'NO-REVIEW',
    pending: 3,
  });
  assert.equal(disqualify(everything)?.severity, SEVERITY.DIRTY);
  assert.equal(disqualify({ ...everything, mergeStateStatus: 'CLEAN' })?.severity, SEVERITY.NO_RUNS);
  assert.equal(
    disqualify({ ...everything, mergeStateStatus: 'CLEAN', runCount: 2 })?.severity,
    SEVERITY.STALE_RUN,
  );
  assert.equal(
    disqualify({ ...everything, mergeStateStatus: 'CLEAN', runCount: 2, newestRunSha: HEAD })
      ?.severity,
    SEVERITY.FAILING,
  );
  assert.equal(
    disqualify({
      ...everything, mergeStateStatus: 'CLEAN', runCount: 2, newestRunSha: HEAD, fail: 0,
    })?.severity,
    SEVERITY.UNREVIEWED,
  );
  assert.equal(
    disqualify({
      ...everything, mergeStateStatus: 'CLEAN', runCount: 2, newestRunSha: HEAD, fail: 0,
      crReviewed: true,
    })?.severity,
    SEVERITY.PENDING,
  );
});

test('an unreviewed PR is disqualified even with every check green', () => {
  const row = green({ crReviewed: false, crState: 'UNREVIEWED', threads: 0 });
  assert.equal(disqualify(row)?.severity, SEVERITY.UNREVIEWED);
});

test('actionable() excludes forks but keeps every disqualified PR of ours', () => {
  const rows = [
    green({ number: 1 }),
    green({ number: 2, headRepo: 'someone/ifc-lite', fail: 9 }),
    green({ number: 3, fail: 1 }),
  ];
  assert.deepEqual(actionable(rows).map((r) => r.number), [3]);
});

test('an EMPTY rollup counts identically to a fully passing one', () => {
  // Pinning the ambiguity this module exists to break: the counts alone cannot
  // tell the two apart, which is why runCount is a separate signal.
  assert.deepEqual(countRollup([]), { fail: 0, pending: 0, pass: 0 });
  assert.deepEqual(
    countRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]),
    { fail: 0, pending: 0, pass: 1 },
  );
});

test('countRollup treats an in-flight check as pending and a failure as failing', () => {
  const counts = countRollup([
    { status: 'IN_PROGRESS', conclusion: null },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
    { status: 'COMPLETED', conclusion: 'SKIPPED' },
    { state: 'PENDING' },
    { state: 'ERROR' },
  ]);
  assert.deepEqual(counts, { fail: 2, pending: 2, pass: 1 });
});

test('a CANCELLED check counts as failing, not as passing', () => {
  // A cancelled job renders as a red tick in the UI; it is not a pass.
  assert.deepEqual(
    countRollup([{ status: 'COMPLETED', conclusion: 'CANCELLED' }]),
    { fail: 1, pending: 0, pass: 0 },
  );
});

// --- the three refuse-to-pass-vacuously paths --------------------------------

/** A `gh` stub that answers each call from a table keyed by a substring. */
function stubGh(table) {
  return (argv) => {
    const joined = argv.join(' ');
    for (const [needle, answer] of table) {
      if (joined.includes(needle)) {
        if (typeof answer === 'function') return answer(joined);
        return answer;
      }
    }
    throw new Error(`unstubbed gh call: ${joined}`);
  };
}

const onePr = JSON.stringify([
  {
    number: 42,
    headRefName: 'fix/example',
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRepository: { name: 'ifc-lite' },
    headRepositoryOwner: { login: 'LTplus-AG' },
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  },
]);

test('zero pull requests is a hard failure, not a clean sweep', () => {
  const gh = stubGh([['pr list', '[]']]);
  assert.throws(
    () => sweepPullRequests({ gh }),
    (err) => {
      assert.ok(err instanceof SweepError);
      assert.equal(err.kind, 'empty');
      return true;
    },
    'an empty PR list must never return zero rows and a zero exit',
  );
});

test('an unreachable API is a hard failure with its own kind', () => {
  const gh = stubGh([['pr list', () => { throw new Error('connection refused'); }]]);
  assert.throws(
    () => sweepPullRequests({ gh }),
    (err) => {
      assert.ok(err instanceof SweepError);
      assert.equal(err.kind, 'unreachable');
      return true;
    },
  );
});

test('an unreachable API MID-sweep fails too, rather than dropping the row', () => {
  // The dangerous variant: the list succeeded, so a swallowed per-PR failure
  // would produce a shorter report that still looks complete.
  const gh = stubGh([
    ['pr list', onePr],
    ['actions/runs', () => { throw new Error('502 Bad Gateway'); }],
  ]);
  assert.throws(() => sweepPullRequests({ gh }), (err) => err.kind === 'unreachable');
});

test('a malformed (non-JSON) response is a hard failure', () => {
  const gh = stubGh([['pr list', '<html>rate limited</html>']]);
  assert.throws(
    () => sweepPullRequests({ gh }),
    (err) => {
      assert.ok(err instanceof SweepError);
      assert.equal(err.kind, 'malformed');
      return true;
    },
  );
});

test('an empty body is malformed, not an empty list', () => {
  const gh = stubGh([['pr list', '']]);
  assert.throws(() => sweepPullRequests({ gh }), (err) => err.kind === 'malformed');
});

test('a runs response with no numeric total_count is malformed, not zero runs', () => {
  // The difference matters: zero runs is a real verdict about the PR, while a
  // missing field is a broken sweep. Defaulting the field to 0 would report a
  // healthy PR as the vacuous-pass shape and vice versa.
  const gh = stubGh([
    ['pr list', onePr],
    ['actions/runs', '{"workflow_runs":[]}'],
  ]);
  assert.throws(() => sweepPullRequests({ gh }), (err) => err.kind === 'malformed');
});

test('a GraphQL response with no pullRequest node is malformed', () => {
  const gh = stubGh([
    ['pr list', onePr],
    [`head_sha=${HEAD}`, '{"total_count":3}'],
    ['branch=', `{"workflow_runs":[{"head_sha":"${HEAD}"}]}`],
    ['graphql', '{"data":{"repository":null}}'],
  ]);
  assert.throws(() => sweepPullRequests({ gh }), (err) => err.kind === 'malformed');
});

test('a full sweep of one healthy PR returns one row with no disqualifier', () => {
  const gh = stubGh([
    ['pr list', onePr],
    [`head_sha=${HEAD}`, '{"total_count":3}'],
    ['branch=', `{"workflow_runs":[{"head_sha":"${HEAD}"}]}`],
    ['graphql', JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { comments: { nodes: [{ author: { login: 'coderabbitai' }, createdAt: '2026-08-21T10:00:00Z' }] } },
              ],
            },
            reviews: { nodes: [] },
            commits: { nodes: [{ commit: { pushedDate: '2026-08-21T09:00:00Z', committedDate: null } }] },
          },
        },
      },
    })],
    ['issues/42/comments', '[]'],
  ]);
  const rows = sweepPullRequests({ gh });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, 42);
  assert.equal(rows[0].runCount, 3);
  assert.equal(rows[0].crReviewed, true, 'one CodeRabbit inline thread newer than the push is a review');
  assert.equal(disqualify(rows[0]), null);
});

test('the sweep reports a stale run and a DIRTY base from real response shapes', () => {
  const dirty = JSON.parse(onePr);
  dirty[0].mergeStateStatus = 'DIRTY';
  dirty[0].statusCheckRollup = [];
  const gh = stubGh([
    ['pr list', JSON.stringify(dirty)],
    [`head_sha=${HEAD}`, '{"total_count":0}'],
    ['branch=', `{"workflow_runs":[{"head_sha":"${OLD_HEAD}"}]}`],
    ['graphql', JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [] } } } },
    })],
    ['issues/42/comments', '[]'],
  ]);
  const rows = sweepPullRequests({ gh });
  assert.equal(rows[0].runCount, 0);
  assert.equal(isStaleRun(rows[0]), true);
  // DIRTY outranks both, so that is the reason reported.
  assert.equal(disqualify(rows[0])?.severity, SEVERITY.DIRTY);
  assert.equal(actionable(rows).length, 1);
});
