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
 *   REVIEW_TOO_LARGE  Total patch text over MAX_PATCH_BYTES.
 *                     REMEDY: split the PR. Below the cap the lane DEGRADES
 *                     instead (see the omission note above `fitFilesToPrompt`):
 *                     it reviews the largest files that fit the prompt and
 *                     records the rest as unreviewable, so a near-cap PR gets a
 *                     partial review with a marker instead of a MODEL_ERROR red
 *                     that no re-run can clear (#3679).
 *   NOTHING_FITS      Nothing at all fits the model prompt: one file's patch is
 *                     bigger than the whole prompt, or the paths alone fill it.
 *                     A SKIP, not a failure, and that is the distinction from
 *                     REVIEW_TOO_LARGE: no re-run can clear it, so failing the
 *                     job here would leave a red that only splitting the PR
 *                     removes while the gate tells you to re-run. The lane
 *                     posts `nothing-to-review` instead, which leaves the head
 *                     covered for dedup and NOT full, so CodeRabbit still reads
 *                     the PR. Same handling as NO_FILES, same reason.
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
import {
  buildPack,
  retrievalFailed,
  retrievalFailedMessage,
  SHALLOW_CHECKOUT_REMEDY,
  MAX_PROMPT_BYTES,
  PROMPT_BASE_OVERHEAD_BYTES,
} from './build-context-pack.mjs';
// The renderers, not a byte model OF the renderers. fitFilesToPrompt charges
// each row by measuring the exact strings buildPrompt will emit, because two
// copies held together by prose drifted once already: a constant that charged
// a kept file's path once, where the prompt spends it twice, declared a
// 600-file long-path diff "fits" 8,476 bytes over the ceiling.
import { keptRowCharge, unreviewableRowCharge } from './run-reviewer.mjs';
import { gh, GhError } from '../lib/gh.mjs';
// The gate's pager, not a second copy of it. An earlier version here duplicated
// it MINUS the one thing it exists for: the probe past a full final page. A PR
// with exactly MAX_PAGES x PER_PAGE files was therefore fully read and then
// refused as truncated -- the permanent unclearable refusal pageAll's own
// comment says was moved rather than fixed.
import { pageAll } from '../check-review-posted.mjs';

/**
 * 600 KB of patch text; the largest PR observed on this repo is ~427 KB. This is
 * the REFUSAL bound, not the review bound: a diff under it that still cannot fit
 * the model prompt (MAX_PROMPT_BYTES is smaller than this, measured at ~1.95
 * bytes per token -- #3679) is DEGRADED by `fitFilesToPrompt` below rather than
 * refused. Do not lower this to "fix" a prompt overrun: that makes the lane
 * refuse PRs it used to review, the trade already made and reverted once here.
 *
 * "DEGRADED, NEVER REFUSED" IS NOT TRUE OF EVERY SUB-CAP DIFF, and this said it
 * was. Degrading means reviewing the files that fit; a PR whose ONE file is
 * 500 KB has no such subset, because a 500 KB patch does not fit a 390,000-byte
 * prompt however the budget is arithmetic'd. No raise to this constant changes
 * that -- MAX_PROMPT_BYTES is the binding number. What the lane owes that PR is
 * an honest posted marker rather than a red, which is what NOTHING_FITS is for.
 */
export const MAX_PATCH_BYTES = 600 * 1024;

/**
 * The reason string on an unreviewable row for a file DROPPED to fit the model
 * prompt. A constant, compared with `===` downstream: validate-findings copies
 * exactly these rows into findings.json so the posted marker can say the review
 * was partial. A reworded copy would silently vanish from the marker, which is
 * the absence-reads-as-success shape one layer down.
 *
 * Length no longer needs policing. Every unreviewable row is charged at the
 * bytes `unreviewableRow` actually renders, so a longer reason costs more AND
 * is charged more. It used to be a fixed constant plus the raw strings, which
 * a reason past its measured worst case would have quietly broken; that
 * constant is gone.
 */
export const OMITTED_FOR_PROMPT_REASON = 'omitted: too large to fit the model prompt with the rest of this diff';

/**
 * WHAT AN UNREVIEWABLE ROW MEANS, as a field rather than as English. The row's
 * `reason` is for a human; this is what code is allowed to branch on.
 *
 * `no-content` -- there was nothing for the reviewer to read: a deletion, or a
 * pure rename. Nothing is being withheld, so nothing needs disclosing.
 *
 * `unread` -- there WAS content and the reviewer did not see it: GitHub called
 * the file too large to send a patch for, or the diff was degraded to fit the
 * model prompt. Every one of these must reach the marker's `omitted=<n>`.
 *
 * The distinction used to be made by matching `reason === OMITTED_FOR_PROMPT_REASON`
 * downstream, which counted the prompt-dropped rows and silently missed the
 * too-large ones: a PR whose only unreviewable file was one GitHub refused to
 * send got a marker byte-identical to a full review's. Absence reading as
 * success, one layer down from where #3679 fixed it.
 */
export const UNREVIEWABLE_NO_CONTENT = 'no-content';
export const UNREVIEWABLE_UNREAD = 'unread';

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
 * Which candidate files fit the model prompt, and which must be dropped.
 *
 * WHY THIS EXISTS (#3679). MAX_PATCH_BYTES (600 KB) is larger than the prompt
 * the model actually accepts: source code meters at ~1.95 bytes per token, so a
 * near-cap diff alone is ~300k input tokens. PR #3668's own review passed at a
 * 421,355-byte prompt and failed MODEL_ERROR at 580,241 bytes -- and
 * run-reviewer has NO path from MODEL_ERROR to a marker, so the job went red
 * with nothing posted and nothing any re-run could clear. Refusing instead
 * (lowering the cap) is the same trade already made and reverted once here.
 * So the lane DEGRADES: it reviews the largest files that fit and RECORDS the
 * rest, and the recorded rows travel all the way to the posted marker.
 *
 * LARGEST FIRST, because the largest files carry the most changed lines: for a
 * fixed byte budget that ordering maximises how much of the diff is actually
 * read. Greedy, so a file too big for the remaining room does not block a
 * smaller one behind it. Ties break on path so two runs of one head agree.
 *
 * THE CHARGE IS MEASURED, PER ROLE, AND EACH CANDIDATE PAYS THE ROLE IT ENDS
 * UP IN. A candidate is either KEPT (a `--- FILE:` header plus a roster row --
 * its path spent TWICE) or OMITTED (one unreviewable row -- its path once, plus
 * the reason). Which costs more depends on the path's length against the
 * reason's, so neither role dominates. A hand-written constant stood here and
 * drifted: it charged every row at the unreviewable rate, which undercharges a
 * kept file once its path outgrows the reason, and 600 candidates with 188-byte
 * paths were declared to fit 8,476 bytes over MAX_PROMPT_BYTES -- measured
 * through buildInput -> buildPack -> buildPrompt with the shipped rubric.
 *
 * ITS REPLACEMENT CHARGED max(kept, omitted) TO EVERY CANDIDATE UP FRONT, which
 * is safe by bytes and wrong by outcome: a role a file does not end up in is
 * still billed for. On a wide PR that is the dominant term. Measured on this
 * branch: 2,000 files whose patches total 26 KB -- nothing close to any limit --
 * drove the budget negative and threw REVIEW_TOO_LARGE saying "no single file's
 * patch fits the model prompt", which was false about all 2,000 of them.
 *
 * SO THE FIT IS A FIXED POINT, reached in one pass rather than iterated. Start
 * from "every candidate omitted" and admit files largest-first; admitting one
 * SWAPS its omitted row for its kept rows, so it costs its patch bytes plus
 * `keptRowCharge - unreviewableRowCharge` -- a swing that is positive for a long
 * path and NEGATIVE for a short one. The swings are additive, so the running
 * total is exact for whatever set comes out; there is no second pass to do.
 *
 * LARGEST FIRST, because the largest files carry the most changed lines: for a
 * fixed byte budget that ordering maximises how much of the diff is actually
 * read. Greedy, so a file too big for the remaining room does not block a
 * smaller one behind it. Ties break on path so two runs of one head agree.
 *
 * Rows unreviewable for OTHER reasons never move, so they pay exactly their own
 * rendering. The pack needs no reservation: packBudgetFor already yields to the
 * diff and reaches zero exactly on the PRs this function bites on.
 *
 * THE BUDGET IS SHORT BY THE UNREVIEWABLE SECTION'S PREAMBLE (128 bytes) AND
 * `promptEnvelopeBytes`'s `countDigits` terms (a handful). Latent, and named
 * rather than left to be discovered: both are absorbed by the margin inside
 * PROMPT_BASE_OVERHEAD_BYTES, which is 24,000 against a measured envelope well
 * under it. Deriving the budget from `promptEnvelopeBytes` directly would close
 * the gap, but that function charges a SETTLED input and this one is choosing
 * what the input will be -- it would have to be re-evaluated per candidate, so
 * it is a real change rather than a substitution.
 *
 * @param {{path: string, patch: string}[]} candidates
 * @param {{path: string}[]} unreviewable rows already recorded for other reasons
 * @returns {{ kept: typeof candidates, omitted: typeof candidates }}
 */
export function fitFilesToPrompt(candidates, unreviewable) {
  // Charged by run-reviewer's own per-row charges, which sit next to the
  // renderers they measure. Re-spelling the arithmetic here is how the two
  // copies would drift apart.
  const omittedCharge = (path) => unreviewableRowCharge({ path, reason: OMITTED_FOR_PROMPT_REASON });
  let base = MAX_PROMPT_BYTES - PROMPT_BASE_OVERHEAD_BYTES;
  for (const u of unreviewable) base -= unreviewableRowCharge(u);

  const sized = candidates.map((c) => ({
    c,
    bytes: Buffer.byteLength(c.patch, 'utf8'),
    // What admitting this file costs on top of its patch: it stops paying for an
    // unreviewable row and starts paying for a header plus a roster row.
    swing: keptRowCharge(c.path) - omittedCharge(c.path),
  }));
  // THE FLOOR IS "EVERYTHING OMITTED", which is the one arrangement that is
  // always available, so this is what the budget is measured against.
  const budget = sized.reduce((n, s) => n - omittedCharge(s.c.path), base);

  const bySize = [...sized].sort((a, b) => b.bytes - a.bytes || a.c.path.localeCompare(b.c.path));
  const keep = new Set();
  let spent = 0;
  for (const s of bySize) {
    const cost = s.bytes + s.swing;
    if (spent + cost <= budget) {
      keep.add(s.c.path);
      spent += cost;
    }
  }
  return {
    kept: candidates.filter((c) => keep.has(c.path)),
    omitted: candidates.filter((c) => !keep.has(c.path)),
    // WHY NOTHING FIT, when nothing did. The two causes need different words and
    // one of them used to be printed for both: a patch bigger than the whole
    // prompt is not the same failure as a file list whose ROWS alone exhaust it.
    budget,
  };
}

/**
 * Pure over an already-fetched file list, so every branch is reachable in tests
 * without a network.
 *
 * @returns {{ headSha: string, files: object[], unreviewable: string[], excluded: string[] }}
 */
export function buildInput(fileRows, headSha) {
  const candidates = [];
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
      unreviewable.push({ path, reason: 'deleted', kind: UNREVIEWABLE_NO_CONTENT });
      continue;
    }
    if (typeof row?.patch !== 'string' || row.patch === '') {
      // GitHub omits `patch` on very large files. Recorded, never silently
      // dropped: a file the reviewer was not shown must not be reportable as
      // clean, and the reader has to be able to see which those were.
      //
      // A PURE RENAME AND A TOO-LARGE FILE ARE NOT THE SAME ROW, and one reason
      // string covered both. A rename with no patch has no changed content, so
      // nothing was withheld from the reviewer; a file GitHub called too large
      // has content the reviewer never saw. Only the second is an OMISSION the
      // marker must disclose, and `status` is what tells them apart -- the
      // reason string never could.
      const renamed = row?.status === 'renamed';
      unreviewable.push(
        renamed
          ? { path, reason: 'a pure rename: no content changed', kind: UNREVIEWABLE_NO_CONTENT }
          : { path, reason: 'no patch returned (too large)', kind: UNREVIEWABLE_UNREAD },
      );
      continue;
    }
    bytes += Buffer.byteLength(row.patch, 'utf8');
    if (bytes > MAX_PATCH_BYTES) {
      throw new BuildInputError(
        'REVIEW_TOO_LARGE',
        `Patch text exceeds ${MAX_PATCH_BYTES} bytes at \`${path}\`. Below this cap the lane degrades ` +
          'to reviewing the largest files that fit the model prompt and marks the rest omitted; past ' +
          'it, less than ~60% of the diff could be read, and a review that thin would mislead more ' +
          'than it helps. REMEDY: split the PR.',
      );
    }
    candidates.push({ path, patch: row.patch });
  }

  if (candidates.length === 0) {
    throw new BuildInputError(
      'NO_FILES',
      'No reviewable files after exclusions. A review of nothing is not a clean review, so this ' +
        'refuses rather than emitting an empty input the reviewer would confidently pass. ' +
        'REMEDY: the lane should skip this PR; nothing here needs fixing.',
    );
  }

  const { kept, omitted, budget } = fitFilesToPrompt(candidates, unreviewable);
  if (kept.length === 0) {
    // NAME THE CAUSE THAT ACTUALLY BIT. One message covered both and was false
    // about one of them: 2,000 files totalling 26 KB of patch were refused with
    // "no single file's patch fits", which was wrong about every one of them.
    // The two failures have different remedies, so telling them apart is not
    // cosmetic.
    const smallest = Math.min(...candidates.map((c) => Buffer.byteLength(c.patch, 'utf8')));
    const why =
      budget <= 0
        ? `Listing this PR's ${candidates.length} changed file(s) fills the ${MAX_PROMPT_BYTES}-byte model ` +
          'prompt before a single patch is added, so there is no room to review any of them. It is the ' +
          'FILE COUNT, not the diff: the paths alone do not fit.'
        : `No single file's patch fits the ${budget} bytes left of the ${MAX_PROMPT_BYTES}-byte model ` +
          `prompt; the smallest of the ${candidates.length} is ${smallest} bytes.`;
    throw new BuildInputError(
      'NOTHING_FITS',
      `${why} There is nothing to degrade to: a review that read none of the diff would be a clean ` +
        'verdict it never earned, so the lane posts a `nothing-to-review` marker instead of a review. ' +
        'That leaves the head covered for dedup and NOT full, so CodeRabbit still reads the PR, rather ' +
        'than red for a re-run that would fail identically. REMEDY: split the PR.',
    );
  }
  // RECORDED, NEVER SILENTLY DROPPED -- the same rule as the no-patch rows
  // above, and the reason is a CONSTANT so downstream can tell "dropped to fit
  // the prompt" from "GitHub sent no patch" and put it in the marker.
  for (const o of omitted) {
    unreviewable.push({ path: o.path, reason: OMITTED_FOR_PROMPT_REASON, kind: UNREVIEWABLE_UNREAD });
  }

  const files = kept.map(({ path, patch }) => ({ path, patch, addedLineRanges: addedLineRanges(patch) }));
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
  const omittedRows = input.unreviewable.filter((u) => u.reason === OMITTED_FOR_PROMPT_REASON);
  if (omittedRows.length > 0) {
    console.log(
      `::warning::review-input: PARTIAL REVIEW -- ${omittedRows.length} file(s) dropped to fit the ` +
        'model prompt (#3679). They are recorded as unreviewable and the posted marker will name them; ' +
        'nothing vouches for those files.',
    );
  }
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
