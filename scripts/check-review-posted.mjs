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
 *     of this one, and GitHub relocates a bot comment's `commit_id` onto a
 *     later head -- with or without a force-push -- so THAT field cannot say
 *     which diff was read (#3729). The frozen `original_commit_id` can, and the
 *     findings cross-check uses it -- but the VERDICT still turns on a marker
 *     naming the reviewed commit, because nothing relocates that.
 *
 * THE ONE THING IT DOES ACCEPT is a marker the reviewer writes at the END of a
 * successful post, naming the exact commit it reviewed:
 *
 *     <!-- ifc-lite-review sha=<40-hex> verdict=clean|findings|nothing-to-review|dropped count=<n> -->
 *
 *     An optional trailing ` omitted=<n>` (present only when n > 0) records how
 *     many changed files were too large to fit the model prompt and were NOT
 *     reviewed (#3679). The verdict then covers only the files that were.
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
 *   4. Comment pagination is bounded (MAX_PAGES x PER_PAGE). A PR busier than
 *      that fails closed with COMMENTS_TRUNCATED rather than guessing.
 *   5. It waits for the marker (POLL_SECONDS up to the timeout) because a
 *      comment does not fire `pull_request`. On expiry NOT_POSTED is the true
 *      answer at that moment, not a timeout dressed up as one.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { gh, GhError } from './lib/gh.mjs';
// ONE HOME FOR "which commit did this row see" (#3729), shared with post-review.
import { ReviewProvenanceError, wroteAtCommit } from './lib/review-provenance.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(SCRIPTS_DIR, 'review-posted.config.json');

/**
 * THE POLL, AND WHY THIS GATE CANNOT BE A SINGLE READ.
 *
 * The workflow fires on `pull_request`, which means this gate starts SECONDS
 * after a push while the reviewer takes minutes. Nothing re-fires it when the
 * marker lands: posting a comment does not raise a `pull_request` event. A
 * single-read version is therefore RED ON EVERY PUSH and green only after a
 * human clicks re-run -- 1,200 manual re-runs a month here, which is how a gate
 * stops being read at all. Advisory mode hides this completely, so it would have
 * shipped broken on the day it was flipped to enforcing.
 *
 * So it waits, the way scripts/check-pr-review-signal.mjs waits for lanes. The
 * budget is the honest question "has the reviewer had a fair chance yet", not a
 * guess at how long a review takes: on expiry the verdict is still NOT_POSTED,
 * which is the true answer at that moment, and the remedy re-runs.
 */
const POLL_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * A page cap that is REAL. `gh api --paginate` follows Link headers to
 * exhaustion, so a guard applied after that call bounds nothing and merely turns
 * a fully-read busy PR into a permanent refusal it can never clear. The fetch
 * below is explicitly paged, and this is the number of pages it will walk before
 * refusing -- so the limit the message names is the limit that exists.
 */
const COMMENT_KEYS = ['issueComments', 'reviewComments', 'reviews'];

const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * The marker the reviewer writes at the END of a successful post. Anchored at
 * both ends and tolerant of surrounding whitespace only -- a loose pattern here
 * would let a contributor hand-write a passing marker into a PR comment.
 */
export const MARKER_RE = /<!--\s*ifc-lite-review\s+sha=([0-9a-f]{40})\s+verdict=(clean|findings|nothing-to-review|dropped)\s+count=(\d+)(?:\s+omitted=(\d+))?\s*-->/;

/** Block the runner without a dependency. This job's whole purpose is to wait. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
  // Read once and branch on the error code, rather than stat-then-read.
  // `existsOrThrow` exists for gates that DISCOVER paths by walking, where a
  // false from `existsSync` silently drops a package from an audit. Here the
  // file is opened on the next line and `readFileSync` already separates ENOENT
  // from EACCES, so the extra syscall bought a TOCTOU window and a second throw
  // site and nothing else.
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ReviewPostedError(
        'NO_CONFIG',
        `Config \`${path}\` is missing. A missing reviewer list is NOT an empty one: with no ` +
          'expected authors this gate would accept a marker from anybody, so it refuses instead.',
      );
    }
    throw new ReviewPostedError('BAD_CONFIG', `Cannot read config \`${path}\`: ${err.code || err.message}.`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new ReviewPostedError('BAD_CONFIG', `Config \`${path}\` is not valid JSON: ${err.message}`);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ReviewPostedError(
      'BAD_CONFIG',
      `Config \`${path}\` parsed as ${cfg === null ? 'null' : Array.isArray(cfg) ? 'an array' : typeof cfg}, ` +
        'not an object. Reaching for a key on it would throw a TypeError past this file\'s catch and ' +
        'print a stack trace instead of a remedy.',
    );
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
/**
 * A Map, not an object literal. `{...}[name]` reaches Object.prototype, so
 * `--constructor x` returned a truthy key, sailed past the `!key` guard, and
 * wrote a junk property instead of refusing -- a guard that did not guard what
 * it claimed. There is also no `--` handling: nothing in this repo passes it,
 * and the previous line skipped the token while continuing to parse everything
 * after it as flags, which is the opposite of what `--` conventionally means.
 */
const FLAGS = new Map([
  ['--pr', 'pr'],
  ['--repo', 'repo'],
  ['--sha', 'sha'],
  ['--config', 'config'],
  ['--state-file', 'stateFile'],
  ['--timeout-seconds', 'timeoutSeconds'],
]);

export function parseArgs(argv) {
  const out = {
    pr: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    sha: null,
    config: DEFAULT_CONFIG,
    stateFile: null,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = FLAGS.get(argv[i]);
    if (!key) throw new ReviewPostedError('BAD_ARGS', `Unrecognised argument \`${argv[i]}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new ReviewPostedError('BAD_ARGS', `\`${argv[i]}\` needs a value.`);
    if (key === 'timeoutSeconds') {
      // Rejected BEFORE coercion, because the dangerous value is not NaN, it is
      // the EMPTY STRING: `Number('')` is 0, which is finite and non-negative, so
      // an unset or blank CI variable would silently disable the poll -- and a
      // gate that does not poll is red on every push, which is the exact fatal
      // behaviour the poll exists to fix. An explicit `0` stays legal; a blank
      // does not. NaN is rejected for the other half: it loses every comparison,
      // so a NaN deadline never behaves like a deadline.
      const trimmed = String(v).trim();
      const n = trimmed === '' ? NaN : Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        throw new ReviewPostedError('BAD_ARGS', `\`--timeout-seconds\` must be a non-negative number; got ${JSON.stringify(v)}.`);
      }
      out[key] = n;
    } else out[key] = v;
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
 * @returns {{ author: string, body: string, surface: string,
 *             raw: object | null }[]} `raw` is the untouched API row for an
 *   inline comment and `null` for an issue comment, which has no anchor at all.
 *   It is carried rather than adjudicated -- see the note at the push below.
 */
export function normaliseComments(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ReviewPostedError('NO_PAYLOAD', 'No comment payload to adjudicate.');
  }
  const out = [];
  for (const key of COMMENT_KEYS) {
    const list = payload[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new ReviewPostedError('BAD_PAYLOAD', `\`${key}\` is present but is not an array.`);
    }
    if (payload.truncated?.includes(key)) {
      throw new ReviewPostedError(
        'COMMENTS_TRUNCATED',
        `\`${key}\` still had more pages after ${MAX_PAGES} x ${PER_PAGE} entries, so the marker ` +
          'may be on a page this gate never read. Refusing to report "not posted" for a list it ' +
          'could not finish reading. REMEDY: raise MAX_PAGES, or narrow what the reviewer posts.',
      );
    }
    for (const c of list) {
      out.push({
        author: normaliseLogin(c?.user?.login ?? c?.author?.login),
        body: String(c?.body ?? ''),
        surface: key,
        // THE RAW ROW, CARRIED RATHER THAN ADJUDICATED HERE. `writtenAtSha` is
        // read through `inlineCommentAnchors` at the one place that counts
        // findings, AFTER the author scope -- see `evaluate`. Reading it here
        // would refuse the whole gate over a malformed comment by someone this
        // check never counts, which is the blast radius `staleReviews` already
        // rules out in as many words ("scope FIRST, then validate").
        raw: key === 'reviewComments' ? c : null,
      });
    }
  }
  // Same list the loop walks. These had drifted: the loop read three surfaces
  // and the guard checked two, so a payload carrying only an empty `reviews` was
  // NO_PAYLOAD while a non-empty one was first-class.
  if (out.length === 0 && !COMMENT_KEYS.some((k) => payload[k] !== undefined)) {
    throw new ReviewPostedError('NO_PAYLOAD', 'Payload carried no comment lists at all.');
  }
  return out;
}

/**
 * The verdict. `ok` is true only when an expected author posted a well-formed
 * marker naming exactly `headSha`.
 *
 * @returns {{ ok: boolean, full: boolean, verdict: string, lines: string[] }}
 *   TWO QUESTIONS, and each has exactly one consumer.
 *
 *   `ok` is "should this check go red" -- the exit code, modulated by `mode`.
 *   `main()` also writes it out as the `covered=` step output claude-review.yml
 *   dedups on (`steps.dedup.outputs.covered`, which gates every later step in
 *   that job): a verdict this function reaches at all -- red or green -- means a
 *   marker naming this head exists and the lane has run, so `covered` is `ok`
 *   itself, not a field this function needs to compute separately. There USED
 *   TO be a third, `covered`, returned alongside `ok` and always equal to it at
 *   every one of this function's five return sites -- one field asserting what
 *   the other already said.
 *
 *   `full` is "was the WHOLE diff reviewed", and it is the stand-down decision:
 *   review-posted.yml turns it into the `llm-reviewed` label, which is what
 *   .coderabbit.yaml reads to stay off the PR. It is false on two shapes that
 *   are nonetheless `ok`: `nothing-to-review`, because nothing read the diff at
 *   all, and any marker carrying `omitted>0` (#3679), because nothing read the
 *   omitted files.
 *
 *   `dropped` is the one verdict where `ok` is FALSE. It says the reviewer ran,
 *   was retried, and every finding it produced was refused -- so nothing was
 *   posted, and treating it as covered would seal the head against ever being
 *   reviewed. It is also `terminal`: the lane job that wrote it has exited, so
 *   the poll below must not wait for a verdict that is never coming.
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
      // ONE ENTRY, not two. An exempt run filters `REMEDY:` lines out, and a
      // remedy split across two array entries loses its head and prints the
      // tail -- dangling prose that still said "rather than re-running
      // indefinitely" beside an exemption saying no re-run can help. Caught in
      // review; the test could not see it because it asserted only that no line
      // STARTS with REMEDY.
      '   REMEDY: re-run the review job. If it recurs, read the run log for `Posted 0/N` or a low ' +
        '`num_turns` and attach it to the upstream issue rather than re-running indefinitely.',
    );
    return { ok: false, full: false, verdict: 'NOT_POSTED', lines };
  }

  const markers = [];
  let sawUnparseable = false;
  for (const c of mine) {
    const m = MARKER_RE.exec(c.body);
    if (m) markers.push({ sha: m[1], verdict: m[2], count: Number(m[3]), omitted: m[4] ? Number(m[4]) : 0 });
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
            '`<!-- ifc-lite-review sha=<40-hex> verdict=clean|findings|nothing-to-review|dropped count=<n>' +
            '[ omitted=<n>] -->`.'
          : 're-run the review job.'),
    );
    return { ok: false, full: false, verdict: sawUnparseable ? 'MARKER_MALFORMED' : 'NOT_POSTED', lines };
  }

  const match = markers.find((m) => m.sha === headSha);
  if (!match) {
    lines.push(
      `❌ STALE_REVIEW: the most recent marker this gate read names ${markers[markers.length - 1].sha.slice(0, 9)}, ` +
        `but this PR's head is ${headSha.slice(0, 9)}.`,
      '   A review of an earlier head has not reviewed this diff. A comment\'s `commit_id` cannot',
      '   settle this either: GitHub relocates that field onto a later head (#3729), with or without',
      '   a force-push, so only the marker the',
      '   reviewer wrote at review time says which commit it read. ("Most recent" is fetch order, not',
      '   timestamp: this gate reads no timestamp at all, so it does not claim one.)',
      '   REMEDY: re-run the review job against the current head.',
    );
    return { ok: false, full: false, verdict: 'STALE_REVIEW', lines };
  }

  // `dropped` IS THE ONE VERDICT THAT IS NOT `ok` (#3775). Every other marker
  // means the lane reached a conclusion about this head, so `covered` (which
  // `main()` writes as `ok`) is true and claude-review.yml skips the head. This
  // one means the opposite: the reviewer ran, was retried once, and NONE of its
  // findings survived validation -- so nothing was posted and nothing vouches for
  // the diff. Marking it covered would SEAL the head: the first all-dropped run
  // would be the last, and a harness regression dropping every finding on every
  // PR would go quiet instead of red.
  //
  // So it fails, and the failure is CLEARABLE, which is the difference from an
  // unclearable red: the marker records what happened for a reader, the head
  // stays uncovered, and the next run reviews it again for real.
  if (match.verdict === 'dropped') {
    lines.push(
      `❌ FINDINGS_ALL_DROPPED: the reviewer reached ${headSha.slice(0, 9)} and every finding it ` +
        'produced was refused by validation, so nothing was posted.',
      '   The marker records that outcome so the run is not invisible; it is NOT a verdict on the',
      '   diff. Nothing here was reviewed to a posted conclusion, so `full` and `covered` are both',
      '   false: CodeRabbit must not stand down, and the lane is free to review this head again.',
      '   The marker comment names which findings were dropped and why.',
      '   REMEDY: re-run the review job. The lane already retries this once on its own, so a',
      '   marker you can see means the retry was refused too -- if it recurs on the same head,',
      '   read the named reasons rather than re-running indefinitely.',
    );
    // TERMINAL. Not `ok`, and yet there is nothing to wait for: the lane job that
    // wrote this marker has EXITED, so no later read of this head can find
    // anything else. Without the flag the poll waits on `!ok` alone and sits out
    // its whole budget -- ~25 minutes and ~200 API calls against a 1,000/hour
    // token shared with three other jobs -- to print a verdict the first read had.
    return { ok: false, full: false, terminal: true, verdict: 'FINDINGS_ALL_DROPPED', escapeHatch: null, lines };
  }

  // THE #1679 CROSS-CHECK. A marker claiming `verdict=findings count=N` while N
  // findings never reached the PR is precisely the shape #1679 describes: the
  // summary posts, the inline comments drop, `Posted 0/N` is logged, and the job
  // exits 0. The docblock cites that bug as founding case law, so the gate has to
  // be able to see it rather than trusting the count the marker asserts.
  //
  // Counted across every comment from an expected author EXCEPT the marker's own
  // carrier, since a summary comment is not itself a finding.
  if (match.verdict === 'findings') {
    // COUNTED FROM INLINE COMMENTS ON THIS HEAD ONLY. An earlier version counted
    // every non-carrier comment from an expected author, which made the check
    // inert on most PRs here: benchmark.yml posts a summary comment as
    // `github-actions` on any PR touching rust/, packages/, apps/viewer/ or
    // Cargo.*, and that one comment satisfied `others >= 1` forever. Stale
    // findings from an earlier head did the same. Both let a marker claiming
    // three findings pass with all three dropped -- the exact #1679 shape the
    // check exists to catch.
    //
    // AND COUNTED FROM `original_commit_id`, NOT `commit_id` (#3729). The prose
    // above was already right; the FIELD was wrong -- a finding from an earlier
    // head REPORTED this head and satisfied the very clause this paragraph says
    // it must not. The measurement is in scripts/lib/review-provenance.mjs.
    const posted = comments.filter(
      (c) =>
        c.surface === 'reviewComments' &&
        cfg.expectedAuthors.has(c.author) &&
        // SCOPED FIRST, THEN READ. `inlineCommentAnchors` refuses an
        // unreadable row, and only a row this check would have COUNTED may
        // take the gate down.
        wroteAtCommit(c.raw, headSha),
    ).length;
    if (posted === 0) {
      lines.push(
        `❌ FINDINGS_NOT_POSTED: the marker claims ${match.count} finding(s) for ` +
          `${headSha.slice(0, 9)}, and no inline finding from an expected reviewer is anchored to it.`,
        '   This is the #1679 shape exactly: the summary posts, the inline comments drop, the run',
        '   logs `Posted 0/N`, and the job exits 0. The count in the marker is the reviewer\'s own',
        '   claim; this is the check that it is true.',
        '   Only INLINE comments on THIS head count. A summary comment is not a finding, and a',
        '   finding on an earlier head is not a finding on this diff.',
        '   REMEDY: re-run the review job. If it recurs, the run log will show `Posted 0/N`; ' +
          'attach it to claude-code-action#1679 rather than re-running indefinitely.',
      );
      return { ok: false, full: false, verdict: 'FINDINGS_NOT_POSTED', escapeHatch: null, lines };
    }
  }

  lines.push(
    match.verdict === 'nothing-to-review'
      ? `✅ REVIEW_POSTED: the reviewer reached ${headSha.slice(0, 9)} and reported NOTHING TO REVIEW — ` +
        'the comment itself says why (every changed path excluded, or no part of the diff fitting the ' +
        'model prompt). That is a decision the lane made and POSTED, not a statement that the diff was ' +
        'read and is fine. The distinction is the point: a `clean` marker here would certify these PRs ' +
        'as reviewed, and an exclusion-list bug would then do it silently for every PR it swallowed.'
      : `✅ REVIEW_POSTED: an expected reviewer posted a ${match.verdict} verdict for ${headSha.slice(0, 9)}` +
        `${match.verdict === 'findings' ? ` with ${match.count} finding(s)` : ''}.`,
    match.verdict === 'nothing-to-review'
      ? '   FULL=FALSE, though: nobody read this diff, so CodeRabbit must NOT stand down on it.'
      : '   This proves a review REACHED the pull request for this exact commit.',
    '   It proves nothing about whether the review was any good; precision is a separate',
    '   instrument.',
  );
  // ABSENCE STAYS VISIBLE AT THIS SURFACE TOO. The marker's `omitted` count is
  // how a degraded review (#3679) says which part of the diff nothing vouches
  // for; swallowing it here would let a partial review read as a full one.
  if (match.omitted > 0) {
    lines.push(
      `   ⚠️ PARTIAL: ${match.omitted} changed file(s) were NOT shown to the reviewer -- too large to ` +
        'fit the model prompt, or too large for GitHub to return a patch for (#3679). The review comment ' +
        'names them; the verdict above covers only the files that were sent.',
      '   FULL=FALSE, therefore: nothing vouches for the omitted files, so CodeRabbit must NOT stand',
      '   down on this head. COVERED stays true, so re-triggering the lane will NOT re-review the',
      '   files that were sent and post their findings twice.',
      '   REMEDY: split the PR so every changed file fits the prompt, or review the named files by hand.',
    );
  }
  // A marker naming this head EXISTS, so `ok` is true here whatever the verdict
  // says: the lane has run and, via `main()`'s `covered=${ok}`, must not run
  // again on the same SHA.
  //
  // `full` is the other question. A `nothing-to-review` head was never READ --
  // the model never ran -- so standing CodeRabbit down on it would leave the PR
  // reviewed by NOBODY (raised by CodeRabbit on PR #3587). A PARTIAL head
  // (#3679) fails it for the same reason on the omitted slice: granting
  // `llm-reviewed` would stand CodeRabbit down on exactly the files this gate
  // has just announced nobody vouches for, the gate contradicting itself in the
  // same breath. Raised by CodeRabbit on PR #3688.
  //
  // `dropped` is the one verdict that does NOT reach here -- it returns above,
  // not `ok` -- because nothing was posted for it to re-post, so the argument
  // below does not apply to it.
  //
  // BOTH STAY `ok`, and that is the correction to the first attempt at this.
  // Making a partial head's dedup key false fixed the stand-down and broke the
  // dedup: claude-review.yml gates its whole job on that output, so every
  // re-trigger of a partial head would re-run the model over the files that DID
  // fit and post their inline comments again.
  return {
    ok: true,
    full: match.verdict !== 'nothing-to-review' && match.omitted === 0,
    verdict: 'REVIEW_POSTED',
    lines,
  };
}

/**
 * All THREE comment surfaces, explicitly paged.
 *
 * `pulls/{n}/comments` is the inline-review-comment surface and was missing while
 * the docstring claimed both were read -- which mattered: it is where a reviewer
 * posting per-finding comments puts them, and it is the surface #1679 drops
 * ("Posted 0/N"). A gate that cites #1679 has to be able to see the thing #1679
 * loses.
 *
 * Paged by hand rather than `--paginate --slurp` so the page bound this gate
 * reports is the page bound it applies.
 */
/**
 * Walk one surface, page by page, and say honestly whether it finished.
 *
 * Pure over an injected `fetchPage` so the pager is testable without a network.
 * It was not, and that mattered: "the bound is now REAL" was asserted on a test
 * that hand-fed `{ truncated: [...] }` straight to the evaluator and never ran a
 * single page.
 *
 * @param {(page: number, perPage: number) => unknown[]} fetchPage
 * @returns {{ rows: unknown[], truncated: boolean }}
 */
export function pageAll(fetchPage, { maxPages = MAX_PAGES, perPage = PER_PAGE } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = fetchPage(page, perPage);
    if (!Array.isArray(batch)) {
      throw new ReviewPostedError('BAD_PAYLOAD', `page ${page} was not an array.`);
    }
    rows.push(...batch);
    if (batch.length < perPage) return { rows, truncated: false };
    // Probe one past a full final page rather than calling it truncated: a
    // surface holding exactly maxPages x perPage entries is FULLY READ, and
    // reporting it unread is the permanent unclearable refusal this pager was
    // written to remove -- moved, not fixed.
    if (page === maxPages) {
      const probe = fetchPage(maxPages * perPage + 1, 1);
      if (Array.isArray(probe) && probe.length === 0) return { rows, truncated: false };
    }
  }
  return { rows, truncated: true };
}

function fetchPayload(repo, pr) {
  const surfaces = {
    issueComments: `repos/${repo}/issues/${pr}/comments`,
    reviews: `repos/${repo}/pulls/${pr}/reviews`,
    reviewComments: `repos/${repo}/pulls/${pr}/comments`,
  };
  const out = { truncated: [] };
  for (const [key, path] of Object.entries(surfaces)) {
    const { rows, truncated } = pageAll((page, perPage) =>
      gh(['api', `${path}?per_page=${perPage}&page=${page}`, '--method', 'GET'], `${key} page ${page}`, ReviewPostedError),
    );
    if (truncated) out.truncated.push(key);
    out[key] = rows;
  }
  return out;
}

/**
 * Is this PR from a FORK? Asked of the API, never taken from the caller.
 *
 * It matters because the lane cannot post on a fork: claude-review.yml excludes
 * fork PRs outright, since a fork's GITHUB_TOKEN is read-only whatever
 * `permissions:` says. So under `mode: enforcing` every fork PR would be a
 * NOT_POSTED red that no re-run and no contributor action could ever clear --
 * the same unclearable-red class as a PR with nothing reviewable in it, and the
 * worst possible greeting for an outside contributor.
 *
 * NOT read from the workflow. `review-posted.yml` runs from the PR's own
 * checkout, so a flag passed there would be a flag a fork PR could edit. This
 * asks the API.
 *
 * `headRepo` in a `--state-file` payload overrides the read, and ONLY there.
 * That is what makes this branch reachable by the harness at all: gating it on
 * `!args.stateFile` would have shipped an enforcement carve-out no test could
 * execute, which is the shape this repository keeps paying for.
 */
function prExemption(repo, pr, override) {
  // NO REPO, NO VERDICT. `args.repo` is only refused inside the live branch, so
  // in `--state-file` mode it can be null -- and `headRepo !== null` is true for
  // every value, which would excuse EVERY failing verdict. The invariant belongs
  // here rather than in the harness's discipline of always passing `--repo`:
  // discipline is prose holding two things together, and this gate exists
  // because that does not hold. Raised by CodeRabbit on PR #3587.
  if (typeof repo !== 'string' || repo === '') {
    throw new ReviewPostedError(
      'NO_REPO',
      'The fork check needs a repository to compare the head against, and none was resolved. ' +
        'Pass `--repo owner/name` or set GITHUB_REPOSITORY. Without it every failing verdict would ' +
        'read as a fork and be excused, which is a gate that cannot fail.',
    );
  }
  const data =
    override === undefined
      ? gh(['api', `repos/${repo}/pulls/${pr}`, '--method', 'GET'], 'the PR head repo', ReviewPostedError)
      : { head: { repo: { full_name: override.headRepo } }, draft: override.draft === true };
  const headRepo = data?.head?.repo?.full_name;
  if (typeof headRepo !== 'string' || headRepo === '') {
    throw new ReviewPostedError(
      'NO_HEAD_REPO',
      `PR #${pr} returned no head repository, so this gate cannot tell a fork from a branch. It refuses ` +
        'rather than guess: guessing "not a fork" would enforce against a PR that can never post a ' +
        'marker, and guessing "fork" would silently downgrade the gate on every PR.',
    );
  }
  // CASE-INSENSITIVE. GitHub repository names are case-insensitive, and `--repo`
  // is caller-supplied: `ltplus-ag/ifc-lite` against a head repo of
  // `LTplus-AG/ifc-lite` would otherwise read as a FORK and turn enforcement off
  // for every PR. Same normalisation the author matching already uses.
  // TWO EXEMPTIONS, ONE READ. Both are cases where the LANE cannot post, so the
  // gate would be demanding a marker nobody is able to write.
  //
  // DRAFTS. `claude-review.yml` gates the job on `draft == false`; this workflow
  // has no `if:` at all and runs on drafts anyway. Under `enforcing` that made
  // every same-repo DRAFT PR a permanent red -- the lane skips identically on
  // every re-run, so the printed "re-run the review job" could never clear it.
  // Third instance of that class after nothing-reviewable and forks, missed
  // because the first two were about WHO posts and this one is about WHEN.
  // Found by review of the contributor docs, not by the gate's own tests.
  if (data?.draft === true) return { exempt: true, why: 'DRAFT' };
  return {
    exempt: headRepo.toLowerCase() !== repo.toLowerCase(),
    why: 'FORK',
  };
}

/**
 * Is another read of this head worth making?
 *
 * NOT simply `!ok`. Most failing verdicts describe an ABSENCE -- no marker yet,
 * findings not visible yet -- and the whole reason this loop exists is that the
 * reviewer takes minutes and no event re-fires this gate when its comment lands.
 * `FINDINGS_ALL_DROPPED` is the opposite shape: the lane reached a conclusion,
 * wrote it, and exited. Waiting on it spends the entire budget to reprint a
 * verdict the first read already had.
 *
 * A separate predicate rather than a longer `while`, because the loop cannot be
 * driven from a test without a network and this decision can.
 *
 * @param {{ok: boolean, terminal?: boolean}} result
 */
export function shouldKeepPolling(result) {
  return !result.ok && result.terminal !== true;
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
    try {
      payload = JSON.parse(readFileSync(args.stateFile, 'utf8'));
    } catch (err) {
      throw new ReviewPostedError('BAD_STATE_FILE', `Cannot read \`${args.stateFile}\`: ${err.message}`);
    }
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

  // THE POLL. A single read races the reviewer and loses: this job starts seconds
  // after the push, the reviewer takes minutes, and no event re-fires this gate
  // when the comment lands. Re-read until the verdict is OK or the budget is
  // spent. A REFUSAL (bad payload, truncation) throws out of here immediately --
  // waiting cannot fix an input this gate could not read.
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let comments = normaliseComments(payload);
  let result = evaluate({ comments, cfg, headSha: args.sha });
  let waited = 0;
  while (shouldKeepPolling(result) && !args.stateFile && Date.now() < deadline) {
    sleepSync(POLL_SECONDS * 1000);
    waited += POLL_SECONDS;
    // ONE call per tick, not three. The marker lands on the issue-comment
    // surface, so that is the only surface worth watching; the other two are
    // fetched once, after it appears, for the findings cross-check. At three
    // surfaces per tick this gate alone would have spent ~120 of the repository's
    // 1,000/hour GITHUB_TOKEN budget per run, shared with benchmark.yml and two
    // sibling gates, and exhausting it fails THEM as well as this.
    // THE LAST PAGE, NOT THE FIRST. GitHub returns issue comments oldest-first,
    // so a marker posted DURING the wait lands at the end. Probing page 1 meant
    // that on any PR with more than PER_PAGE comments the probe could never see
    // the very comment it was waiting for: the full refetch never fired and the
    // gate reported NOT_POSTED after a full budget of waiting, on a PR that had
    // in fact been reviewed. Caught in review of #3580.
    //
    // Still one call per tick: `page=` past the end returns an empty array, and
    // the count from the previous full read tells us where the end is.
    const lastPage = Math.max(1, Math.ceil(comments.length / PER_PAGE));
    const probe = normaliseComments({
      issueComments: gh(
        ['api', `repos/${args.repo}/issues/${args.pr}/comments?per_page=${PER_PAGE}&page=${lastPage}`, '--method', 'GET'],
        'the PR comment list',
        ReviewPostedError,
      ),
    });
    if (!probe.some((c) => cfg.expectedAuthors.has(c.author) && MARKER_RE.test(c.body))) continue;
    comments = normaliseComments(fetchPayload(args.repo, args.pr));
    result = evaluate({ comments, cfg, headSha: args.sha });
  }

  console.log(`Comments read: ${comments.length}`);
  console.log(`Head: ${args.sha.slice(0, 9)}`);
  if (waited > 0) console.log(`Waited ${waited}s for a verdict to appear.`);
  console.log('');

  const { ok, full, lines } = result;

  // THE EXEMPTION IS RESOLVED BEFORE THE VERDICT IS PRINTED, so a remedy that
  // cannot work is never shown. The failing verdicts end in
  // `REMEDY: re-run the review job`, which is right for a quota blip and WRONG
  // for a draft or a fork: no re-run can produce a marker the lane will not
  // write. Printing both left the reader with two instructions that contradict
  // each other, which this repository treats as a defect in its own right --
  // "each distinct failure class names a remedy, and the remedy does not
  // contradict the finding". Raised by CodeRabbit on PR #3598.
  const exemption =
    ok
      ? { exempt: false }
      : prExemption(
          args.repo,
          args.pr,
          args.stateFile ? { headRepo: payload?.headRepo, draft: payload?.draft } : undefined,
        );

  for (const l of lines) {
    if (exemption.exempt && /^\s*REMEDY:/.test(l)) continue;
    console.log(l);
  }

  // BOTH ARE VERDICTS, independent of the exit code, and that independence is
  // the point: in advisory mode a failing verdict still exits 0, so a caller
  // inferring either value from `$?` would treat an unreviewed PR as reviewed.
  // Anything downstream must read THESE, never the exit code.
  //
  // `covered` is claude-review.yml's dedup key: true means "a verdict exists for
  // this head, do not run the model again" -- which is exactly what `ok` means
  // by the time this function reaches a verdict at all, so it is written
  // straight from `ok` rather than carried as its own field on `result` (it
  // used to be, always equal to `ok` at every one of `evaluate`'s five return
  // sites). `full` is review-posted.yml's stand-down key: true means "the whole
  // diff was reviewed, CodeRabbit may stay off". They are written as two lines
  // because they are two questions; a single value answering both got one of
  // them wrong in each direction (#3679, #3688).
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `covered=${ok ? 'true' : 'false'}\nfull=${full ? 'true' : 'false'}\n`,
    );
  }

  // FORK PRs ARE NEVER ENFORCED, in either mode, and the reason is the same one
  // that makes an unreviewable PR post a marker rather than nothing: the lane
  // CANNOT run here, so the red would be permanent and no contributor could
  // clear it. Reported in full so it is not silence -- the verdict text above is
  // unchanged -- but it does not fail the job. Checked only when the verdict is
  // already failing, so THIS gate does not pay the extra API read on its common
  // path. `claude-review.yml`'s dedup step is different: a failing verdict IS its
  // common case, so once the base config is `enforcing` every lane run pays one
  // `gh api pulls/<n>` there. One call, named rather than left to be discovered.
  if (exemption.exempt) {
    console.log('');
    console.log(
      exemption.why === 'DRAFT'
        ? 'DRAFT PR: the finding above does not fail this job. `claude-review.yml` skips drafts, so no ' +
          'marker can be written while this PR is a draft and enforcing would be a red no re-run could ' +
          'clear. Mark it ready for review and the lane will review the head.'
        : 'FORK PR: the finding above does not fail this job. `claude-review.yml` excludes fork PRs, ' +
          "because a fork's GITHUB_TOKEN is read-only whatever `permissions:` says, so no marker can " +
          'ever be posted here and enforcing would be a red nobody can clear. These PRs are covered by ' +
          'the CodeRabbit lane, which is why the stand-down label is never applied to them.',
    );
    process.exit(0);
  }
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
    if (
      err instanceof ReviewPostedError ||
      err instanceof GhError ||
      err instanceof ReviewProvenanceError
    ) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      // A REFUSAL IS NOT COVERAGE. Every refusal path -- GH_ERROR, truncation,
      // a bad config, a killed poll -- previously left `covered` unwritten, and
      // the label step skipped on an empty value, so a PR carrying the label
      // from an earlier head kept it through any number of refused runs. That is
      // a stale stand-down, which is what STALE_REVIEW exists to prevent.
      if (process.env.GITHUB_OUTPUT) {
        try {
          appendFileSync(process.env.GITHUB_OUTPUT, 'covered=false\nfull=false\n');
        } catch {
          // The refusal above is the finding; failing to annotate it is not worth
          // masking it with a second error.
        }
      }
      process.exit(1);
    }
    throw err;
  }
}
