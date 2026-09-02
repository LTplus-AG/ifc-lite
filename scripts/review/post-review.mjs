#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE MARKER IS WRITTEN LAST, AND THAT ORDER IS THE ENTIRE POINT OF THIS FILE.
 *
 * WHY THIS EXISTS. `anthropics/claude-code-action` #1679 is OPEN (bug, p2,
 * 2026-08-16): "post-buffered-inline-comments exits 0 after failing to post
 * every comment", reported as FORTY CONSECUTIVE RUNS logging `Posted 0/N` while
 * the job went green. The review ran. The findings existed. Zero comments
 * reached the pull request. Nothing in the exit code, and nothing in a
 * `--json-schema` result, can tell that run apart from a successful one: the
 * schema describes what the model PRODUCED, not what the pull request RECEIVED.
 *
 * This repository has already paid for the same defect from the other side: 174
 * of 830 merged PRs in August 2026 (21%, 46,717 lines) carried no review of any
 * kind while showing green, and #3175 then had to correct TWELVE changesets by
 * hand that would have shipped breaking changes as `patch`, with the release one
 * command from publishing. ABSENCE MUST NOT READ AS SUCCESS.
 *
 * `scripts/check-review-posted.mjs` is the gate that adjudicates the marker this
 * script writes. THIS IS THE ONLY WRITER OF THAT MARKER, and it is built so the
 * #1679 shape cannot survive it: the marker is written ONLY after the inline
 * comments have been READ BACK FROM THE PULL REQUEST. A comment we sent is not
 * evidence; a comment GitHub hands back on a subsequent GET is.
 *
 * THE ORDER, and it is not negotiable:
 *
 *   1. RE-READ THE HEAD. If the PR has moved past `--sha`, exit 0 as
 *      SKIPPED_STALE and post NOTHING. The newer event's run owns the new head.
 *      Posting for a dead head would leave a marker the gate then calls
 *      STALE_REVIEW -- a red that no re-run of THIS commit can clear.
 *   2. POST each finding to `pulls/{n}/comments` with `commit_id`, `side=RIGHT`,
 *      `line`, `path`, `body`, checking every response for a comment id. Any
 *      failure aborts with exit 1 and NO marker. Findings already present on
 *      this head (fingerprinted) are SKIPPED, so a crash-and-rerun does not
 *      double-post.
 *   3. READ BACK. `GET pulls/{n}/comments`, count comments from our identity
 *      whose `commit_id` is exactly this head. This DELIBERATELY DUPLICATES the
 *      gate's own FINDINGS_NOT_POSTED predicate -- same surface, same author
 *      filter, same commit-id filter -- so a green poster implies a green gate
 *      and the two cannot drift into disagreement. The duplication is checked by
 *      EXECUTION, not by prose: post-review.test.mjs feeds what this script
 *      actually posted straight into the real gate as a process and asserts
 *      REVIEW_POSTED.
 *   4. ONLY THEN write one issue comment carrying the marker, whose `count` is
 *      the number CONFIRMED in step 3 -- never the number the model claimed.
 *      That is the whole difference between a marker and a receipt.
 *   5. READ THE MARKER BACK once. A marker we could not read is a marker the
 *      gate may not be able to read either.
 *
 * A failure at ANY step leaves the pull request marker-less, so the gate reads
 * NOT_POSTED (its remedy: re-run the review job) and the re-run is safe.
 *
 * THE OTHER HALF OF THE CONTRACT: THE REVIEWER MUST POST ON EVERY RUN, INCLUDING
 * A CLEAN ONE. A reviewer that stays silent when it finds nothing makes
 * "reviewed and found nothing" byte-identical to "never ran", which is exactly
 * the trap CodeRabbit falls into here. So a clean run posts a `verdict=clean`
 * marker, and silence therefore means failure.
 *
 * FAILURE CLASSES, each with its OWN remedy, because a remedy that contradicts
 * its finding is worse than no remedy:
 *
 *   SKIPPED_STALE       Not a failure. The head moved while we worked; exit 0,
 *                       nothing posted. REMEDY: none. The run triggered by the
 *                       new head owns it.
 *   AUTHOR_NOT_EXPECTED `--author` is not in the gate's `expectedAuthors`. We
 *                       would post a marker the gate ignores -- a green poster
 *                       over a red gate. Refused BEFORE anything is posted.
 *                       REMEDY: add the login to review-posted.config.json (on
 *                       the BASE branch, which is the copy the gate reads), or
 *                       fix `--author`.
 *   NO_FINDINGS_FILE /  The findings file is missing, unparseable, or not one of
 *   BAD_FINDINGS /      the two accepted shapes, or a row lacks a usable
 *   BAD_FINDING         path/line/body. NEVER read as "clean": an unreadable
 *                       findings file is the absence-reads-as-success defect one
 *                       layer below where this gate usually catches it.
 *                       REMEDY: fix the reviewer's findings writer.
 *   HEAD_UNREADABLE     The PR object came back without a 40-hex head sha.
 *                       REMEDY: check the token's `pull-requests` scope; do not
 *                       proceed on a guessed head.
 *   INLINE_POST_FAILED  A `pulls/{n}/comments` POST threw, or returned 2xx with
 *                       no comment id. THIS IS #1679 CAUGHT AT THE SOURCE.
 *                       REMEDY: re-run. A 422 here usually means `line` is not
 *                       in this commit's diff; fix the finding's anchor.
 *   READBACK_SHORT      Fewer findings are visible on the PR than the findings
 *                       file holds. THIS IS #1679 CAUGHT AT THE READ-BACK: every
 *                       POST reported success and the comments are not there.
 *                       REMEDY: re-run. If it recurs, attach the log to
 *                       claude-code-action#1679 rather than re-running forever.
 *   CLEAN_CONTRADICTED  A clean verdict while our own inline findings are
 *                       anchored to this exact head. One of the two runs is
 *                       wrong and a `verdict=clean` marker would bury it.
 *                       REMEDY: re-run the review; if the findings are genuinely
 *                       withdrawn, delete those inline comments first.
 *   SUMMARY_POST_FAILED The marker comment POST/PATCH returned no id.
 *                       REMEDY: check that the posting workflow has write access
 *                       to the pull request, then re-run.
 *   MARKER_NOT_READ_BACK The marker is not readable on the PR one GET after it
 *                       was written. REMEDY: re-run. The gate reads NOT_POSTED
 *                       until it is, which is the correct direction to fail.
 *   COMMENTS_TRUNCATED  A comment surface still had pages after the bounded
 *                       walk, so a finding may be on a page never read. Refuses
 *                       rather than guessing. REMEDY: raise the pager's budget,
 *                       or narrow what the reviewer posts.
 *   BAD_ARGS / NO_PR / NO_REPO / NO_SHA  Broken invocation. REMEDY per message;
 *                       all fail closed, none post.
 *
 * WHY THERE IS NO TEST SEAM IN THIS FILE. There is no `--gh-state`, no injected
 * transport, no `if (process.env.TEST)`. The harness puts a fake `gh` on PATH,
 * so the code CI runs and the code the tests run are the same bytes, ordering
 * included. A seam here would be a second implementation of the one thing this
 * file exists to get right, and it would be the copy nobody exercises.
 *
 * STATED HOLES, so nobody reads a green here as more than it is:
 *
 *   1. It proves the findings REACHED the pull request. It proves nothing about
 *      whether they were any good, or whether the model read the whole diff.
 *      Precision and recall are separate instruments.
 *   2. `--author` is a CLAIM about who we post as. It is verified on a findings
 *      run (the read-back filters on it, so a wrong login yields zero and fails
 *      READBACK_SHORT) and again on the marker read-back. On a CLEAN run with a
 *      wrong login the marker posts before the read-back refuses it: exit 1 with
 *      a marker present is possible only on that one path, and the gate then
 *      reads NOT_POSTED, which is still the safe direction.
 *   3. The dedupe fingerprint uses `path`, `line` and the body, NUL-separated so
 *      no path or body can forge a boundary. GitHub returns
 *      `line: null` for a comment that has gone outdated, so such a comment does
 *      not match and the finding is posted again. A duplicate comment is noise;
 *      a missing one would be a lie, so the fingerprint fails towards noise on
 *      purpose.
 *   4. `--author` is checked against the config path it was GIVEN. The gate reads
 *      the config from the BASE branch. Point `--config` at that same base copy
 *      or the agreement between poster and gate is only as good as the two files
 *      happening to match.
 *   5. Between the read-back and the marker write, a comment could be deleted.
 *      The window is one HTTP call wide and nothing here closes it.
 *   6. THE FALSE-POSITIVE FOOTER IS OMITTED ON A CLEAN RUN. "React with a thumbs
 *      down on a finding" printed where there are no findings is the same class
 *      of lie as a green tick over an unreviewed diff -- the sibling gate's own
 *      harness pins exactly that rule for its advisory notice. A deliberate
 *      deviation from the brief, stated rather than silently applied.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { gh, GhError } from '../lib/gh.mjs';
// The gate's own normaliser, pager and config reader, imported rather than
// re-spelled. Two copies held together only by prose is how the poster and the
// gate would come to disagree about who "we" are, or about where a page ends.
import { MARKER_RE, pageAll, normaliseLogin, readConfig, ReviewPostedError } from '../check-review-posted.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(HERE, '..', 'review-posted.config.json');

/** Longest index line in the summary. A summary that scrolls is a summary nobody reads. */
const INDEX_BODY_CHARS = 110;

export class PostReviewError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * A Map, not an object literal, for the reason the sibling gate records: a
 * `{...}[name]` lookup reaches Object.prototype, so `--constructor x` returns a
 * truthy key, sails past the `!key` guard and writes a junk property instead of
 * refusing.
 */
const FLAGS = new Map([
  ['--pr', 'pr'],
  ['--repo', 'repo'],
  ['--sha', 'sha'],
  ['--findings', 'findings'],
  ['--author', 'author'],
  ['--config', 'config'],
]);

/** Flags that take NO value. Kept separate so the value-consuming loop stays strict. */
const BOOL_FLAGS = new Map([['--nothing-to-review', 'nothingToReview']]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    pr: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    sha: null,
    findings: null,
    author: null,
    config: DEFAULT_CONFIG,
    nothingToReview: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const boolKey = BOOL_FLAGS.get(argv[i]);
    if (boolKey) {
      out[boolKey] = true;
      continue;
    }
    const key = FLAGS.get(argv[i]);
    if (!key) throw new PostReviewError('BAD_ARGS', `Unrecognised argument \`${argv[i]}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new PostReviewError('BAD_ARGS', `\`${argv[i]}\` needs a value.`);
    out[key] = v;
    i += 1;
  }
  return out;
}

/**
 * At most this many inline comments reach a human, and it is enforced HERE.
 *
 * It was enforced in the judge, which is the one step in the lane designed to be
 * skippable: the workflow's crash backstop does `cp findings.json judged.json`,
 * bypassing that module completely, and the validator's own ceiling is twelve.
 * So the cap held only when the optional filter succeeded, and the failure path
 * -- the one that runs when something has already gone wrong -- posted twelve.
 *
 * This module is the only one on the posting path that always runs.
 */
export const MAX_POSTED_FINDINGS = 5;

/**
 * The findings the model produced.
 *
 * BOTH plausible spellings are accepted -- a bare array, and `{ findings: [...] }`
 * -- and everything else REFUSES. The component writing this file is precisely
 * the unreliable one, so the failure that must not exist is a shape mismatch
 * read as "no findings": that would post a `verdict=clean` marker over a review
 * that found things, and nothing downstream can tell those two apart afterwards.
 *
 * @returns {{ path: string, line: number, body: string, title: string|null }[]}
 */

export function readFindings(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PostReviewError(
        'NO_FINDINGS_FILE',
        `Findings file \`${path}\` is missing. A missing findings file is NOT an empty one: treating it ` +
          'as clean would post a clean marker over a review whose findings never left the runner. ' +
          'REMEDY: fix the reviewer step that was meant to write it.',
      );
    }
    throw new PostReviewError('NO_FINDINGS_FILE', `Cannot read \`${path}\`: ${err.code || err.message}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PostReviewError('BAD_FINDINGS', `\`${path}\` is not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) {
    throw new PostReviewError(
      'BAD_FINDINGS',
      `\`${path}\` must be a JSON array of findings, or an object with a \`findings\` array; found ` +
        `${parsed === null ? 'null' : typeof parsed}. Not defaulted to empty: an unrecognised shape read ` +
        'as "no findings" is the same lie as a review that never ran.',
    );
  }
  // The cap is applied AFTER validation and AFTER the judge, never before either.
  // Capping earlier discards candidates a later stage might have preferred to the
  // ones it kept -- the judge rejecting the first seven of twelve should leave the
  // remaining five, not nothing.
  const capped = list.length > MAX_POSTED_FINDINGS ? list.slice(0, MAX_POSTED_FINDINGS) : list;
  if (capped.length < list.length) {
    console.log(
      `CAPPED: ${list.length} findings reached the poster; posting the first ${MAX_POSTED_FINDINGS} ` +
        'in the order they were given.',
    );
  }
  return capped.map((f, i) => {
    const where = `finding ${i + 1} of ${capped.length} in \`${path}\``;
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw new PostReviewError('BAD_FINDING', `${where} is not an object.`);
    }
    if (typeof f.path !== 'string' || f.path.trim() === '') {
      throw new PostReviewError('BAD_FINDING', `${where} has no \`path\`. GitHub would reject it with a 422.`);
    }
    if (!Number.isInteger(f.line) || f.line < 1) {
      throw new PostReviewError(
        'BAD_FINDING',
        `${where} has \`line\`=${JSON.stringify(f.line)}; it must be a positive integer line in this ` +
          "commit's diff. Refused here rather than sent, because a 422 mid-loop leaves half the findings " +
          'posted and the rest lost.',
      );
    }
    if (typeof f.body !== 'string' || f.body.trim() === '') {
      throw new PostReviewError('BAD_FINDING', `${where} has an empty \`body\`. An empty finding is not a finding.`);
    }
    // `class` is carried and RENDERED, not dropped. It was validated upstream and
    // then discarded here, so the one field a precision-by-class tally needs
    // never reached a durable surface -- and findings.json dies with the runner.
    // The tag is appended AFTER upstream sanitisation and deliberately cannot
    // match the review marker's grammar, so it can never be mistaken for one.
    const cls = typeof f.class === 'string' && f.class.trim() !== '' ? f.class.trim().slice(0, 60) : 'unclassified';
    return {
      path: f.path,
      line: f.line,
      // THE SIBLING IS RENDERED, because otherwise verifying it bought nothing a
      // human ever sees. The validator proves the twin exists at that line in the
      // pack the reviewer was shown, the judge is given it -- and the poster used
      // to drop it, so on the second-site family this whole pack exists to catch,
      // the twin's location died with the runner unless the model happened to
      // repeat it in prose. The comment in validate-findings claimed post-review
      // rendered it; it did not.
      body:
        `${f.body}` +
        (f.sibling?.path && Number.isInteger(f.sibling.line)
          ? `\n\nThe same shape is at \`${f.sibling.path}:${f.sibling.line}\`, which this PR does not change.`
          : '') +
        `\n\n<!-- ifc-lite-finding v=1 class=${cls.replace(/[^a-z0-9-]/gi, '-')} -->`,
      // The class IS the title. They were a dead pair: `class` was validated
      // then dropped, while `title` was read by the summary index and never
      // written, so the index always fell back to the first line of the body.
      title: cls === 'unclassified' ? null : cls,
    };
  });
}

/**
 * What makes two findings "the same one" for dedupe. Path and line are in the
 * key as well as the body: two findings can legitimately share wording on
 * different lines, and a body-only key would silently drop the second.
 */
export function fingerprint(path, line, body) {
  return createHash('sha256').update(`${path}\u0000${line}\u0000${body}`).digest('hex');
}

/** The marker the gate parses. Built in exactly one place; proved against the real gate by the harness. */
export function marker(sha, verdict, count) {
  return `<!-- ifc-lite-review sha=${sha} verdict=${verdict} count=${count} -->`;
}

/**
 * The comment for a head with NOTHING REVIEWABLE in it.
 *
 * WHY THIS IS NOT `verdict=clean`. A lockfile-only or generated-code-only PR
 * makes `build-review-input.mjs` exit NO_FILES, so the model is never run. The
 * honest statement about that head is "there was nothing to review", and it is
 * NOT the same statement as "reviewed it and found nothing". Collapsing the two
 * is the exact failure this whole system exists to prevent: if the exclusion
 * list ever grows a bug that swallows real source, a `clean` marker would
 * certify every one of those PRs as reviewed, silently, forever.
 *
 * So it gets its own verdict token. The gate accepts it as evidence that the
 * LANE REACHED THIS HEAD and made a decision -- which is the question the gate
 * actually asks -- and prints it as its own outcome rather than as a pass.
 *
 * The alternative was to leave these PRs with no marker at all. Under
 * `mode: enforcing` that is a red row no re-run and no author action can ever
 * clear, on a class that recurs (PR #3558, a Cargo.lock-only dependabot bump),
 * with a printed remedy -- "re-run the review job" -- that cannot work.
 */
export function nothingToReviewBody(sha) {
  const short = sha.slice(0, 9);
  return [
    `### Claude review - nothing to review for \`${short}\``,
    '',
    'Every changed path in this diff is excluded from review: lockfiles, generated',
    'code, snapshots, fixtures and build output. The reviewer was NOT run, so this',
    'is not a statement that the diff is fine -- it is a statement that there was',
    'nothing here for it to read.',
    '',
    marker(sha, 'nothing-to-review', 0),
  ].join('\n');
}

/** The one-line index entry for a finding. */
function indexLine(f, n) {
  const text = (f.title ?? f.body.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const short = text.length > INDEX_BODY_CHARS ? `${text.slice(0, INDEX_BODY_CHARS - 3)}...` : text;
  return `${n}. \`${f.path}:${f.line}\` - ${short}`;
}

/**
 * How many findings the judge removed, read from the same file the findings came
 * from. Returns 0 for anything it cannot read: this decorates a message, and a
 * malformed count must never be the reason a review fails to post.
 */
export function readJudgedAway(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    // `counts.dropped` MEANS TWO DIFFERENT THINGS in the two files this poster
    // can be handed. In judged.json it is findings the judge rejected as not
    // worth a human's time. In the validator's findings.json -- which the
    // workflow's crash backstop copies verbatim -- it is findings REFUSED as
    // malformed. Reading it without checking `judged` told the author "N
    // finding(s) were dropped as too vague" about findings that were actually
    // rejected for quoting a line that is not in the diff. Only a real judging
    // has judge-dropped findings to disclose.
    if (doc?.judged !== true) return 0;
    const n = doc?.counts?.dropped;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch (err) {
    // Still 0 -- but SAID. The poster read this same file moments ago, so this
    // branch is a race or a corruption, and a summary that silently omits "the
    // judge removed N" is metadata loss nothing downstream can detect.
    console.warn(`readJudgedAway: could not re-read ${path} (${err?.message ?? 'unknown'}); reporting 0 judged away.`);
    return 0;
  }
}

/**
 * How many validated findings the posting cap withheld. Read from the same file,
 * and 0 for anything unreadable: this decorates a message and must never be the
 * reason a review fails to post.
 */
export function readCappedCount(path, shown) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const total = Array.isArray(doc) ? doc.length : doc?.findings?.length;
    return Number.isInteger(total) && total > shown ? total - shown : 0;
  } catch (err) {
    // Same rule as readJudgedAway above: fail-soft, never fail-silent.
    console.warn(`readCappedCount: could not re-read ${path} (${err?.message ?? 'unknown'}); reporting 0 capped.`);
    return 0;
  }
}

/**
 * The human half of the comment.
 *
 * TWO NUMBERS, KEPT APART ON PURPOSE. The heading and the index describe what
 * THIS REVIEW FOUND (`findings.length`); the confirmed line and the marker
 * describe WHAT IS ON THE PULL REQUEST (`count`, straight from the read-back).
 * They are usually equal. When they are not -- a finding from an earlier run of
 * the same head that this run no longer lists -- the difference is PRINTED
 * rather than reconciled, because the whole point of the marker is that its
 * count is an observation and not a claim. Collapsing them into one number is
 * how the marker would quietly become a receipt for the model's own file again.
 */
export function summaryBody({ sha, findings, count, judgedAway = 0, capped = 0 }) {
  const short = sha.slice(0, 9);
  const n = findings.length;
  if (count === 0) {
    // Reachable only when `n` is 0 as well: the caller refuses CLEAN_CONTRADICTED
    // before it gets here, and `count >= n` is enforced one step earlier.
    // A REVIEW JUDGED TO NOTHING IS NOT A REVIEW THAT FOUND NOTHING. The judge
    // can reject every validated finding, and without this line the only record
    // that they ever existed is a runner log that expires -- while the PR shows
    // "found nothing to flag". That is the absence-reads-as-success shape this
    // module is built around, and the judge is what created the path: before it,
    // every validated finding was posted.
    const judged =
      judgedAway > 0
        ? [
            '',
            `${judgedAway} finding(s) were written and then dropped as too vague or already ` +
              'covered before this was posted. Nothing here is a claim that they were wrong, ' +
              'only that they were not worth your time; the run log lists each one and why.',
          ]
        : [];
    return [
      `### Claude review - no findings for \`${short}\``,
      '',
      'Reviewed this diff and found nothing to flag.',
      ...judged,
      '',
      // No thumbs-down footer here on purpose: see STATED HOLES 6.
      marker(sha, 'clean', 0),
    ].join('\n');
  }
  return [
    `### Claude review - ${n} finding${n === 1 ? '' : 's'} for \`${short}\``,
    '',
    ...findings.map((f, i) => indexLine(f, i + 1)),
    '',
    `${count} inline comment${count === 1 ? '' : 's'} from this reviewer confirmed on this commit.`,
    // THE CAP FIRES ROUTINELY NOW. Validation allows twelve and the rubric asks
    // the model for up to twelve, where the poster shows five -- so the slice
    // that used to be unreachable is the common path, and its only trace was a
    // line in a runner log that expires. The clean branch above already discloses
    // judge-dropped findings; saying nothing here would leave the disclosure on
    // the branch where it happens least.
    ...(capped > 0
      ? [
          '',
          `${capped} further finding(s) passed validation and are not shown: this comment is capped ` +
            `at ${MAX_POSTED_FINDINGS} so it stays readable. They are in the run log, and re-running after ` +
            'these are addressed will surface them.',
        ]
      : []),
    '',
    // Honest about what happens next. The earlier wording said a reaction would
    // "log it as a false positive", and nothing logs anything: that is a note
    // that fails to fire, which this repository has a name for. Reactions are a
    // durable surface a later tally can read; until that tally exists, the line
    // says only what is true today.
    'React with 👎 on a finding you think is wrong. Reactions are read when this lane\'s precision is assessed.',
    '',
    marker(sha, 'findings', count),
  ].join('\n');
}

/**
 * Walk one comment surface to exhaustion within a REAL page bound.
 *
 * `pageAll` is the gate's, imported: a second pager would be a second set of
 * boundary conditions to get wrong, and this one is already pinned by tests at
 * the exactly-full-last-page boundary.
 */
function fetchSurface(repo, pr, surface) {
  const base = `repos/${repo}/${surface}`;
  const { rows, truncated } = pageAll((page, perPage) =>
    gh(
      ['api', `${base}?per_page=${perPage}&page=${page}`, '--method', 'GET'],
      `${surface} page ${page}`,
      PostReviewError,
    ),
  );
  if (truncated) {
    throw new PostReviewError(
      'COMMENTS_TRUNCATED',
      `\`${surface}\` still had pages after the bounded walk, so a finding may sit on a page this script ` +
        'never read. Refusing to count what it could not finish reading. REMEDY: raise the pager budget ' +
        'in check-review-posted.mjs, or narrow what the reviewer posts.',
    );
  }
  return rows;
}

/** STEP 1. The head as GitHub sees it now, not as the workflow was told at dispatch. */
function fetchHeadSha(repo, pr) {
  const pull = gh(['api', `repos/${repo}/pulls/${pr}`, '--method', 'GET'], `pull request #${pr}`, PostReviewError);
  const sha = pull?.head?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new PostReviewError(
      'HEAD_UNREADABLE',
      `\`repos/${repo}/pulls/${pr}\` returned no 40-hex \`head.sha\` (got ${JSON.stringify(sha)}). ` +
        'Proceeding on a head this script never confirmed would post findings against a guess. REMEDY: ' +
        "check the token's `pull-requests` scope and re-run.",
    );
  }
  return sha;
}

/**
 * THE GATE'S OWN PREDICATE, spelled the same way on purpose.
 *
 * check-review-posted.mjs counts inline comments as
 * `surface === 'reviewComments' && expectedAuthors.has(author) && commitId === headSha`.
 * This is that filter over that surface. If the two ever diverge, a green poster
 * stops implying a green gate -- which is why the harness runs the REAL gate over
 * what this script actually posted rather than trusting this comment.
 */
export function confirmedOnHead(rows, author, sha) {
  return rows.filter((r) => normaliseLogin(r?.user?.login) === author && r?.commit_id === sha);
}

/** STEP 2. One finding, posted and checked. */
function postFinding(repo, pr, sha, f, n, total) {
  const res = gh(
    [
      'api',
      `repos/${repo}/pulls/${pr}/comments`,
      '--method',
      'POST',
      '-f',
      `commit_id=${sha}`,
      '-f',
      `path=${f.path}`,
      '-F',
      `line=${f.line}`,
      '-f',
      'side=RIGHT',
      '-f',
      `body=${f.body}`,
    ],
    `inline finding ${n}/${total} at ${f.path}:${f.line}`,
    PostReviewError,
  );
  // A 2xx with no id is not a posted comment. #1679's whole shape is a success
  // report over a comment that does not exist, so the RESPONSE is checked rather
  // than the exit code -- the exit code is exactly the evidence that bug teaches
  // us not to accept.
  if (!res || res.id === undefined || res.id === null) {
    throw new PostReviewError(
      'INLINE_POST_FAILED',
      `POST of finding ${n}/${total} at ${f.path}:${f.line} returned no comment id. Aborting with NO ` +
        'MARKER, so the gate reads NOT_POSTED and a re-run is safe. REMEDY: re-run. A 422 here usually ' +
        `means line ${f.line} is not in this commit's diff; fix the finding's anchor.`,
    );
  }
  return res;
}

/**
 * Write the marker comment and PROVE it is readable afterwards.
 *
 * ONE COPY, used by both the review path and the nothing-to-review path. The
 * read-back is the whole contract this file exists to keep -- "it posted, trust
 * me" is exactly the claim the gate refuses -- so a second path that wrote a
 * marker without verifying it would be a hole in the shape of the bug.
 *
 * Idempotent by construction: a marker already written for THIS head is updated
 * in place. Two markers for one sha would leave the gate reading whichever came
 * first in fetch order, which is not a decision anyone made.
 */
function upsertAndVerify({ repo, pr, sha, author, body, want }) {
  const carrier = fetchSurface(repo, pr, `issues/${pr}/comments`).find(
    (c) =>
      normaliseLogin(c?.user?.login) === author &&
      MARKER_RE.exec(String(c?.body ?? ''))?.[1] === sha,
  );
  const res = carrier
    ? gh(
        ['api', `repos/${repo}/issues/comments/${carrier.id}`, '--method', 'PATCH', '-f', `body=${body}`],
        'the review summary (update in place)',
        PostReviewError,
      )
    : gh(
        ['api', `repos/${repo}/issues/${pr}/comments`, '--method', 'POST', '-f', `body=${body}`],
        'the review summary',
        PostReviewError,
      );
  if (!res || res.id === undefined || res.id === null) {
    throw new PostReviewError(
      'SUMMARY_POST_FAILED',
      'The marker comment returned no comment id, so the gate has nothing to read. REMEDY: check that the ' +
        'posting workflow has write access to the pull request, then re-run.',
    );
  }
  const readable = fetchSurface(repo, pr, `issues/${pr}/comments`).some(
    (c) => normaliseLogin(c?.user?.login) === author && String(c?.body ?? '').includes(want),
  );
  if (!readable) {
    throw new PostReviewError(
      'MARKER_NOT_READ_BACK',
      `The marker \`${want}\` is not readable on PR #${pr} one GET after it was written. A marker this ` +
        'script cannot read is one the gate may not be able to read either, and reporting success here ' +
        'would be the exact "it posted, trust me" claim this file exists to refuse. REMEDY: re-run; if ' +
        '`--author` is wrong the marker is on the PR under a different login, and the gate will keep ' +
        'reading NOT_POSTED until the login is fixed.',
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.pr || !/^\d+$/.test(String(args.pr))) {
    throw new PostReviewError('NO_PR', `Pass \`--pr <number>\`; got ${JSON.stringify(args.pr)}.`);
  }
  if (!args.repo) {
    throw new PostReviewError(
      'NO_REPO',
      'Pass `--repo owner/name` or set GITHUB_REPOSITORY. Guessing it would mean posting a review into a ' +
        'repository this script never confirmed.',
    );
  }
  if (!args.sha || !/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new PostReviewError(
      'NO_SHA',
      `Pass \`--sha <40-hex>\`, the head the review READ; got ${JSON.stringify(args.sha)}. Deriving it ` +
        'here would let the marker name a commit different from the one the model was shown.',
    );
  }
  if (!args.findings && !args.nothingToReview) {
    throw new PostReviewError('BAD_ARGS', 'Pass `--findings <findings.json>` or `--nothing-to-review`.');
  }
  if (args.findings && args.nothingToReview) {
    throw new PostReviewError(
      'BAD_ARGS',
      '`--nothing-to-review` and `--findings` are mutually exclusive: one says the model never ran, the ' +
        'other carries what it produced. Passing both means the caller does not know which happened.',
    );
  }
  if (!args.author) {
    throw new PostReviewError(
      'BAD_ARGS',
      'Pass `--author <login>`, the identity this workflow posts as. Without it the read-back cannot tell ' +
        "our own comments from anyone else's, and counting a stranger's comment as a posted finding is " +
        'how a read-back would certify a review that never landed.',
    );
  }

  const author = normaliseLogin(args.author);
  const cfg = readConfig(args.config);
  if (!cfg.expectedAuthors.has(author)) {
    throw new PostReviewError(
      'AUTHOR_NOT_EXPECTED',
      `\`${args.author}\` is not in \`expectedAuthors\` (${[...cfg.expectedAuthors].join(', ')}) in ` +
        `\`${args.config}\`. A marker from an unexpected author is invisible to check-review-posted.mjs, ` +
        'so posting one would produce a GREEN poster over a RED gate. Refused before anything is posted. ' +
        'REMEDY: add the login to the config on the BASE branch -- that is the copy the gate reads -- or ' +
        'fix `--author`.',
    );
  }

  // THE NOTHING-TO-REVIEW PATH, taken before any findings handling because there
  // are none by construction. It still checks the head first -- a marker for a
  // dead head is one the gate calls STALE_REVIEW -- and it posts ONE comment and
  // no inline anything. See `nothingToReviewBody` for why this is a verdict of
  // its own and not `clean`.
  if (args.nothingToReview) {
    // A REAL VERDICT FOR THIS HEAD OUTRANKS THIS ONE. `upsertAndVerify` finds a
    // carrier by sha alone, so without this it would PATCH an existing
    // `verdict=findings count=3` summary into "nothing to review / count=0" --
    // orphaning three inline comments and stepping around the
    // FINDINGS_NOT_POSTED cross-check that exists to catch exactly that gap.
    // Reachable only if the exclusion outcome flipped for one head, which needs
    // dedup to have failed; narrow, and a downgrade this file must never make.
    const existing = fetchSurface(args.repo, args.pr, `issues/${args.pr}/comments`).find((c) => {
      const m = MARKER_RE.exec(String(c?.body ?? ''));
      return normaliseLogin(c?.user?.login) === author && m?.[1] === args.sha && m[2] !== 'nothing-to-review';
    });
    if (existing) {
      // REPORTED, AND EXIT 0. The refusal is right -- overwriting a real verdict
      // would retract it and orphan any inline findings under it -- but THROWING
      // was wrong: it reddens the lane job for a state that needs no action, the
      // gate is already satisfied by the standing marker, and no re-run could
      // ever clear it. That is precisely the unclearable-red class this branch
      // exists to remove, reintroduced by its own guard. Raised by CodeRabbit on
      // PR #3587.
      console.log(
        `WOULD_DOWNGRADE_VERDICT: a \`${MARKER_RE.exec(existing.body)[2]}\` marker already stands for ` +
          `${args.sha.slice(0, 9)}. Overwriting it with \`nothing-to-review\` would retract a real ` +
          'verdict and orphan any inline findings under it, so nothing was posted. This head IS ' +
          'covered and the gate reads it; there is nothing to do.',
      );
      process.exit(0);
    }
    const liveHead = fetchHeadSha(args.repo, args.pr);
    if (liveHead !== args.sha) {
      console.log(
        `SKIPPED_STALE: this run read ${args.sha.slice(0, 9)}; the PR head is now ${liveHead.slice(0, 9)}.`,
      );
      process.exit(0);
    }
    upsertAndVerify({
      repo: args.repo,
      pr: args.pr,
      sha: args.sha,
      author,
      body: nothingToReviewBody(args.sha),
      want: marker(args.sha, 'nothing-to-review', 0),
    });
    console.log(`Posted a nothing-to-review marker for ${args.sha.slice(0, 9)}.`);
    process.exit(0);
  }

  // Read BEFORE the first network call. A malformed findings file must refuse
  // with nothing posted, not halfway through the loop.
  const findings = readFindings(args.findings);

  // ------------------------------------------------------------------ STEP 1
  const head = fetchHeadSha(args.repo, args.pr);
  if (head !== args.sha) {
    console.log(
      `SKIPPED_STALE: this review read ${args.sha.slice(0, 9)}; the PR head is now ${head.slice(0, 9)}.`,
    );
    console.log('   Nothing posted. A marker for a dead head is one the gate calls STALE_REVIEW, and no');
    console.log('   re-run of THIS commit could clear it. The run triggered by the new head owns it.');
    process.exit(0);
  }

  // ------------------------------------------------------------------ STEP 2
  const before = fetchSurface(args.repo, args.pr, `pulls/${args.pr}/comments`);
  const already = new Set(
    confirmedOnHead(before, author, args.sha).map((r) => fingerprint(r.path, r.line, String(r.body ?? ''))),
  );
  let posted = 0;
  let skipped = 0;
  for (const [i, f] of findings.entries()) {
    if (already.has(fingerprint(f.path, f.line, f.body))) {
      skipped += 1;
      continue;
    }
    postFinding(args.repo, args.pr, args.sha, f, i + 1, findings.length);
    posted += 1;
  }

  // ------------------------------------------------------------------ STEP 3
  const after = fetchSurface(args.repo, args.pr, `pulls/${args.pr}/comments`);
  const confirmed = confirmedOnHead(after, author, args.sha).length;

  // `>= findings.length`, not `>= posted`: deliberately STRONGER than "what this
  // run sent". Measuring against `posted` would let a re-run launder a comment
  // lost by an earlier attempt -- it would skip the finding as a duplicate,
  // require zero, and write a marker for a finding nobody can see.
  if (confirmed < findings.length) {
    throw new PostReviewError(
      'READBACK_SHORT',
      `Read back ${confirmed} inline comment(s) from \`${author}\` on ${args.sha.slice(0, 9)}; the review ` +
        `has ${findings.length} finding(s) (${posted} posted this run, ${skipped} already present). Every ` +
        'POST reported success, so this is the #1679 shape exactly: `Posted 0/N` under a green job. NO ' +
        'MARKER WRITTEN, so the gate reads NOT_POSTED and a re-run is safe. REMEDY: re-run. If it recurs, ' +
        'attach the log to anthropics/claude-code-action#1679 rather than re-running indefinitely.',
    );
  }
  if (findings.length === 0 && confirmed > 0) {
    throw new PostReviewError(
      'CLEAN_CONTRADICTED',
      `This run found nothing, yet ${confirmed} inline finding(s) from \`${author}\` are anchored to ` +
        `${args.sha.slice(0, 9)}. One of the two runs is wrong about the same commit, and a ` +
        '`verdict=clean` marker would bury the disagreement under a pass. REMEDY: re-run the review; if ' +
        'those findings are genuinely withdrawn, delete the inline comments first.',
    );
  }

  // ------------------------------------------------------------------ STEP 4+5
  const verdict = confirmed === 0 ? 'clean' : 'findings';
  upsertAndVerify({
    repo: args.repo,
    pr: args.pr,
    sha: args.sha,
    author,
    body: summaryBody({
      sha: args.sha,
      findings,
      count: confirmed,
      judgedAway: readJudgedAway(args.findings),
      capped: readCappedCount(args.findings, findings.length),
    }),
    want: marker(args.sha, verdict, confirmed),
  });

  console.log(`Head: ${args.sha.slice(0, 9)}`);
  console.log(`Findings: ${findings.length} (posted ${posted}, already present ${skipped})`);
  console.log(`Confirmed on this head: ${confirmed}`);
  console.log('');
  console.log(
    `✅ REVIEW_POSTED: wrote a ${verdict} marker for ${args.sha.slice(0, 9)} with count=${confirmed}, AFTER ` +
      'reading every finding back from the pull request.',
  );
  console.log('   The count is what GitHub handed back, never what the model claimed.');
  process.exit(0);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof PostReviewError || err instanceof GhError || err instanceof ReviewPostedError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
