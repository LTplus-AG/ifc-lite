// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Decide whether an open pull request is ACTUALLY green, across every signal a
 * green tick can hide.
 *
 * `scripts/lib/coderabbit-review-state.mjs` answers one of those questions --
 * did CodeRabbit read this diff -- and this module answers the rest, because a
 * sweep across 36 open PRs found four more shapes that all render as "green"
 * or as "nothing failing":
 *
 *   1. NOT OURS. `headRepositoryOwner.login` is somebody else's fork. Every
 *      other column is then a report about a branch we cannot push to, and
 *      acting on it is the wrong move regardless of what it says.
 *
 *   2. DIRTY WITH RUNS PRESENT. `mergeStateStatus == DIRTY` means the base no
 *      longer merges. The checks that are green ran against a merge commit that
 *      can no longer be formed, so the tick is about a diff that does not
 *      exist. Two PRs were in exactly this state during the sweep.
 *
 *   3. ZERO RUNS AT HEAD. A PR that was already DIRTY when the commit was
 *      pushed never gets a workflow run at all. `statusCheckRollup` is then
 *      EMPTY, and an empty rollup counts up as `fail=0, pending=0` -- which is
 *      indistinguishable from "everything passed" in any summary that only
 *      reports those two numbers. This is the vacuous-pass shape, and it is why
 *      `runCount` is a first-class signal here rather than a derived one.
 *
 *   4. STALE RUN. The newest run on the BRANCH is against a commit that is no
 *      longer the PR head. The rollup can still show green from that older
 *      commit while the current head has never been built.
 *
 * WHICH WAY TO FAIL WHEN A SIGNAL IS MISSING. Same asymmetry the review
 * classifier reasons from: a false "not green" costs one glance at the PR, a
 * false "green" is silent and terminal. So an unknown `runCount` (the API call
 * failed) is NOT treated as "probably fine", and a row that cannot be built at
 * all is a hard error rather than a skipped row -- see `sweepPullRequests`.
 *
 * This module is pure apart from the `gh` callable the caller injects, so the
 * whole sweep -- including its three refuse-to-pass-vacuously paths -- is
 * unit-testable against synthetic GitHub responses.
 */

import { classifyReviewState } from './coderabbit-review-state.mjs';

export const DEFAULT_REPO = 'LTplus-AG/ifc-lite';

/**
 * The `name:` of the workflow that IS the merge gate (`.github/workflows/test.yml:5`).
 * Matched against each CheckRun's `workflowName` in the rollup, so it is the
 * display name and not the file path.
 */
export const TEST_WORKFLOW_NAME = 'Test';

/**
 * Severity ranks, worst-actionable first. `NOT_OURS` is deliberately the
 * LOWEST rank even though it takes precedence as a disqualifier: it is the one
 * verdict that is not a task, so it sorts to the bottom of the report while
 * still suppressing every other column's claim about that row.
 */
export const SEVERITY = {
  DIRTY: 100,
  NO_RUNS: 90,
  STALE_RUN: 80,
  FAILING: 70,
  UNREVIEWED: 60,
  PENDING: 20,
  GREEN: 10,
  // Not a task, like NOT_OURS, and ranked separately from it ON PURPOSE: at a
  // shared rank the two verdicts alias under `===`, so a test asserting
  // NOT_OPEN would pass on a NOT_OURS row and pin nothing.
  NOT_OPEN: 1,
  NOT_OURS: 0,
};

/**
 * @typedef {{
 *   number: number,
 *   branch: string,
 *   head: string,
 *   headRepo: string,
 *   mergeable: string | null,
 *   mergeStateStatus: string | null,
 *   state: string | null,
 *   runCount: number,
 *   testLaneCount: number,
 *   newestRunSha: string | null,
 *   fail: number,
 *   pending: number,
 *   pass: number,
 *   crState: string,
 *   crReviewed: boolean,
 *   threads: number,
 * }} SweepRow
 */

/** Is the newest run on the branch against something other than the PR head? */
export function isStaleRun(row) {
  return Boolean(row.newestRunSha) && row.newestRunSha !== row.head;
}

/**
 * The single reason this PR is not ready, worst first, or null when it is.
 *
 * Order matters and is not arbitrary: each earlier reason invalidates the
 * later ones as evidence. A fork's check counts are not ours to read; a DIRTY
 * base means the green checks ran on a merge that cannot be formed; zero runs
 * means the `fail`/`pending` counts are empty rather than passing; a stale run
 * means they describe a commit that is no longer the head.
 *
 * @param {SweepRow} row
 * @param {string} repo `owner/name` of the repository we own.
 * @returns {{ severity: number, reason: string } | null}
 */
export function disqualify(row, repo = DEFAULT_REPO) {
  // FIRST, ahead of even NOT_OURS: a PR that is not open is not a merge
  // candidate, and every count below it describes history rather than a
  // merge. Measured on the #3315 row shape: `mergeable:'UNKNOWN'` with 39
  // passing runs disqualifies to `null` and scores SEVERITY.GREEN, because
  // `mergeable` reads UNKNOWN on a MERGED PR exactly as it does on one GitHub
  // has not finished computing. Today only `--state open` at the call site
  // keeps that row out of the report, which is the filter any `--pr N` entry
  // point would bypass.
  if (typeof row.state !== 'string' || row.state === '') {
    // ABSENCE IS NOT OPENNESS. A truthiness guard here (`row.state && ...`)
    // scores a row with no state GREEN, which is the fail-open this branch
    // exists to close, one level up: the producer always sets the field, so the
    // caller that arrives without it is the hand-built one this branch was
    // written for. Same bucket as an unreadable run count -- unknown is not
    // green.
    return { severity: SEVERITY.NO_RUNS, reason: 'state is missing - cannot show this PR is open' };
  }
  if (row.state.toUpperCase() !== 'OPEN') {
    return { severity: SEVERITY.NOT_OPEN, reason: `state=${row.state} - not an open merge candidate` };
  }
  if (row.headRepo !== repo) {
    return { severity: SEVERITY.NOT_OURS, reason: `not ours (head repo ${row.headRepo})` };
  }
  if (row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY') {
    // Note "with runs present" is NOT a precondition for reporting this. A
    // DIRTY base is disqualifying whether or not anything ran; runs present is
    // merely what makes it LOOK green, which is why it is worth its own row.
    return { severity: SEVERITY.DIRTY, reason: 'mergeStateStatus=DIRTY - base no longer merges' };
  }
  if (row.runCount < 0) {
    // The runs API could not be read. Unknown is not green.
    return { severity: SEVERITY.NO_RUNS, reason: 'workflow-run count could not be read' };
  }
  if (row.runCount === 0) {
    return {
      severity: SEVERITY.NO_RUNS,
      reason: 'zero workflow runs at head - an empty rollup, not a passing one',
    };
  }
  // `runCount` counts ANY workflow at the head, and the merge gate is one
  // specific workflow. Measured on #3315 at 66c8886b: five runs present
  // (ifcopenshell-parity x2, python-wheels, server-binaries, xmatch-fixture)
  // and test.yml among them ZERO times, so `runCount > 0` was true over a head
  // the test suite never examined. That is the #3294 shape wearing a non-zero
  // count.
  if (typeof row.testLaneCount !== 'number') {
    // `undefined === 0` is false, so an absent count sailed straight past the
    // branch below while the production path went dead. Measured: deleting
    // `testLaneCount` from the row constructor left 29 of 29 green. The sibling
    // `state` field had the identical hole and was fixed one field at a time
    // instead of as a class, which is how this one survived.
    return { severity: SEVERITY.NO_RUNS, reason: 'Test-lane count could not be read' };
  }
  if (row.testLaneCount === 0) {
    return {
      severity: SEVERITY.NO_RUNS,
      reason: 'no lane from the Test workflow at this head - the other workflows are not the merge gate',
    };
  }
  if (isStaleRun(row)) {
    return {
      severity: SEVERITY.STALE_RUN,
      reason: `newest run is against ${row.newestRunSha}, not the head ${row.head}`,
    };
  }
  if (row.fail > 0) return { severity: SEVERITY.FAILING, reason: `failing checks=${row.fail}` };
  if (!row.crReviewed) return { severity: SEVERITY.UNREVIEWED, reason: `CodeRabbit ${row.crState}` };
  if (row.pending > 0) return { severity: SEVERITY.PENDING, reason: `pending=${row.pending}` };
  return null;
}

/**
 * Rank a row for the report: worse sorts first, `not ours` sorts last.
 * @param {SweepRow} row
 */
export function severityOf(row, repo = DEFAULT_REPO) {
  return disqualify(row, repo)?.severity ?? SEVERITY.GREEN;
}

/**
 * Count a `statusCheckRollup` into pass/fail/pending.
 *
 * An EMPTY rollup counts to all zeros, which is why the caller must never read
 * `fail === 0` as green on its own -- `runCount` is the signal that separates
 * "nothing failed" from "nothing ran".
 */
export function countRollup(rollup) {
  let fail = 0;
  let pending = 0;
  let pass = 0;
  for (const check of rollup ?? []) {
    const status = String(check?.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      pending += 1;
      continue;
    }
    const verdict = String(check?.conclusion ?? check?.state ?? '').toUpperCase();
    if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') pass += 1;
    else if (verdict === '' || verdict === 'PENDING' || verdict === 'EXPECTED') pending += 1;
    else fail += 1;
  }
  return { fail, pending, pass };
}

/** The later of two ISO-8601 instants, ignoring absent/unparseable ones. */
function laterOf(a, b) {
  const at = typeof a === 'string' ? Date.parse(a) : NaN;
  const bt = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isFinite(at)) return Number.isFinite(bt) ? b : null;
  if (!Number.isFinite(bt)) return a;
  return at >= bt ? a : b;
}

const isCodeRabbit = (login) => String(login ?? '').toLowerCase().includes('coderabbit');

/**
 * A failure that must stop the sweep rather than shrink it.
 *
 * Every one of these would otherwise degrade into a CLEANER report: an
 * unreachable API drops a row, a malformed payload drops a field, an empty
 * list drops every row -- and a report with nothing wrong in it is exactly
 * what a sweep is supposed to produce when all is well. So they are thrown,
 * with a `kind` the entry point can print, never swallowed.
 */
export class SweepError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SweepError';
    this.kind = kind;
  }
}

/** Parse a `gh` response, or fail loudly naming what was being read. */
function parseJson(raw, what) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SweepError('malformed', `${what}: GitHub returned an empty body, not JSON`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SweepError('malformed', `${what}: GitHub returned a body that is not JSON (${err.message})`);
  }
}

/** Run one `gh` call, turning any transport failure into a hard SweepError. */
function call(gh, args, what) {
  let raw;
  try {
    raw = gh(args);
  } catch (err) {
    throw new SweepError(
      'unreachable',
      `${what}: the GitHub API could not be reached (${err?.message ?? err}). ` +
        'An unreachable API is reported as a failed sweep, never as a clean one.',
    );
  }
  return parseJson(raw, what);
}

const GRAPHQL_REVIEW_QUERY = `query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100){ nodes { comments(first:1){ nodes { author { login } createdAt } } } }
      reviews(last:100){ nodes { author { login } submittedAt } }
      commits(last:1){ nodes { commit { pushedDate committedDate } } }
    }}}`;

/**
 * Sweep every open PR by `author` and return one row each.
 *
 * @param {{
 *   gh: (args: string[]) => string,
 *   repo?: string,
 *   author?: string,
 *   onProgress?: (row: SweepRow) => void,
 * }} options
 * @returns {SweepRow[]} sorted worst-first.
 * @throws {SweepError} on an unreachable API, a malformed response, or an
 *   empty PR list -- each of which would otherwise read as a clean sweep.
 */
export function sweepPullRequests({ gh, repo = DEFAULT_REPO, author = '@me', onProgress }) {
  const [owner, name] = repo.split('/');
  const prs = call(
    gh,
    [
      'pr', 'list', '--repo', repo, '--author', author, '--state', 'open', '--limit', '200',
      '--json',
      'number,state,headRefName,headRefOid,mergeable,mergeStateStatus,isDraft,headRepository,headRepositoryOwner,statusCheckRollup',
    ],
    'pull-request list',
  );

  if (!Array.isArray(prs)) {
    throw new SweepError('malformed', `pull-request list: expected an array, got ${typeof prs}`);
  }
  if (prs.length === 0) {
    // Zero PRs is the vacuous pass this whole tool exists to refuse. It is
    // indistinguishable from "all 36 are fine" in any report that just prints
    // rows, and it is what a wrong --author, a wrong --repo, or a silently
    // truncated response all look like.
    throw new SweepError(
      'empty',
      `pull-request list: no open pull requests by ${author} in ${repo}. ` +
        'Zero PRs is refused rather than reported as a clean sweep - it is what a wrong ' +
        '--author, a wrong --repo and a truncated response all look like.',
    );
  }

  const rows = [];
  for (const pr of prs) {
    if (typeof pr?.number !== 'number' || typeof pr?.headRefOid !== 'string' || !pr.headRefOid) {
      throw new SweepError(
        'malformed',
        `pull-request list: an entry has no usable number/headRefOid (${JSON.stringify(pr)?.slice(0, 200)})`,
      );
    }
    const head = pr.headRefOid;

    const runsAtHead = call(
      gh,
      ['api', `repos/${repo}/actions/runs?head_sha=${head}&per_page=1`],
      `workflow runs at ${head.slice(0, 8)} (#${pr.number})`,
    );
    if (typeof runsAtHead?.total_count !== 'number') {
      throw new SweepError(
        'malformed',
        `workflow runs at ${head.slice(0, 8)} (#${pr.number}): no numeric total_count in the response`,
      );
    }
    const runCount = runsAtHead.total_count;
    // How many lanes the MERGE GATE's own workflow published at this head. Read
    // out of the rollup `gh pr list` already returned rather than bought with a
    // second API call per PR: every CheckRun in it carries `workflowName`, and
    // test.yml is `name: Test` (test.yml:5).
    //
    // Coupled to the workflow's DISPLAY NAME. A rename makes this 0 and reports
    // "never fired" on a head where it did, which is a false alarm rather than a
    // false green, so it fails in the safe direction. StatusContext entries (the
    // Vercel and bot rows) carry no workflowName and are simply not Test lanes.
    const testLaneCount = (pr.statusCheckRollup ?? []).filter(
      (c) => c?.workflowName === TEST_WORKFLOW_NAME,
    ).length;

    const runsOnBranch = call(
      gh,
      ['api', `repos/${repo}/actions/runs?branch=${encodeURIComponent(pr.headRefName)}&per_page=1`],
      `workflow runs on ${pr.headRefName} (#${pr.number})`,
    );
    const newestRunSha = runsOnBranch?.workflow_runs?.[0]?.head_sha ?? null;

    const graph = call(
      gh,
      ['api', 'graphql', '-f', `query=${GRAPHQL_REVIEW_QUERY}`,
        '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr.number}`],
      `review signals (#${pr.number})`,
    );
    const pull = graph?.data?.repository?.pullRequest;
    if (!pull) {
      throw new SweepError(
        'malformed',
        `review signals (#${pr.number}): the GraphQL response carries no pullRequest node`,
      );
    }
    const threads = (pull.reviewThreads?.nodes ?? [])
      .map((t) => t?.comments?.nodes?.[0])
      .filter((c) => isCodeRabbit(c?.author?.login));
    const reviews = (pull.reviews?.nodes ?? []).filter((r) => isCodeRabbit(r?.author?.login));
    let latestReviewAt = null;
    for (const c of threads) latestReviewAt = laterOf(latestReviewAt, c.createdAt);
    for (const r of reviews) latestReviewAt = laterOf(latestReviewAt, r.submittedAt);
    const headCommit = pull.commits?.nodes?.[0]?.commit ?? {};

    const comments = call(
      gh,
      ['api', `repos/${repo}/issues/${pr.number}/comments`, '--paginate'],
      `issue comments (#${pr.number})`,
    );
    if (!Array.isArray(comments)) {
      throw new SweepError(
        'malformed',
        `issue comments (#${pr.number}): expected an array, got ${typeof comments}`,
      );
    }
    const mine = comments.filter((c) => isCodeRabbit(c?.user?.login));
    for (const c of mine) latestReviewAt = laterOf(latestReviewAt, c.created_at);

    const cr = classifyReviewState({
      bodies: mine.map((c) => c.body ?? ''),
      inlineThreadCount: threads.length,
      latestReviewAt,
      headCommitAt: headCommit.pushedDate ?? headCommit.committedDate ?? null,
    });

    const { fail, pending, pass } = countRollup(pr.statusCheckRollup);
    const row = {
      number: pr.number,
      branch: pr.headRefName,
      head,
      headRepo: `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`,
      mergeable: pr.mergeable ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      runCount,
      testLaneCount,
      // Fetched AND carried. Adding `state` to the --json list without copying
      // it here left the NOT_OPEN branch reachable only from hand-built test
      // fixtures, which is the shape where a fix is inert exactly where it is
      // needed and the tests still go green.
      state: pr.state ?? null,
      newestRunSha,
      fail,
      pending,
      pass,
      crState: cr.state,
      crReviewed: cr.reviewed,
      threads: threads.length,
    };
    rows.push(row);
    onProgress?.(row);
  }

  rows.sort((a, b) => severityOf(b, repo) - severityOf(a, repo) || a.number - b.number);
  return rows;
}

/** Render the sweep as a Markdown table, worst-first. */
export function formatSweep(rows, repo = DEFAULT_REPO) {
  const lines = [
    '| PR | branch | head | mergeable/state | runs@head | stale? | fail | pend | CodeRabbit(threads) | DISQUALIFIER |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const bad = disqualify(row, repo);
    lines.push(
      `| #${row.number} | ${row.branch} | ${row.head.slice(0, 8)} | ` +
        `${row.mergeable}/${row.mergeStateStatus} | ${row.runCount} | ` +
        `${isStaleRun(row) ? 'STALE ' + String(row.newestRunSha).slice(0, 8) : 'no'} | ` +
        `${row.fail} | ${row.pending} | ${row.crState}(${row.threads}) | ${bad?.reason ?? '-'} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Rows that are ours AND disqualified -- the ones a "these are all green"
 * claim would be wrong about. A fork's row is neither green nor a task.
 */
export function actionable(rows, repo = DEFAULT_REPO) {
  return rows.filter((row) => {
    const bad = disqualify(row, repo);
    // NOT_OPEN joins NOT_OURS as a verdict that is not a TASK: a merged or
    // closed PR needs nothing done to it. Both still suppress every other
    // column's claim about the row, which is why they disqualify rather than
    // being filtered earlier.
    return bad !== null && bad.severity !== SEVERITY.NOT_OURS && bad.severity !== SEVERITY.NOT_OPEN;
  });
}
