#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Report whether CodeRabbit actually reviewed the given pull requests, at the
 * commit they currently point at.
 *
 *   node scripts/check-coderabbit-review.mjs 2971 2970 ...
 *   node scripts/check-coderabbit-review.mjs --mine
 *
 * Exits non-zero when any PR is not shown to be reviewed, so it can gate a
 * "these are ready for review" claim. It is NOT wired into CI and should not
 * be: the answer depends on transient GitHub state (rate limiting clears on
 * its own), so a required check built on it would fail for reasons unrelated
 * to the diff.
 *
 * @unwired-by-design its verdict depends on transient GitHub state (review
 * latency, rate limiting), so a required check built on it would fail for
 * reasons unrelated to the diff under test.
 *
 * Classification lives in ./lib/coderabbit-review-state.mjs, which is pure and
 * unit-tested. Everything here is the GitHub plumbing.
 *
 * Why GraphQL: `gh pr view --json comments` does not return inline review
 * threads at all. Counting findings from issue comments alone reports every PR
 * as having none. GraphQL is also the only place the three timestamps live --
 * a thread's first-comment `createdAt`, a review's `submittedAt`, and the head
 * commit's `pushedDate`/`committedDate` -- and without those a review posted
 * two pushes ago certifies commits the bot never saw.
 */
import { execFileSync } from 'node:child_process';
import { classifyReviewState } from './lib/coderabbit-review-state.mjs';

const REPO = process.env.CODERABBIT_CHECK_REPO ?? 'LTplus-AG/ifc-lite';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const isCodeRabbit = (login) => (login ?? '').toLowerCase().includes('coderabbit');

/** The later of two ISO-8601 instants, ignoring absent/unparseable ones. */
function laterOf(a, b) {
  const at = typeof a === 'string' ? Date.parse(a) : NaN;
  const bt = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isFinite(at)) return Number.isFinite(bt) ? b : null;
  if (!Number.isFinite(bt)) return a;
  return at >= bt ? a : b;
}

/**
 * Inline thread count, newest review instant, and the head commit's instant --
 * one round trip.
 *
 * `pushedDate` is the honest answer for "when did this commit reach the PR",
 * but GitHub returns null for it on many commits, so `committedDate` is the
 * fallback. Both may be absent; the classifier treats an undated head commit
 * as not-shown-reviewed rather than guessing.
 */
function reviewSignals(pr) {
  const query = `query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$pr){
        reviewThreads(first:100){ nodes { comments(first:1){ nodes { author { login } createdAt } } } }
        reviews(last:100){ nodes { author { login } submittedAt } }
        commits(last:1){ nodes { commit { pushedDate committedDate } } }
      }}}`;
  const [owner, name] = REPO.split('/');
  const out = gh([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`,
  ]);
  const pull = JSON.parse(out).data?.repository?.pullRequest ?? {};

  const threads = (pull.reviewThreads?.nodes ?? [])
    .map((t) => t.comments?.nodes?.[0])
    .filter((c) => isCodeRabbit(c?.author?.login));

  const reviews = (pull.reviews?.nodes ?? []).filter((r) =>
    isCodeRabbit(r.author?.login),
  );

  let latestReviewAt = null;
  for (const c of threads) latestReviewAt = laterOf(latestReviewAt, c.createdAt);
  for (const r of reviews) latestReviewAt = laterOf(latestReviewAt, r.submittedAt);

  const head = pull.commits?.nodes?.[0]?.commit ?? {};
  return {
    inlineThreadCount: threads.length,
    latestReviewAt,
    headCommitAt: head.pushedDate ?? head.committedDate ?? null,
  };
}

/**
 * CodeRabbit's issue-comment bodies, plus the newest one's `created_at`.
 *
 * `created_at`, not `updated_at`: CodeRabbit rewrites a summary in place, so an
 * edit timestamp would date an old summary to the moment of an unrelated edit
 * and read as fresh. The post time can only understate how recent the evidence
 * is, and understating lands on the unreviewed side, which is the safe one.
 */
function commentEvidence(pr) {
  const raw = gh(['api', `repos/${REPO}/issues/${pr}/comments`, '--paginate']);
  const mine = JSON.parse(raw).filter((c) => isCodeRabbit(c.user?.login));
  let latestCommentAt = null;
  for (const c of mine) latestCommentAt = laterOf(latestCommentAt, c.created_at);
  return { bodies: mine.map((c) => c.body ?? ''), latestCommentAt };
}

function myOpenPrs() {
  const raw = gh([
    'pr', 'list', '--repo', REPO, '--author', '@me',
    '--state', 'open', '--limit', '200', '--json', 'number',
  ]);
  return JSON.parse(raw).map((p) => String(p.number));
}

const args = process.argv.slice(2);
const prs = args.includes('--mine') ? myOpenPrs() : args.filter((a) => /^\d+$/.test(a));

if (prs.length === 0) {
  // An empty target list must never read as "all clear" -- that is the
  // vacuous-pass shape this repo has shipped three times.
  console.error(
    'check-coderabbit-review: no pull requests named; refusing a vacuous pass.\n' +
      '  node scripts/check-coderabbit-review.mjs <pr>...\n' +
      '  node scripts/check-coderabbit-review.mjs --mine',
  );
  process.exit(1);
}

let unreviewed = 0;
for (const pr of prs) {
  const signals = reviewSignals(pr);
  const { bodies, latestCommentAt } = commentEvidence(pr);
  const result = classifyReviewState({
    bodies,
    inlineThreadCount: signals.inlineThreadCount,
    latestReviewAt: laterOf(signals.latestReviewAt, latestCommentAt),
    headCommitAt: signals.headCommitAt,
  });
  if (!result.reviewed) unreviewed += 1;
  console.log(`#${pr}  ${result.state.padEnd(16)} ${result.why}`);
}

console.log(`\n${prs.length} checked, ${unreviewed} with no review to show for the green tick at their head commit.`);
if (unreviewed > 0) {
  console.log(
    'A CodeRabbit tick on those means the check ran, not that the current diff was read.',
  );
}
process.exit(unreviewed > 0 ? 1 : 0);
