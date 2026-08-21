#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Report whether CodeRabbit actually reviewed the given pull requests.
 *
 *   node scripts/check-coderabbit-review.mjs 2971 2970 ...
 *   node scripts/check-coderabbit-review.mjs --mine
 *
 * Exits non-zero when any PR is shown to be unreviewed, so it can gate a
 * "these are ready for review" claim. It is NOT wired into CI and should not
 * be: the answer depends on transient GitHub state (rate limiting clears on
 * its own), so a required check built on it would fail for reasons unrelated
 * to the diff.
 *
 * Classification lives in ./lib/coderabbit-review-state.mjs, which is pure and
 * unit-tested. Everything here is the GitHub plumbing.
 *
 * Why GraphQL: `gh pr view --json comments` does not return inline review
 * threads at all. Counting findings from issue comments alone reports every PR
 * as having none.
 */
import { execFileSync } from 'node:child_process';
import { classifyReviewState } from './lib/coderabbit-review-state.mjs';

const REPO = process.env.CODERABBIT_CHECK_REPO ?? 'LTplus-AG/ifc-lite';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const isCodeRabbit = (login) => (login ?? '').toLowerCase().includes('coderabbit');

function inlineThreadCount(pr) {
  const query = `query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$pr){
        reviewThreads(first:100){ nodes { comments(first:1){ nodes { author { login } } } } }
      }}}`;
  const [owner, name] = REPO.split('/');
  const out = gh([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`,
  ]);
  const nodes =
    JSON.parse(out).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.filter((t) => isCodeRabbit(t.comments?.nodes?.[0]?.author?.login)).length;
}

function bodiesFor(pr) {
  const raw = gh(['api', `repos/${REPO}/issues/${pr}/comments`, '--paginate']);
  return JSON.parse(raw)
    .filter((c) => isCodeRabbit(c.user?.login))
    .map((c) => c.body ?? '');
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
  const result = classifyReviewState({
    bodies: bodiesFor(pr),
    inlineThreadCount: inlineThreadCount(pr),
  });
  if (!result.reviewed) unreviewed += 1;
  console.log(`#${pr}  ${result.state.padEnd(14)} ${result.why}`);
}

console.log(`\n${prs.length} checked, ${unreviewed} with no review to show for the green tick.`);
if (unreviewed > 0) {
  console.log(
    'A CodeRabbit tick on those means the check ran, not that the diff was read.',
  );
}
process.exit(unreviewed > 0 ? 1 : 0);
