#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A REVIEW THAT DID NOT POST IS NOT A REVIEW, AND THE JOB'S EXIT CODE CANNOT
 * TELL YOU WHICH HAPPENED.
 *
 * WHY THIS EXISTS. `anthropics/claude-code-action` has at least three OPEN,
 * confirmed paths that report success while reviewing nothing, verified in its
 * tracker on 2026-08-31:
 *
 *   - #1644 (bug, p1, 2026-08-13) "Agent exits success after 5-10 turns without
 *     completing the review (silent no-op)". Roughly half of runs return
 *     `is_error: false` with a low `num_turns`, so an `is_error` guard cannot
 *     see it.
 *   - #1679 (bug, p2, 2026-08-16) "post-buffered-inline-comments exits 0 after
 *     failing to post every comment". Reported as FORTY CONSECUTIVE RUNS logging
 *     `Posted 0/N` and reporting success: the review ran, findings existed, and
 *     zero comments reached the pull request.
 *   - An unguarded `num_turns: 0` path.
 *
 * None of the three is credential-specific, so paying for an API key instead of
 * using a subscription does not close any of them.
 *
 * That is the same defect this repository has already paid for from the other
 * side: 174 of 830 merged PRs in August 2026 (21%, 46,717 lines) carried no
 * review of any kind while showing green, and #3175 then had to correct TWELVE
 * changesets by hand that would have shipped breaking changes as `patch`, with
 * the release one command from publishing. ABSENCE MUST NOT READ AS SUCCESS.
 *
 * WHAT THIS GATE REFUSES TO ACCEPT AS EVIDENCE, and why each is not enough:
 *
 *   - THE JOB'S EXIT CODE. #1644 and #1679 both exit 0.
 *   - STRUCTURED OUTPUT / a `--json-schema` result. #1679 satisfies the schema
 *     and drops every comment on the floor afterwards. The schema describes what
 *     the model PRODUCED, not what the pull request RECEIVED.
 *   - A COMMENT EXISTING AT ALL. A comment from an earlier head is not a review
 *     of this one, and a force-push re-anchors bot comments to the new SHA, so
 *     the comment's own anchor cannot be trusted to say which diff was read.
 *
 * THE ONE THING IT DOES ACCEPT is a marker the reviewer writes at the END of a
 * successful post, naming the exact commit it reviewed:
 *
 *     <!-- ifc-lite-review sha=<40-hex> verdict=clean|findings count=<n> -->
 *
 * THE CONTRACT THIS IMPLIES, and it is the load-bearing half: THE REVIEWER MUST
 * POST ON EVERY RUN, INCLUDING WHEN IT FINDS NOTHING. A reviewer that stays
 * silent when clean makes "reviewed and found nothing" byte-identical to "never
 * ran", which is the exact trap CodeRabbit falls into here (it publishes no
 * review event on a clean pass, which is why scripts/pr-review-signal.config.json
 * ships `staleReviewPolicy: "off"` -- absence of a review object is not evidence
 * of staleness for THAT reviewer, and cannot be made into evidence). We control
 * our own reviewer, so we take the other branch: it always speaks, and silence
 * therefore means failure. This gate is only meaningful because of that.
 *
 * FAILURE CLASSES, each with its own remedy, because a remedy that contradicts
 * its finding is worse than no remedy:
 *
 *   NOT_POSTED       No marker from any expected author. The action reported
 *                    whatever it reported; nothing reached the PR.
 *                    REMEDY: re-run the review job. If it recurs, the run log
 *                    will show `Posted 0/N` (#1679) or a low `num_turns`
 *                    (#1644); attach it to the issue rather than re-running
 *                    forever.
 *   STALE_REVIEW     A marker exists but names a different commit. The reviewer
 *                    read an earlier head. REMEDY: re-run; do not read the older
 *                    verdict as covering this diff.
 *   MARKER_MALFORMED A marker is present and unparseable. Treated as absence,
 *                    never as a pass. REMEDY: fix the reviewer's marker writer.
 *   NO_PR / NO_REPO / NO_SHA / BAD_CONFIG / GH_*  Broken invocation or an
 *                    unreadable input. REMEDY is per message; all fail closed.
 *
 * STATED HOLES, so nobody reads a green here as more than it is:
 *
 *   1. It proves a comment was POSTED naming this SHA. It proves nothing about
 *      whether the review was any GOOD. Precision is a separate instrument.
 *   2. A reviewer that posts a marker and an empty body satisfies this gate. The
 *      marker is written by our own reviewer, so this is a trust boundary we
 *      own, not one an outside contributor can cross -- but it is a boundary.
 *   3. It cannot distinguish "the model had nothing to say" from "the model was
 *      throttled into saying nothing but still posted". If the review lane is
 *      funded by a consumer subscription whose pool can drain, the reviewer must
 *      itself fail rather than post an empty clean verdict; this gate cannot
 *      recover that distinction after the fact.
 *   4. Comment pagination is bounded (see PAGE_LIMIT). A PR whose comment list
 *      exceeds it fails closed with COMMENTS_TRUNCATED rather than guessing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { existsOrThrow } from './lib/exists-or-throw.mjs';
import { gh, GhError } from './lib/gh.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(SCRIPTS_DIR, 'review-posted.config.json');

/** Bounded on purpose: an unbounded read that silently truncates is a false pass. */
const PAGE_LIMIT = 200;

/**
 * The marker the reviewer writes at the END of a successful post. Anchored at
 * both ends and tolerant of surrounding whitespace only -- a loose pattern here
 * would let a contributor hand-write a passing marker into a PR comment.
 */
const MARKER_RE = /<!--\s*ifc-lite-review\s+sha=([0-9a-f]{40})\s+verdict=(clean|findings)\s+count=(\d+)\s*-->/;

export class ReviewPostedError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** @param {string} login */
export function normaliseLogin(login) {
  return String(login ?? '')
    .toLowerCase()
    .replace(/\[bot\]$/, '')
    .replace(/^app\//, '');
}

/** @param {string} path */
export function readConfig(path) {
  if (
    !existsOrThrow(path, 'the review-posted config', (m) => {
      throw new ReviewPostedError('BAD_CONFIG', m);
    })
  ) {
    throw new ReviewPostedError(
      'NO_CONFIG',
      `Config \`${path}\` is missing. A missing reviewer list is NOT an empty one: with no ` +
        'expected authors this gate would accept a marker from anybody, so it refuses instead.',
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ReviewPostedError('BAD_CONFIG', `Config \`${path}\` is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(cfg.expectedAuthors) || cfg.expectedAuthors.length === 0) {
    throw new ReviewPostedError(
      'BAD_CONFIG',
      `\`expectedAuthors\` in \`${path}\` must be a non-empty array of GitHub logins. ` +
        'Not defaulted: an empty list would make every PR pass on any comment.',
    );
  }
  if (cfg.mode !== 'advisory' && cfg.mode !== 'enforcing') {
    throw new ReviewPostedError(
      'BAD_CONFIG',
      `\`mode\` in \`${path}\` must be "advisory" or "enforcing"; found ${JSON.stringify(cfg.mode)}. ` +
        'There is no default: a missing mode is a broken config, not a request for the lenient one.',
    );
  }
  return {
    // Carried through explicitly. This return is an allowlist, not a spread, so a
    // key validated above but omitted here reads as `undefined` at the call site
    // while validation still passes -- a knob that silently does nothing.
    mode: cfg.mode,
    expectedAuthors: new Set(cfg.expectedAuthors.map(normaliseLogin)),
  };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { pr: null, repo: process.env.GITHUB_REPOSITORY || null, sha: null, config: DEFAULT_CONFIG, stateFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') continue;
    const m = /^--([a-z-]+)$/.exec(a);
    if (!m) throw new ReviewPostedError('BAD_ARGS', `Unrecognised argument \`${a}\`.`);
    const key = { pr: 'pr', repo: 'repo', sha: 'sha', config: 'config', 'state-file': 'stateFile' }[m[1]];
    if (!key) throw new ReviewPostedError('BAD_ARGS', `Unrecognised flag \`${a}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new ReviewPostedError('BAD_ARGS', `\`${a}\` needs a value.`);
    out[key] = v;
    i += 1;
  }
  return out;
}

/**
 * Every comment body on the PR, from the issue-comment and review-comment
 * surfaces both, because the reviewer may post as either and a gate that reads
 * only one surface is blind exactly where the other is used.
 *
 * Pure over an already-fetched payload so the harness can drive every branch
 * without a network, a token, or a real PR. The harness reaches it through
 * `--state-file`, not through an import.
 *
 * @returns {{ author: string, body: string }[]}
 */
export function normaliseComments(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ReviewPostedError('NO_PAYLOAD', 'No comment payload to adjudicate.');
  }
  const out = [];
  for (const key of ['issueComments', 'reviewComments', 'reviews']) {
    const list = payload[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new ReviewPostedError('BAD_PAYLOAD', `\`${key}\` is present but is not an array.`);
    }
    if (list.length >= PAGE_LIMIT) {
      throw new ReviewPostedError(
        'COMMENTS_TRUNCATED',
        `\`${key}\` returned ${list.length} entries, at or past the ${PAGE_LIMIT} page limit, so ` +
          'the marker may be on a page this gate never read. Refusing to report "not posted" for ' +
          'a list it could not finish reading.',
      );
    }
    for (const c of list) {
      out.push({ author: normaliseLogin(c?.user?.login ?? c?.author?.login), body: String(c?.body ?? '') });
    }
  }
  if (out.length === 0 && payload.issueComments === undefined && payload.reviewComments === undefined) {
    throw new ReviewPostedError('NO_PAYLOAD', 'Payload carried no comment lists at all.');
  }
  return out;
}

/**
 * The verdict. `ok` is true only when an expected author posted a well-formed
 * marker naming exactly `headSha`.
 *
 * @returns {{ ok: boolean, verdict: string, lines: string[] }}
 */
export function evaluate({ comments, cfg, headSha }) {
  const lines = [];
  const mine = comments.filter((c) => cfg.expectedAuthors.has(c.author));

  if (mine.length === 0) {
    lines.push(
      `❌ NOT_POSTED: no comment on this PR from any expected reviewer ` +
        `(${[...cfg.expectedAuthors].join(', ')}).`,
      '   The review job\'s exit code is NOT evidence: claude-code-action #1644 exits success after',
      '   a partial run, and #1679 exits 0 after failing to post every comment (reported as forty',
      '   consecutive runs logging `Posted 0/N`). Both are open.',
      '   REMEDY: re-run the review job. If it recurs, read the run log for `Posted 0/N` or a low',
      '   `num_turns` and attach it to the upstream issue rather than re-running indefinitely.',
    );
    return { ok: false, verdict: 'NOT_POSTED', lines };
  }

  const markers = [];
  let sawUnparseable = false;
  for (const c of mine) {
    const m = MARKER_RE.exec(c.body);
    if (m) markers.push({ sha: m[1], verdict: m[2], count: Number(m[3]) });
    // Only an ATTEMPTED marker counts as malformed: an HTML comment carrying the
    // token but not parsing. A prose mention of the token is not a broken marker
    // writer, and the two have different remedies -- "fix the writer" versus
    // "re-run the job" -- so conflating them points the reader at the wrong fix.
    else if (/<!--[^>]*ifc-lite-review/.test(c.body)) sawUnparseable = true;
  }

  if (markers.length === 0) {
    lines.push(
      sawUnparseable
        ? '❌ MARKER_MALFORMED: an expected reviewer commented and its marker did not parse.'
        : '❌ NOT_POSTED: an expected reviewer commented, but no comment carries a review marker.',
      '   A comment without a marker is not a completed review: the marker is written at the END',
      '   of a successful post, so its absence is exactly the partial-run shape #1644 describes.',
      '   Treated as absence rather than as a pass, on purpose.',
      '   REMEDY: ' +
        (sawUnparseable
          ? 'fix the reviewer\'s marker writer; the expected form is ' +
            '`<!-- ifc-lite-review sha=<40-hex> verdict=clean|findings count=<n> -->`.'
          : 're-run the review job.'),
    );
    return { ok: false, verdict: sawUnparseable ? 'MARKER_MALFORMED' : 'NOT_POSTED', lines };
  }

  const match = markers.find((m) => m.sha === headSha);
  if (!match) {
    lines.push(
      `❌ STALE_REVIEW: the newest review marker names ${markers[markers.length - 1].sha.slice(0, 9)}, ` +
        `but this PR's head is ${headSha.slice(0, 9)}.`,
      '   A review of an earlier head has not reviewed this diff. The comment ANCHOR cannot settle',
      '   this either: a force-push re-anchors bot comments to the new SHA, so only the marker the',
      '   reviewer wrote at review time says which commit it actually read.',
      '   REMEDY: re-run the review job against the current head.',
    );
    return { ok: false, verdict: 'STALE_REVIEW', lines };
  }

  lines.push(
    `✅ REVIEW_POSTED: an expected reviewer posted a ${match.verdict} verdict for ${headSha.slice(0, 9)}` +
      `${match.verdict === 'findings' ? ` with ${match.count} finding(s)` : ''}.`,
    '   This proves a review REACHED the pull request for this exact commit. It proves nothing',
    '   about whether the review was any good; precision is a separate instrument.',
  );
  return { ok: true, verdict: 'REVIEW_POSTED', lines };
}

function fetchPayload(repo, pr) {
  return {
    issueComments: gh(
      ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp'],
      'the PR comment list',
      ReviewPostedError,
    ).flat(),
    reviews: gh(
      ['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp'],
      'the PR review list',
      ReviewPostedError,
    ).flat(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readConfig(args.config);

  // Printed immediately after readConfig, before anything that can refuse on PR
  // state, so a red check always states which mode produced it. parseArgs and
  // readConfig necessarily refuse before it; those are broken-invocation errors,
  // not verdicts on a PR.
  console.log(
    `Mode: ${cfg.mode}${
      cfg.mode === 'advisory' ? ' (a failing verdict prints but does not fail this job; a REFUSAL still does)' : ''
    }`,
  );

  if (!args.pr) throw new ReviewPostedError('NO_PR', 'Pass `--pr <number>`.');
  if (!args.sha) {
    throw new ReviewPostedError(
      'NO_SHA',
      'Pass `--sha <40-hex>`, the head commit this review must name. Deriving it here instead of ' +
        'being told would let the gate adjudicate a commit different from the one CI is testing.',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new ReviewPostedError('NO_SHA', `\`--sha\` must be a full 40-hex commit; got ${JSON.stringify(args.sha)}.`);
  }

  let payload;
  if (args.stateFile) {
    payload = JSON.parse(readFileSync(args.stateFile, 'utf8'));
  } else {
    if (!args.repo) {
      throw new ReviewPostedError(
        'NO_REPO',
        'Pass `--repo owner/name` or set GITHUB_REPOSITORY. Guessing it would mean adjudicating a ' +
          'repository this gate never confirmed.',
      );
    }
    payload = fetchPayload(args.repo, args.pr);
  }

  const comments = normaliseComments(payload);
  console.log(`Comments read: ${comments.length}`);
  console.log(`Head: ${args.sha.slice(0, 9)}`);
  console.log('');

  const { ok, lines } = evaluate({ comments, cfg, headSha: args.sha });
  for (const l of lines) console.log(l);

  // Advisory gates the EXIT CODE and nothing else. The verdict text is identical
  // in both modes, so a rollout state cannot quietly change what is reported. A
  // REFUSAL is a fact about this gate's inputs rather than a verdict on the PR,
  // so it fails closed in both modes -- it never reaches here.
  if (!ok && cfg.mode === 'advisory') {
    console.log('');
    console.log(
      'ADVISORY MODE: the finding above does not fail this job. Set `mode` to "enforcing" in ' +
        'scripts/review-posted.config.json once the reviewer lane is trusted.',
    );
    process.exit(0);
  }
  process.exit(ok ? 0 : 1);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof ReviewPostedError || err instanceof GhError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
