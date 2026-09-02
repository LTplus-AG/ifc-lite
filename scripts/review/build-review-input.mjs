#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assemble exactly what the reviewer is allowed to see, and record what it was
 * NOT shown.
 *
 * WHY THIS IS ITS OWN STEP. The reviewer runs as a pure function: delimited text
 * in, strict JSON out, no tools, no shell, no repository access. That is the
 * whole injection defence (a bash instruction planted in a PR was executed
 * against Anthropic's own review action, CVSS 9.4; CodeRabbit had an RCE via a
 * `rubocop.yml` in a PR). A model with no engine cannot be made to fire one. The
 * cost of that choice is that the prompt is the entire world the reviewer has,
 * so building it is a step with its own rules rather than a line in a workflow.
 *
 * WHAT IT REFUSES TO INCLUDE:
 *
 *   - THE PR TITLE. Attacker-controlled free text, and the exact field the
 *     CVSS 9.4 exploit used. The diff has to be included because it is the
 *     subject; the title does not, so it is not.
 *
 *     THE BODY IS NOW INCLUDED, deliberately, and this paragraph used to say it
 *     was refused. It is passed with `--body-file`, capped, fenced with a nonce,
 *     and labelled in the prompt as a claim to check rather than an instruction
 *     -- because "the description says X, the diff does Y" is a defect class the
 *     rubric now names, and one that is invisible without it. The title is still
 *     refused: it carries no such claim and buys nothing.
 *
 *     A safety comment that was true when written and quietly became false is
 *     the thing that gets a later reader to skip the guard it describes.
 *   - GENERATED AND VENDORED FILES. Measured on this repo, excluding them moves
 *     the mean diff by about 5%, so this is not a cost lever -- it is an
 *     attention lever. A lockfile in the prompt is 40k tokens of noise competing
 *     with the code under review.
 *
 * `unreviewable` carries {path, reason} OBJECTS rather than annotated strings.
 * That is not cosmetic: validate-findings.mjs refuses an input where a path
 * appears in BOTH `files` and `unreviewable`, and against annotated strings that
 * check can never match, so it would be an inert guard that reads as a live one.
 *
 * WHAT IT RECORDS RATHER THAN DROPS. GitHub omits `patch` on very large files.
 * Those files are listed by name in `unreviewable` instead of being silently
 * absent, because a reviewer that was never shown a file must not be able to
 * report it clean, and a downstream reader must be able to see the difference.
 * That is the same absence-reads-as-success rule the review gate enforces one
 * layer up.
 *
 * `addedLineRanges` is the load-bearing output. It is parsed from the hunk
 * headers and is what makes a finding's anchor CHECKABLE: validate-findings.mjs
 * refuses any finding whose line falls outside an added range, which is how a
 * hallucinated line number gets caught before it reaches the PR.
 *
 * FAILURE CLASSES:
 *
 *   NO_FILES          The PR has no reviewable files. Exits non-zero: a review
 *                     of nothing is not a clean review, and the caller must
 *                     decide, not this script.
 *                     REMEDY: nothing to do; the lane should skip this PR.
 *   REVIEW_TOO_LARGE  Total patch text over the cap.
 *                     REMEDY: split the PR. Not chunked on purpose -- measured
 *                     here, 0 of 90 sampled PRs come near the cap, so chunking
 *                     would be machinery for a case that does not occur, and
 *                     silently reviewing half a diff is worse than refusing.
 *   GH_*              Propagated from lib/gh.mjs. All fail closed.
 *
 * STATED HOLES:
 *
 *   1. The reviewer sees a DIFF, not the repository. It cannot know that a
 *      symbol removed here is used elsewhere. The rubric forbids claims that
 *      depend on unseen files for exactly this reason, and the deterministic
 *      gates own the cross-file questions.
 *   2. The exclude list is a fixed list, not a `.gitattributes` read. A newly
 *      generated artifact is included until someone adds it here.
 *   3. Renames and deletions carry no `patch` for the old path, so a defect
 *      whose evidence is what USED to be there is invisible to this reviewer.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { buildPack, retrievalFailed, retrievalFailedMessage, SHALLOW_CHECKOUT_REMEDY } from './build-context-pack.mjs';
import { gh, GhError } from '../lib/gh.mjs';
// The gate's pager, not a second copy of it. An earlier version here duplicated
// it MINUS the one thing it exists for: the probe past a full final page. A PR
// with exactly MAX_PAGES x PER_PAGE files was therefore fully read and then
// refused as truncated -- the permanent unclearable refusal pageAll's own
// comment says was moved rather than fixed.
import { pageAll } from '../check-review-posted.mjs';

/** 600 KB of patch text. The largest PR observed on this repo is ~427 KB. */
export const MAX_PATCH_BYTES = 600 * 1024;

const PER_PAGE = 100;
const MAX_PAGES = 10;

/**
 * Generated, vendored and fixture content. Excluded for ATTENTION, not cost:
 * measured, removing these moves the mean diff ~5%, but a lockfile is tens of
 * thousands of tokens competing with the code actually under review.
 */
export const EXCLUDED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)package-lock\.json$/,
  /\.snap$/,
  /(^|\/)fixtures?\//,
  // Captured review-input fixtures: each one EMBEDS the diffs of a historical
  // PR, and a reviewer shown diffs-inside-a-diff misattributes them. Measured
  // on this rule's own PR: the CI reviewer quoted a line of pr-3595.json's
  // embedded patch as its `riskiest_change` in build-context-pack.mjs, and
  // proof-of-work refused the review. Same category as `fixtures/`: excluded
  // for attention, and here for attribution.
  /(^|\/)eval-cases\//,
  /(^|\/)pkg\//,
  /\.(ifc|ifcx|glb|gltf|png|jpg|jpeg|svg|pdf|zip|wasm)$/i,
  /(^|\/)dist\//,
  /(^|\/)api-surface\.json$/,
];

export class BuildInputError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** @param {string} path */
export function isExcluded(path) {
  return EXCLUDED.some((re) => re.test(path));
}

/**
 * Walk a patch and classify every line, numbering it AS IT WILL BE IN THE NEW FILE.
 *
 * This is the single counter. `addedLineRanges` is built on it, and so is the
 * canary's check that its fixture's quote sits on the line the fixture claims,
 * because a second hand-rolled counter is how an off-by-one gets certified: it
 * agrees with this one on the easy patch it was written against and diverges on
 * a hunk that does not start at line 1, on a second hunk, and on a file with no
 * trailing newline.
 *
 * Match a quote against `text` for `added` lines only, and TRIM BOTH SIDES.
 * That GATE is strictly stricter than `quotableLines` in validate-findings:
 * every NON-EMPTY quote it accepts, `quotableLines` accepts too, and not the
 * reverse. The exception is the one rule `quotableLines` has that the gate does
 * not -- it drops what trims to empty -- so a blank added line gives a quote the
 * gate accepts and the validator refuses.
 *
 * The two FUNCTIONS still differ, which matters the moment you read `text` for
 * any other kind. `quotableLines` works on the RAW diff line: it discards
 * anything beginning `@@`, `+++ `, `--- ` or `\`, strips one leading `+`, `-`
 * or space from what is left, trims, and drops what is then empty.
 * `newFileLines` classifies the line first and strips only a space from a
 * context line. Measured on this commit:
 *
 *   raw          newFileLines   quotableLines
 *   "---x"       "---x"         "--x"       strip rules differ
 *   "--- x"      "--- x"        dropped     read as a file header
 *   "+++i;"      "+++i;"        "++i;"      strip rules differ
 *   "+++ i;"     "+++ i;"       dropped     read as a file header
 *   "+--foo"     "--foo"        "--foo"     agree
 *   "-++i;"      "++i;"         "++i;"      agree
 *   "     deep"  "    deep"     "deep"      trimmed
 *   " "          ""             dropped     blank
 *
 * A deleted `-- drop old table` becomes the raw line `--- drop old table`, and
 * `quotableLines` refuses it outright -- worth knowing before reusing it to
 * match anything that is not an added line.
 *
 * Splits on /\r?\n/, where the older walker split on '\n', so `text` carries no
 * trailing `\r`. That is what makes it comparable to `quotableLines`.
 *
 * KNOWN, PRE-EXISTING, NOT FIXED HERE (see #3634): neither the `-`/`---` nor
 * the `+`/`+++` test can tell a file header from content that starts the same
 * way, and the two halves fail DIFFERENTLY, so a fix must cover both:
 *
 *   deleting a markdown `---` rule gives `----`, read as context, which
 *     advances the counter and numbers every later line in that hunk too high;
 *   adding `++i;` gives `+++i;`, which is dropped from the ranges, so
 *     `lineIsAdded` refuses a CORRECT finding on a line the PR really added.
 *
 * `addedLineRanges` behaves exactly as it does on origin/main; the commit
 * message carries the differential evidence.
 *
 * @param {string} patch a unified diff for ONE file
 * @returns {{line: number, text: string, kind: 'added'|'context'|'removed'|'hunk'}[]}
 */
export function newFileLines(patch) {
  const out = [];
  let newLine = 0;
  for (const line of String(patch).split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      out.push({ line: newLine, text: line, kind: 'hunk' });
      continue;
    }
    // `\ No newline at end of file` is diff METADATA, not a context line. Counting
    // it advanced the new-file counter and shifted every later range by one,
    // which fails two ways at once: a correct finding on the real line is dropped
    // as "not inside an added range", and a finding one line past EOF is posted
    // and rejected 422 by GitHub, reddening the job with no marker. It fires on
    // any file lacking a trailing newline. validate-findings' `quotableLines`
    // already skipped it, so the two halves disagreed about the same diff.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push({ line: newLine, text: line.slice(1), kind: 'added' });
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // A removed line does not advance the new-file counter.
      out.push({ line: newLine, text: line.slice(1), kind: 'removed' });
    } else {
      // Strip only a leading SPACE, the marker a context line carries. Not
      // `quotableLines`' rule; see the divergences listed above.
      out.push({ line: newLine, text: line.startsWith(' ') ? line.slice(1) : line, kind: 'context' });
      newLine += 1;
    }
  }
  return out;
}

/**
 * Line ranges the PR ADDED, in NEW-FILE numbering.
 *
 * A run of added lines is broken by ANYTHING that is not an added line -- a
 * removed line, a context line, a header, a hunk boundary -- which is what makes
 * this exactly what it was before `newFileLines` was factored out of it. Merging
 * runs across a removed line would be invisible to `lineIsAdded`, the only
 * consumer, since that is a membership test; it would not be invisible to a
 * caller that counts or serialises ranges, and there is no reason to leave that
 * difference lying around.
 *
 * @param {string} patch a unified diff for ONE file
 * @returns {[number, number][]}
 */
export function addedLineRanges(patch) {
  const ranges = [];
  let open = null;
  for (const { line, kind } of newFileLines(patch)) {
    if (kind !== 'added') {
      open = null;
      continue;
    }
    if (open) open[1] = line;
    else ranges.push((open = [line, line]));
  }
  return ranges;
}

/**
 * Pure over an already-fetched file list, so every branch is reachable in tests
 * without a network.
 *
 * @returns {{ headSha: string, files: object[], unreviewable: string[], excluded: string[] }}
 */
export function buildInput(fileRows, headSha) {
  const files = [];
  const unreviewable = [];
  const excluded = [];
  let bytes = 0;

  for (const row of fileRows) {
    const path = String(row?.filename ?? '');
    if (!path) continue;
    if (isExcluded(path)) {
      excluded.push(path);
      continue;
    }
    if (row?.status === 'removed') {
      // No new-file content to anchor a comment to.
      unreviewable.push({ path, reason: 'deleted' });
      continue;
    }
    if (typeof row?.patch !== 'string' || row.patch === '') {
      // GitHub omits `patch` on very large files. Recorded, never silently
      // dropped: a file the reviewer was not shown must not be reportable as
      // clean, and the reader has to be able to see which those were.
      unreviewable.push({ path, reason: 'no patch returned (too large, or a pure rename)' });
      continue;
    }
    bytes += Buffer.byteLength(row.patch, 'utf8');
    if (bytes > MAX_PATCH_BYTES) {
      throw new BuildInputError(
        'REVIEW_TOO_LARGE',
        `Patch text exceeds ${MAX_PATCH_BYTES} bytes at \`${path}\`. Not chunked on purpose: 0 of ` +
          '90 sampled PRs on this repository come near this, so chunking would be machinery for a ' +
          'case that does not occur, and reviewing half a diff silently is worse than refusing. ' +
          'REMEDY: split the PR.',
      );
    }
    files.push({ path, patch: row.patch, addedLineRanges: addedLineRanges(row.patch) });
  }

  if (files.length === 0) {
    throw new BuildInputError(
      'NO_FILES',
      'No reviewable files after exclusions. A review of nothing is not a clean review, so this ' +
        'refuses rather than emitting an empty input the reviewer would confidently pass. ' +
        'REMEDY: the lane should skip this PR; nothing here needs fixing.',
    );
  }
  return { headSha, files, unreviewable, excluded };
}

function main() {
  const args = { pr: null, repo: process.env.GITHUB_REPOSITORY || null, sha: null, out: null, filesFile: null };
  const FLAGS = new Map([
    ['--pr', 'pr'],
    ['--repo', 'repo'],
    ['--sha', 'sha'],
    ['--out', 'out'],
    ['--base', 'base'],
    ['--body-file', 'bodyFile'],
    ['--files-file', 'filesFile'],
  ]);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = FLAGS.get(argv[i]);
    if (!key) throw new BuildInputError('BAD_ARGS', `Unrecognised argument \`${argv[i]}\`.`);
    if (argv[i + 1] === undefined) throw new BuildInputError('BAD_ARGS', `\`${argv[i]}\` needs a value.`);
    args[key] = argv[i + 1];
    i += 1;
  }
  if (!args.sha || !/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new BuildInputError('NO_SHA', 'Pass `--sha <40-hex>`, the head this review is for.');
  }
  if (!args.out) throw new BuildInputError('BAD_ARGS', 'Pass `--out <path>`.');

  let rows;
  if (args.filesFile) {
    rows = JSON.parse(readFileSync(args.filesFile, 'utf8'));
  } else {
    if (!args.pr || !args.repo) throw new BuildInputError('BAD_ARGS', 'Pass `--pr` and `--repo`.');
    const { rows: fetched, truncated } = pageAll((page, perPage) =>
      gh(
        ['api', `repos/${args.repo}/pulls/${args.pr}/files?per_page=${perPage}&page=${page}`, '--method', 'GET'],
        `the PR file list page ${page}`,
        BuildInputError,
      ),
    );
    if (truncated) {
      throw new BuildInputError(
        'FILES_TRUNCATED',
        `The PR has more than ${MAX_PAGES * PER_PAGE} files, so this script never saw all of them. ` +
          'Refusing rather than reviewing a prefix and reporting it as the whole. REMEDY: split the PR.',
      );
    }
    rows = fetched;
  }

  const input = buildInput(rows, args.sha);
  // THE CONTEXT PACK. Built here, in the harness, never by the model.
  //
  // Optional: without --base the lane behaves exactly as it did before, which
  // keeps every existing caller (and the eval harness) working unchanged. When
  // a base IS given, retrieval failures degrade to a smaller pack rather than
  // failing the review -- a lane that goes red because a grep found nothing
  // would be worse than one that reviews with less evidence, and the pack
  // records what it dropped either way.
  if (args.base) {
    let body = null;
    if (args.bodyFile) {
      try { body = readFileSync(args.bodyFile, 'utf8'); } catch { body = null; }
    }
    try {
      // The pack sizes itself from what the diff already spent, so the two
        // together stay under one ceiling without the diff ever losing room.
        const patchBytes = input.files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
        input.contextPack = buildPack(input, { baseRef: args.base, body, patchBytes });
      const p2 = input.contextPack;
      console.log(
        `context-pack: ${p2.siblings.length} sibling excerpt(s), ${p2.fileEvidence.length} file(s) in full` +
          (p2.body ? ', description included' : '') +
          (p2.truncated.length ? `, omitted for size: ${p2.truncated.join('; ')}` : ''),
      );
      // AN EMPTY PACK IS A FAULT REPORT, NOT A QUIET ZERO. `0 sibling excerpt(s),
      // 0 file(s)` is what a PR with no siblings logs AND what a shallow checkout
      // logs -- and the shallow checkout is what production had, so the pack was
      // empty on every pull request while this line read perfectly normal.
      if (retrievalFailed(p2, input.files.length)) {
        console.log(
          `::warning::context-pack: ${retrievalFailedMessage(input.headSha, input.files.length)} ` +
            `${SHALLOW_CHECKOUT_REMEDY} The review continues from the diff alone.`,
        );
      }
    } catch (err) {
      console.log(`context-pack: unavailable (${err?.message ?? 'unknown'}); reviewing from the diff alone`);
    }
  }

  writeFileSync(args.out, JSON.stringify(input, null, 2));
  console.log(
    `review-input: ${input.files.length} file(s), ${input.unreviewable.length} unreviewable, ` +
      `${input.excluded.length} excluded, head ${args.sha.slice(0, 9)}`,
  );
  if (input.unreviewable.length > 0) {
    console.log('  NOT shown to the reviewer:');
    for (const u of input.unreviewable) console.log(`    - ${u.path} (${u.reason})`);
  }
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof BuildInputError || err instanceof GhError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
