#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Warning gate for #4154: a PR whose body admits partial coverage while
 * still using a bare `Closes`/`Fixes`/`Resolves #N`. `Closes #N` closes the
 * issue on merge and GitHub's keyword scanner ignores any qualifier after
 * the number, so `Closes #4111 (item 1 only)` closed #4111 in full with two
 * of its three items undone (#4114); the remainder needed a second PR
 * (#4139). Detection logic and the whole-body-vs-same-paragraph scoping
 * decision live in `scripts/lib/partial-close-admission.mjs` -- read that
 * file's header before changing the phrase list or the scope.
 *
 * WARN, NOT FAIL -- BY DESIGN, NOT AS A ROLLOUT STAGE. Unlike
 * `check-issue-queue.mjs`'s `mode` knob (advisory now, enforcing later),
 * this gate has no enforcing mode to graduate to. #4154 recommends warn-only
 * explicitly: a false positive that blocks a legitimate PR (a PR closing its
 * issue completely while separately noting an unrelated "follow-up") is
 * worse than a warning that gets read and dismissed. The finding this script
 * prints therefore NEVER fails the job by itself; only a REFUSAL does --
 * `gh` unreachable, a malformed payload, GraphQL errors -- because a read
 * that failed silently reporting success is the defect class this repo's
 * other gates keep refusing to reintroduce.
 *
 * REUSES `closingIssuesReferences`, NOT A BODY REGEX, FOR "DOES THIS PR
 * CLOSE SOMETHING". `check-issue-queue.mjs`'s header already proves a body
 * regex disagrees with GitHub's own keyword scanner in both directions
 * (#2978). This script asks the same question that gate already asks and
 * reuses the same field; the only NEW read is the admission-phrase scan over
 * the body text, which is genuinely new work because `closingIssuesReferences`
 * carries no prose.
 *
 * NO SECOND GRAPHQL ROUND TRIP (#4180 finding B). `check-issue-queue.mjs`
 * queries `body` and `closingIssuesReferences` off the SAME PR event, ONE
 * STEP EARLIER in the same job, and dumps its payload via its own `--dump`.
 * The workflow now points `--shared-state-file` at that dump instead of
 * letting this script call `gh api graphql` a second time. That round trip
 * used to matter for a reason that no longer holds: `Issue queue` became a
 * REQUIRED status check on `main` (`scripts/issue-queue.config.json`
 * documents the ruleset change), and this step ran with no
 * `continue-on-error`, so a transient GitHub API failure in THIS gate's own
 * independent fetch -- a gate whose entire design says it must never block a
 * merge -- could block one anyway. Reusing the payload removes the failure
 * mode at its root rather than papering over it with `continue-on-error`
 * (which would also swallow a genuine `PartialCloseAdmissionError` this
 * script wants surfaced when it IS the one making the GraphQL call, e.g. a
 * manual `--pr` invocation).
 *
 * `--shared-state-file` THEREFORE NEVER REFUSES, unlike `--state-file`
 * (offline testing) and unlike the live `--pr` path. A missing file, an
 * unparseable one, or a shape `normalisePullRequest` rejects all produce one
 * `ℹ️  SKIPPED` line and exit 0 -- the finding is silently absent, not a red
 * job. `.github/workflows/issue-queue.yml`'s step order (checkout, unit
 * tests, `check-issue-queue.mjs` with `--dump`, THEN this script) means the
 * file exists whenever this step actually runs, because a prior step's
 * non-zero exit skips every step after it by GitHub Actions' own default
 * (no step here sets `continue-on-error` or `if: always()`); the skip path
 * exists anyway because "the workflow's step order happens to guarantee it"
 * is not a load-bearing enough promise for a gate whose header (above) says
 * a refusal is the one thing this gate must never produce from something
 * that isn't this PR's own body.
 *
 * STATED HOLE: a PR that partly closes an issue and says nothing about it is
 * invisible to a phrase scan. This gate only catches the case where the
 * author's own words contradicted the closing keyword; it does not, and
 * cannot, catch silence.
 *
 * WIRED BY `.github/workflows/issue-queue.yml`, alongside
 * `check-issue-queue.mjs` -- same PR event, same round trip's worth of data,
 * no extra one. Its regression harness is
 * `scripts/check-partial-close-admission.test.mjs` and
 * `scripts/lib/partial-close-admission.test.mjs`, run in the same job,
 * before the gate, matching the existing convention.
 *
 * Usage:
 *   node scripts/check-partial-close-admission.mjs --pr 4154 --repo LTplus-AG/ifc-lite
 *   node scripts/check-partial-close-admission.mjs --pr 4154 --dump /tmp/pr.json
 *   node scripts/check-partial-close-admission.mjs --state-file /tmp/pr.json   # offline, strict (tests)
 *   node scripts/check-partial-close-admission.mjs --shared-state-file /tmp/pr.json   # CI: check-issue-queue.mjs's own dump, never refuses
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { evaluatePartialCloseAdmission } from './lib/partial-close-admission.mjs';

/** A named, actionable refusal -- distinct from the (never-failing) verdict. */
export class PartialCloseAdmissionError extends Error {
  /** @param {string} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
    this.name = 'PartialCloseAdmissionError';
  }
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { pr: null, repo: null, stateFile: null, sharedStateFile: null, dump: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--pr') out.pr = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--state-file') out.stateFile = next();
    else if (a === '--shared-state-file') out.sharedStateFile = next();
    else if (a === '--dump') out.dump = next();
    else throw new PartialCloseAdmissionError('BAD_ARGS', `Unknown argument \`${a}\`.`);
  }
  if (out.stateFile && out.sharedStateFile) {
    throw new PartialCloseAdmissionError(
      'BAD_ARGS',
      '`--state-file` and `--shared-state-file` are mutually exclusive: the first is a strict, ' +
        'offline test fixture whose failures MUST refuse; the second is a live CI dump whose ' +
        'failures MUST silently skip. Passing both leaves it undefined which behavior applies.',
    );
  }
  return out;
}

/**
 * Deliberately narrow: only the two fields this gate needs, body and
 * `closingIssuesReferences`. No labels, no timeline -- this gate does not
 * adjudicate WHO may steer, only what the PR's own words say about what it
 * closes.
 */
export const PR_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      number
      title
      body
      closingIssuesReferences(first:1) {
        pageInfo { hasNextPage }
        nodes { number }
      }
    }
  }
}`;

/** @param {{ repo: string, pr: string }} opts */
function fetchPayload(opts) {
  const slash = opts.repo.indexOf('/');
  if (slash <= 0 || slash === opts.repo.length - 1) {
    throw new PartialCloseAdmissionError(
      'NO_REPO',
      `\`${opts.repo}\` is not \`owner/name\`.`,
    );
  }
  const number = Number(opts.pr);
  if (!Number.isInteger(number) || number <= 0) {
    throw new PartialCloseAdmissionError(
      'BAD_ARGS',
      `\`--pr\` needs a positive integer; got ${JSON.stringify(opts.pr)}.`,
    );
  }
  const args = [
    'api', 'graphql',
    '-f', `query=${PR_QUERY}`,
    '-f', `owner=${opts.repo.slice(0, slash)}`,
    '-f', `name=${opts.repo.slice(slash + 1)}`,
    '-F', `number=${number}`,
  ];
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw new PartialCloseAdmissionError(
      'GH_UNAVAILABLE',
      `Could not spawn \`gh\` to read PR #${opts.pr}: ${r.error.message}.`,
    );
  }
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : null;
  if (errors && errors.length > 0) {
    throw new PartialCloseAdmissionError(
      'GRAPHQL_ERRORS',
      `GitHub's GraphQL API returned ${errors.length} error(s) for PR #${opts.pr}: ` +
        errors.map((e) => e?.message ?? JSON.stringify(e)).join('; '),
    );
  }
  if (r.status !== 0) {
    throw new PartialCloseAdmissionError(
      'GH_ERROR',
      `\`gh api graphql\` exited ${r.status} reading PR #${opts.pr}: ` +
        `${(r.stderr || '').trim() || '(no stderr)'}.`,
    );
  }
  if (parsed === null) {
    throw new PartialCloseAdmissionError(
      'GH_BAD_JSON',
      `\`gh api graphql\` returned unparseable output reading PR #${opts.pr}.`,
    );
  }
  return parsed;
}

/**
 * A raw GraphQL payload into `{ number, title, body, closesAnyIssue }`. Pure,
 * so `--state-file` can drive it over a captured payload the same way
 * `check-issue-queue.mjs`'s harness drives `normalisePullRequest`.
 *
 * @param {unknown} payload
 */
export function normalisePullRequest(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new PartialCloseAdmissionError(
      'GRAPHQL_ERRORS',
      `Payload carries ${payload.errors.length} GraphQL error(s): ` +
        payload.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; '),
    );
  }
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== 'object') {
    throw new PartialCloseAdmissionError(
      'NO_PULL_REQUEST',
      'The payload has no `data.repository.pullRequest`.',
    );
  }
  const nodes = pr.closingIssuesReferences?.nodes;
  if (!Array.isArray(nodes)) {
    throw new PartialCloseAdmissionError(
      'NO_CLOSING_ISSUES',
      `PR #${pr.number} returned no \`closingIssuesReferences\` list at all. An absent list and ` +
        'an empty one are different answers; this gate never converts a failed read into ' +
        '"closes nothing".',
    );
  }
  return {
    number: pr.number,
    title: typeof pr.title === 'string' ? pr.title : '',
    body: typeof pr.body === 'string' ? pr.body : '',
    closesAnyIssue: nodes.length > 0,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // `--shared-state-file`: the CI path (#4180 finding B). ANY failure here --
  // the file is absent, unparseable, or a shape `normalisePullRequest`
  // rejects -- is a SKIP, never a refusal. See the module header's
  // "NO SECOND GRAPHQL ROUND TRIP" note for why this path is not allowed to
  // exit non-zero: it feeds a required status check that must never fail on
  // anything but this PR's own body.
  if (args.sharedStateFile) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(args.sharedStateFile, 'utf8'));
    } catch (err) {
      console.log(
        `ℹ️  SKIPPED: could not read/parse \`--shared-state-file\` (${args.sharedStateFile}): ` +
          `${err.message}. This step never fails a required job over its own upstream step's ` +
          'output; see the module header.',
      );
      process.exit(0);
    }
    let pr;
    try {
      pr = normalisePullRequest(payload);
    } catch (err) {
      console.log(
        `ℹ️  SKIPPED: \`--shared-state-file\` did not carry the expected shape (${err.message}). ` +
          'This step never fails a required job over its own upstream step\'s output; see the ' +
          'module header.',
      );
      process.exit(0);
    }
    printVerdict(pr);
    return;
  }

  let payload;
  if (args.stateFile) {
    payload = JSON.parse(readFileSync(args.stateFile, 'utf8'));
  } else {
    if (!args.pr) {
      throw new PartialCloseAdmissionError('BAD_ARGS', 'Pass `--pr <number>` (or `--state-file` for tests).');
    }
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repo) {
      throw new PartialCloseAdmissionError('NO_REPO', 'Pass `--repo owner/name` or set GITHUB_REPOSITORY.');
    }
    payload = fetchPayload({ repo, pr: args.pr });
  }
  if (args.dump) writeFileSync(args.dump, JSON.stringify(payload, null, 2));

  const pr = normalisePullRequest(payload);
  printVerdict(pr);
}

/**
 * Shared by the live/`--state-file` path and the `--shared-state-file` path
 * above: print the verdict and exit 0. ALWAYS EXIT 0 ON A VERDICT -- this
 * gate has no enforcing mode, see the header. Only a refusal (an uncaught
 * throw on the `--pr`/`--state-file` paths; never on `--shared-state-file`,
 * which converts every failure into a SKIP before reaching here) fails the
 * job.
 *
 * @param {{ number: number, title: string, body: string, closesAnyIssue: boolean }} pr
 */
function printVerdict(pr) {
  console.log(`PR #${pr.number} — ${pr.title}`);
  console.log(`Closes at least one issue: ${pr.closesAnyIssue}`);
  console.log('');

  const { lines } = evaluatePartialCloseAdmission({ body: pr.body, closesAnyIssue: pr.closesAnyIssue });
  for (const l of lines) console.log(l);

  console.log('');
  console.log('This finding does not fail the build; see the module header for why.');
  process.exit(0);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof PartialCloseAdmissionError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
