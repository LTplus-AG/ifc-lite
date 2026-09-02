#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A MODEL'S OUTPUT IS AN UNTRUSTED STRING, AND EVERY BYTE OF IT ARRIVES ON THE
 * PULL REQUEST UNDER AN IDENTITY THE REVIEW GATE ALREADY TRUSTS.
 *
 * WHY THIS EXISTS. `scripts/check-review-posted.mjs` proves a review REACHED the
 * pull request. It says so itself, in its own stated holes: it "proves nothing
 * about whether the review was any GOOD", and "a reviewer that posts a marker and
 * an empty body satisfies this gate". This file is the other half. It stands
 * between the model and the poster, and it refuses to hand the poster anything it
 * has not checked against the diff we actually sent.
 *
 * THE THREE FAILURES IT IS BUILT AGAINST, all with evidence:
 *
 *   1. THE QUIET QUIT. anthropics/claude-code-action#1644 (bug, p1, 2026-08-13):
 *      the agent "exits success after 5-10 turns without completing the review
 *      (silent no-op)", roughly half of runs, with `is_error: false`. A model that
 *      stopped after two files can still emit a confident `verdict: "clean"`. The
 *      only thing it CANNOT do is quote lines it never read, which is why
 *      PROOF_OF_WORK_FAILED exists and why it is fatal rather than advisory.
 *
 *   2. THE CONFIDENT INVENTION. A finding naming a file we never sent, or a line
 *      the diff never touched, posts an inline comment on someone else's code. It
 *      is not a review, it is noise with our name on it, and once it is posted the
 *      review gate counts it as a finding. Per-finding validation drops these.
 *
 *   3. THE LAUNDERED MARKER, and this is the one that is a SECURITY hole rather
 *      than a quality one. Our poster posts these bodies through the default
 *      GITHUB_TOKEN, so they appear as `github-actions` -- a login listed in
 *      `expectedAuthors` in scripts/review-posted.config.json. The gate's
 *      MARKER_RE scans comment bodies on the `reviewComments` surface among
 *      others. So a finding body containing a well-formed
 *
 *          <!-- ifc-lite-review sha=<40-hex> verdict=clean count=0 -->
 *
 *      would be posted BY US, FROM A TRUSTED AUTHOR, ON THE RIGHT SURFACE, and
 *      would satisfy the gate. That is a forged review laundered through our own
 *      identity, and the input that carries it is a diff -- which any contributor
 *      can write, and which the model will faithfully quote back. `sanitize` is
 *      therefore load-bearing, not hygiene. It breaks the literal token in every
 *      model-controlled string that reaches a comment body, INCLUDING `quote`,
 *      because the most realistic delivery is a source line a contributor added
 *      on purpose for the model to quote verbatim.
 *
 * That third one is the repository's own recorded lesson twice over: absence must
 * not read as success, and a trusted channel is the one worth attacking. The cost
 * of getting it wrong is already measured here -- 174 of 830 merged PRs in August
 * 2026 (21%, 46,717 lines) carried no review while showing green, and #3175 then
 * corrected TWELVE changesets by hand that would have shipped breaking changes as
 * `patch`, with the release one command from publishing.
 *
 * PURE AND OFFLINE, on purpose. Three paths in, one file out, no network and no
 * `gh`. A step that decides whether a review is postable must not be able to fail
 * because a registry or an API was slow, and it must be drivable end to end by a
 * harness with no token and no pull request.
 *
 * FAILURE CLASSES, each with its OWN remedy, because a remedy that contradicts its
 * finding is worse than no remedy:
 *
 *   BAD_ARGS        Unrecognised flag, or a flag with no value.
 *                   REMEDY: fix the workflow step's invocation.
 *   NO_RAW/NO_INPUT/NO_OUT  A required path was not passed. Not defaulted: a
 *                   guessed path would validate a file nobody chose.
 *                   REMEDY: pass all three.
 *   RAW_UNREADABLE / INPUT_UNREADABLE  The file is missing or unreadable. An
 *                   ABSENT raw file is the #1644 shape at its most extreme -- the
 *                   model wrote nothing at all -- so it must never be read as an
 *                   empty clean review. REMEDY: read the review step's log; it ran
 *                   and produced no output.
 *   RAW_EMPTY       The raw file exists and is blank. Same shape, said separately
 *                   because the remedy differs: the step ran, so look at
 *                   `num_turns` in its log rather than at whether it ran.
 *   INPUT_INVALID   The review-input JSON we ourselves built is malformed, has no
 *                   files, or names one file twice. Fails closed: with no files to
 *                   check against, every check below passes vacuously, which is
 *                   the "scan of nothing reported as a clean scan" defect (#3194).
 *                   REMEDY: fix the step that BUILDS review-input.json.
 *   RAW_UNPARSEABLE The model's text is not JSON (one leading/trailing ```json
 *                   fence is stripped; nothing else is repaired -- see the holes).
 *                   REMEDY: tighten the prompt's output instruction. Do NOT add a
 *                   repair pass here; a repairer that guesses is a second model
 *                   with no proof of work of its own.
 *   RESPONSE_TRUNCATED  Valid JSON with no terminal sentinel. This is the check
 *                   that catches a response which stopped early yet still parses:
 *                   `{"verdict":"clean"}` is complete JSON and a complete lie.
 *                   REMEDY: raise the output token budget, or send fewer files.
 *   SCHEMA_INVALID  A required top-level field is missing or wrongly typed.
 *                   REMEDY: fix the prompt. (An individual BAD FINDING is dropped,
 *                   not fatal -- see below.)
 *   VERDICT_CONTRADICTS_FINDINGS  `verdict: "clean"` with a non-empty findings
 *                   array. Self-contradictory, and both ways of resolving it are
 *                   wrong: trusting the verdict drops real findings, trusting the
 *                   findings posts them under a marker that says clean.
 *                   REMEDY: re-run. Never guess which half was meant.
 *   PROOF_OF_WORK_FAILED  `files_reviewed` is not exactly the set we sent, or the
 *                   riskiest-change quote is not in that file's patch. The
 *                   anti-#1644 check. REMEDY: re-run; if it recurs, the review
 *                   step's log will show a low `num_turns`.
 *   VALIDATION_EMPTY  `verdict: "findings"` and NOTHING survived validation. Not
 *                   silently downgraded to clean, which would be a lie, and not
 *                   passed through as zero findings, which would leave the marker
 *                   claiming findings that do not exist.
 *                   REMEDY: read the dropped-finding warnings printed above it.
 *   OUT_UNWRITABLE  findings.json could not be written. Fatal: a poster reading a
 *                   missing or stale file is the absence-reads-as-success shape.
 *
 * ON EVERY FATAL PATH THE OUTPUT FILE IS REMOVED. A previous run's findings.json
 * sitting next to a failed validation is a stale artefact that a poster cannot
 * tell from a fresh one, and it would post last commit's findings under this
 * commit's marker.
 *
 * STATED HOLES, so nobody reads a zero exit as more than it is:
 *
 *   1. It proves the model READ the diff and that each surviving finding is
 *      ANCHORED to it. It proves nothing about whether the findings are CORRECT.
 *      A model can quote a real line and say something false about it. Precision
 *      is a separate instrument and this is not it.
 *   2. `line` and `quote` are checked INDEPENDENTLY: the quote must appear
 *      somewhere in the file's patch, and the line must fall in one of that file's
 *      added ranges, but nothing here proves the quote is ON that line. A finding
 *      can therefore land on the wrong line of the right file. Closing it means
 *      mapping hunk headers to new-file line numbers; it is deliberately not done
 *      here because a wrong-line comment is visible and recoverable, while the
 *      three failures above are silent.
 *   3. A response with prose BEFORE the fence, or two fenced blocks, is
 *      RAW_UNPARSEABLE rather than repaired. That is the intended direction: a
 *      repair pass is where a validator starts inventing the thing it validates.
 *   4. Sanitisation makes `quote` verbatim-modulo-defanging. Anything downstream
 *      that wants to re-verify verbatimness must do it against the raw model
 *      output, not against findings.json. Validation here deliberately runs BEFORE
 *      sanitisation for exactly that reason.
 *   5. The cap keeps the FIRST `MAX_FINDINGS` findings in the model's own order,
 *      which is not a severity order: arbitrary ones, not the worst ones. Stated
 *      without a numeral because it said "five" for a while after the cap became
 *      twelve, and this list exists to say what gets silently discarded.
 *   6. It cannot tell "the model had nothing to say" from "the model was throttled
 *      into saying nothing but still emitted valid JSON". PROOF_OF_WORK_FAILED
 *      catches the throttled case only when it also stopped quoting.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/**
 * The terminal sentinel the prompt requires as the LAST field. Its whole job is to
 * be absent when the response stopped early, so it is compared with `===` against
 * a literal and never matched loosely -- a `startsWith` here would accept
 * `ifc-lite-review-v1-partial` and defeat the check it exists to be.
 */
export const SENTINEL = 'ifc-lite-review-v1';

/**
 * What may survive VALIDATION. It was 5, which made sense when the reviewer was
 * the last line of defence and every finding it wrote went straight onto the PR.
 * With a judge downstream, capping here would throw candidates away before
 * anything could weigh them -- precision enforced at generation time, which is
 * what produced a 2% finding rate.
 *
 * The cap on what reaches a HUMAN is a different question and lives in
 * post-review.mjs, the only module on the posting path that always runs. It was
 * briefly declared here too; two constants of the same name and value in two
 * modules agree only until someone edits one.
 */
export const MAX_FINDINGS = 12;

/**
 * Every reason this module can exit with.
 *
 * Published rather than left to be scraped: `rubric-eval.mjs` has to decide, per
 * reason, whether a refusal means the REVIEWER answered badly (score it zero and
 * carry on) or the HARNESS broke (stop). It was recovering this list with a
 * regex over this file's source, which failed silently in one direction -- a
 * reason spelled with a digit, or in double quotes, was simply invisible.
 *
 * `validate-findings.test.mjs` holds the guard that this covers every raise
 * site, because the raise sites live here and a new reason is added here.
 */
export const REASONS = new Set([
  'BAD_ARGS',
  'NO_RAW',
  'NO_INPUT',
  'NO_OUT',
  'RAW_UNREADABLE',
  'INPUT_UNREADABLE',
  'RAW_EMPTY',
  'RAW_UNPARSEABLE',
  'RESPONSE_TRUNCATED',
  'INPUT_INVALID',
  'SCHEMA_INVALID',
  'VERDICT_CONTRADICTS_FINDINGS',
  'PROOF_OF_WORK_FAILED',
  'VALIDATION_EMPTY',
  'OUT_UNWRITABLE',
]);

/** GitHub renders long comments fine; a reviewer reading twenty of them does not. */
export const MAX_BODY_CHARS = 1500;
const TRUNCATION_NOTE = '\n\n[truncated by validate-findings]';

/**
 * A quote has to be long enough to BE evidence. `}` appears in every patch ever
 * written and quoting it proves nothing, so a proof-of-work quote that short is
 * indistinguishable from a guess.
 *
 * The two bounds differ on purpose. The riskiest-change quote is the ONE piece of
 * evidence standing between us and #1644, it is fatal when it fails, and the
 * prompt asks for a substantive line -- so it is held to eight characters. A
 * per-finding quote is backed by a second, independent check (the line must fall
 * inside an added range) and its failure DROPS a possibly-real finding, so it is
 * held to three: enough to exclude the empty and one-character cases that match
 * everything, not so much that a finding about `x = 0;` is thrown away.
 */
const MIN_PROOF_QUOTE_CHARS = 8;
const MIN_FINDING_QUOTE_CHARS = 3;

/** A class label is a short tag, not a place to smuggle a paragraph. */
const MAX_CLASS_CHARS = 60;

/**
 * THE TOKEN THAT MUST NOT SURVIVE INTO A POSTED BODY.
 *
 * Matched case-insensitively even though `check-review-posted.mjs`'s MARKER_RE is
 * case-sensitive: defanging more than the gate matches is free, and the reverse
 * mistake is a hole. The replacement swaps the SECOND ASCII hyphen for U+2011
 * NON-BREAKING HYPHEN, which reads identically to a human and cannot match a
 * pattern that requires `-`. A zero-width space would work equally well and be
 * invisible; a visible-but-inert token is preferred so a reader looking at a
 * posted comment can SEE that something was defanged rather than wonder why the
 * gate ignored it.
 */
const MARKER_TOKEN_RE = /ifc-lite-review/gi;
const DEFANGED_TOKEN = 'ifc-lite‑review';

/** Whole HTML comments, non-greedy, including multi-line ones. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * A dangling `<!--` left after the pass above (an UNCLOSED comment). It cannot
 * carry a marker on its own -- the gate's pattern needs the closing `-->` -- but
 * it can swallow whatever the poster appends after it when GitHub renders the
 * comment, including the real marker. Neutralised rather than deleted so the text
 * a human wrote is still legible.
 */
const DANGLING_COMMENT_OPEN_RE = /<!--/g;

export class ValidateFindingsError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * A Map, not an object literal, for the reason check-review-posted.mjs records:
 * `{...}[name]` reaches Object.prototype, so `--constructor x` returns a truthy
 * key, sails past a `!key` guard, and writes a junk property instead of refusing.
 */
const FLAGS = new Map([
  ['--raw', 'raw'],
  ['--input', 'input'],
  ['--out', 'out'],
]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { raw: null, input: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = FLAGS.get(argv[i]);
    if (!key) throw new ValidateFindingsError('BAD_ARGS', `Unrecognised argument \`${argv[i]}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new ValidateFindingsError('BAD_ARGS', `\`${argv[i]}\` needs a value.`);
    out[key] = v;
    i += 1;
  }
  return out;
}

/** @param {string} path @param {string} kind */
function readText(path, kind) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ValidateFindingsError(
      kind === 'raw' ? 'RAW_UNREADABLE' : 'INPUT_UNREADABLE',
      `Cannot read \`${path}\`: ${err.code || err.message}. ` +
        (kind === 'raw'
          ? 'A MISSING model output is not an empty clean review; it is the #1644 shape at its most ' +
            'extreme. REMEDY: read the review step\'s log -- it ran and produced no file.'
          : 'REMEDY: fix the step that builds review-input.json.'),
    );
  }
}

/**
 * Strip ONE leading fence and its matching trailing fence. Nothing else is
 * repaired: see hole 3. A leading fence with no closing one is left alone, which
 * makes the remainder fail to parse if it is genuinely truncated and parse if it
 * is not -- the honest outcome either way.
 *
 * @param {string} text
 */
export function stripFence(text) {
  const t = String(text).trim();
  if (!t.startsWith('```')) return t;
  const nl = t.indexOf('\n');
  if (nl === -1) return t;
  // ``` optionally followed by a bare language tag, and NOTHING else. `~~~json {`
  // or ```json trailing junk is not a fence this will strip, because stripping a
  // line it does not understand is a repair.
  if (!/^```[A-Za-z0-9_+-]*$/.test(t.slice(0, nl).trim())) return t;
  let body = t.slice(nl + 1);
  const close = body.lastIndexOf('```');
  if (close !== -1 && body.slice(close + 3).trim() === '') body = body.slice(0, close);
  return body.trim();
}

/**
 * The model's text to an object, or a classified refusal.
 *
 * The plain-object check is NOT folded into the schema pass below and runs before
 * the sentinel check, because it is a precondition of both: reaching for `.end` on
 * `null` throws a TypeError past this file's catch and prints a stack trace where
 * a remedy should be. `[1,2]` and `"done"` are refused for the same reason. That
 * is SCHEMA_INVALID rather than RESPONSE_TRUNCATED on purpose -- a response of the
 * wrong SHAPE is a prompt problem, not a length problem, and the remedies differ.
 *
 * @param {string} text
 */
export function parseRaw(text) {
  const stripped = stripFence(text);
  if (stripped === '') {
    throw new ValidateFindingsError(
      'RAW_EMPTY',
      'The model produced no output at all. This is the #1644 silent no-op: the step exits 0 having ' +
        'reviewed nothing. It is NOT a clean review. REMEDY: re-run, and read `num_turns` in the ' +
        'review step\'s log if it recurs.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new ValidateFindingsError(
      'RAW_UNPARSEABLE',
      `The model's output is not JSON: ${err.message}. One leading/trailing \`\`\` fence is stripped ` +
        'and nothing else is repaired, deliberately. REMEDY: tighten the prompt\'s output instruction. ' +
        'Do not add a repair pass here -- a repairer that guesses is a second unreviewed model.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidateFindingsError(
      'SCHEMA_INVALID',
      `The model's output parsed as ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}, ` +
        'not an object. Reaching for a field on it would throw past this file\'s catch and print a ' +
        'stack trace instead of a remedy. REMEDY: fix the prompt.',
    );
  }
  return parsed;
}

/** @param {unknown} v */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * The review-input WE built. Validated as strictly as the model's output, because
 * a broken input makes every check below pass vacuously -- and a vacuous pass here
 * is a green tick over an unreviewed diff, which is the entire failure this lane
 * exists to close.
 *
 * @param {string} path
 */
export function readInput(path) {
  const raw = readText(path, 'input');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new ValidateFindingsError('INPUT_INVALID', `\`${path}\` is not valid JSON: ${err.message}`);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ValidateFindingsError('INPUT_INVALID', `\`${path}\` must be a JSON object.`);
  }
  if (typeof cfg.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(cfg.headSha)) {
    throw new ValidateFindingsError(
      'INPUT_INVALID',
      `\`headSha\` must be a full 40-hex commit; got ${JSON.stringify(cfg.headSha)}. It is copied ` +
        'verbatim into findings.json so the marker names a commit the MODEL never chose.',
    );
  }
  if (!Array.isArray(cfg.files) || cfg.files.length === 0) {
    throw new ValidateFindingsError(
      'INPUT_INVALID',
      '`files` must be a non-empty array. With zero files every check below passes having verified ' +
        'nothing, which is a scan of nothing reported as a clean scan (#3194). REMEDY: fix the step ' +
        'that builds review-input.json, or skip the review lane entirely for an empty diff.',
    );
  }
  const files = new Map();
  for (const [i, f] of cfg.files.entries()) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw new ValidateFindingsError('INPUT_INVALID', `\`files[${i}]\` is not an object.`);
    }
    if (!isNonEmptyString(f.path)) {
      throw new ValidateFindingsError('INPUT_INVALID', `\`files[${i}].path\` must be a non-empty string.`);
    }
    if (typeof f.patch !== 'string') {
      throw new ValidateFindingsError('INPUT_INVALID', `\`files[${i}].patch\` must be a string.`);
    }
    if (files.has(f.path)) {
      // Set equality still passes with a duplicate, and "that file's patch"
      // silently becomes "whichever copy won" -- a check that reads as precise
      // while adjudicating an arbitrary half of the input.
      throw new ValidateFindingsError(
        'INPUT_INVALID',
        `\`${f.path}\` appears twice in \`files\`. Which patch a finding is checked against would be ` +
          'decided by array order. REMEDY: de-duplicate in the builder.',
      );
    }
    const ranges = f.addedLineRanges;
    if (!Array.isArray(ranges)) {
      throw new ValidateFindingsError('INPUT_INVALID', `\`files[${i}].addedLineRanges\` must be an array.`);
    }
    for (const [j, r] of ranges.entries()) {
      const bad =
        !Array.isArray(r) ||
        r.length !== 2 ||
        !Number.isInteger(r[0]) ||
        !Number.isInteger(r[1]) ||
        r[0] < 1 ||
        r[1] < r[0];
      if (bad) {
        throw new ValidateFindingsError(
          'INPUT_INVALID',
          `\`files[${i}].addedLineRanges[${j}]\` must be [start, end] integers with 1 <= start <= end; ` +
            `got ${JSON.stringify(r)}.`,
        );
      }
    }
    files.set(f.path, { path: f.path, patch: f.patch, addedLineRanges: ranges });
  }
  const unreviewable = cfg.unreviewable === undefined ? [] : cfg.unreviewable;
  if (
    !Array.isArray(unreviewable) ||
    unreviewable.some((u) => !u || typeof u !== 'object' || !isNonEmptyString(u.path))
  ) {
    throw new ValidateFindingsError(
      'INPUT_INVALID',
      '`unreviewable` must be an array of objects each carrying a non-empty `path`. Annotated STRINGS were the ' +
        'earlier shape and made the overlap check below unable to match anything -- an inert ' +
        'guard that reads as a live one.',
    );
  }
  for (const { path: p } of unreviewable) {
    if (files.has(p)) {
      throw new ValidateFindingsError(
        'INPUT_INVALID',
        `\`${p}\` is listed in BOTH \`files\` and \`unreviewable\`. The model is told those two lists ` +
          'mean opposite things, so proof of work would demand it both review and not review the file.',
      );
    }
  }
  // `contextPack` IS CARRIED. Without it `input.contextPack` is undefined at the
  // siblingVerifies call, that helper takes its "no sibling excerpts were
  // provided" branch every single time, and EVERY finding naming a sibling is
  // dropped as fabricated -- including ones whose sibling is real and was in the
  // pack the reviewer was shown. A review whose findings all name siblings then
  // dies as VALIDATION_EMPTY: red job, no marker, and no re-run can clear it.
  // The check was written, tested by hand, and wired to a value that never
  // arrived.
  return { headSha: cfg.headSha, files, unreviewable, contextPack: cfg.contextPack ?? null };
}

/**
 * The lines of a unified diff a quote may legitimately come from, each with its
 * diff marker removed and trimmed.
 *
 * NOT `patch.includes(quote)`. That accepts a fragment spanning a line boundary,
 * a substring of a longer identifier, and -- the one that matters -- the text of
 * the hunk header or the `+++ b/path` line, none of which require having read any
 * code. Whole-line equality after trimming is both stricter (no fragments) and
 * more forgiving where it should be (trailing whitespace and the diff marker do
 * not decide whether a quote counts).
 *
 * @param {string} patch
 * @returns {string[]}
 */
export function quotableLines(patch) {
  const out = [];
  for (const line of String(patch).split(/\r?\n/)) {
    // Hunk headers, file headers and the no-newline note are diff METADATA. A
    // model that quotes one has demonstrated nothing about the code.
    if (line.startsWith('@@') || line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('\\')) {
      continue;
    }
    const marker = line[0];
    const body = marker === '+' || marker === '-' || marker === ' ' ? line.slice(1) : line;
    const trimmed = body.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/**
 * Does `quote` name a whole line of `patch`, and is it long enough to be evidence?
 *
 * @param {string} patch
 * @param {string} quote
 * @param {number} minChars
 */
export function quoteAppearsIn(patch, quote, minChars) {
  const needle = String(quote).trim();
  if (needle.length < minChars) return false;
  return quotableLines(patch).includes(needle);
}

/** @param {number} line @param {[number, number][]} ranges */
export function lineIsAdded(line, ranges) {
  if (!Number.isInteger(line) || line < 1) return false;
  return ranges.some(([start, end]) => line >= start && line <= end);
}

/**
 * THE SECURITY BOUNDARY. Everything the model controls that can reach a posted
 * comment body goes through here.
 *
 * Order is deliberate and each step depends on the one before it:
 *
 *   1. Whole HTML comments are REMOVED. They can carry a forged marker, and they
 *      are invisible in the rendered comment, so anything hiding in one is hiding
 *      on purpose.
 *   2. Any remaining `<!--` -- an unclosed comment -- is broken, because it would
 *      otherwise swallow the real marker the poster appends after this body.
 *   3. The literal token `ifc-lite-review` is broken EVERYWHERE, not only inside
 *      comments.
 *
 *      WHAT WAS ACTUALLY MEASURED, because the obvious claim here is wrong.
 *      Mutation-testing this file showed that against the gate's CURRENT
 *      MARKER_RE, steps 1 and 2 are already sufficient on their own: that pattern
 *      requires a literal `<!--`, and after those two steps no `<!--` survives in
 *      the output at all. So the three steps are mutually redundant there, and it
 *      would be false to call this one "the" defence.
 *
 *      It earns its place on the two cases the others do not cover. First, the
 *      token appears in ORDINARY TEXT that is not in a comment -- this lane's own
 *      source carries it (MARKER_RE in check-review-posted.mjs, and this file), so
 *      a model reviewing that diff quotes it and a reviewer writing about it types
 *      it. Second, it is the only step that still holds if the gate's pattern is
 *      ever loosened to match the token outside an HTML comment, which is a change
 *      a future editor could make in check-review-posted.mjs without ever reading
 *      this file.
 *   4. `@` before a word character gets a zero-width space, so a body cannot
 *      summon a person or a team into a thread. (An email address in a body picks
 *      up the same treatment. That is a cosmetic cost on a rare input, taken
 *      knowingly rather than adding a cleverer pattern with a hole in it.)
 *   5. The length cap runs LAST, so the final string is genuinely within the cap:
 *      steps 1-4 change the length in both directions, and capping before them
 *      would let defanging push the result back over. Truncation can only DELETE
 *      trailing text, so it cannot construct a marker out of what remains.
 *
 * @param {unknown} text
 */
export function sanitizeBody(text) {
  let out = String(text ?? '')
    .replace(HTML_COMMENT_RE, '')
    .replace(DANGLING_COMMENT_OPEN_RE, '<!‑-')
    .replace(MARKER_TOKEN_RE, DEFANGED_TOKEN)
    .replace(/@(?=[A-Za-z0-9])/g, '@​');
  if (out.length > MAX_BODY_CHARS) {
    out = out.slice(0, MAX_BODY_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
  }
  return out;
}

/**
 * A short label, held to a tighter budget than a body. Same defanging: `class` is
 * model-controlled and a poster that renders it into the comment would carry a
 * marker just as well as `body` would.
 *
 * @param {unknown} text
 */
export function sanitizeLabel(text) {
  const out = String(text ?? '')
    .replace(HTML_COMMENT_RE, '')
    .replace(DANGLING_COMMENT_OPEN_RE, '<!‑-')
    .replace(MARKER_TOKEN_RE, DEFANGED_TOKEN)
    .replace(/@(?=[A-Za-z0-9])/g, '@​')
    .replace(/\s+/g, ' ')
    .trim();
  return out.slice(0, MAX_CLASS_CHARS);
}

/**
 * PROOF OF WORK. The anti-#1644 check, and the only one here that a model cannot
 * satisfy by guessing.
 *
 * Set equality in BOTH directions. A MISSING file is the quiet quit. An EXTRA file
 * is a model reporting on something it was never given, which is at least as
 * alarming and would otherwise pass a subset check. Duplicates in
 * `files_reviewed` collapse into the set, which is why the input builder is
 * required to de-duplicate `files` -- otherwise the two sides could differ in
 * multiplicity and this check would not see it.
 *
 * `unreviewable` paths are absent from `files`, so naming one here fails as an
 * extra. That is correct: those files were deliberately not sent, so a review of
 * one is a review of something the model invented.
 */
function checkProofOfWork({ response, input }) {
  const expected = new Set(input.files.keys());
  const claimed = new Set(response.files_reviewed);
  const missing = [...expected].filter((p) => !claimed.has(p));
  const extra = [...claimed].filter((p) => !expected.has(p));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidateFindingsError(
      'PROOF_OF_WORK_FAILED',
      '`files_reviewed` is not the set of files that were sent.' +
        (missing.length > 0 ? ` NOT REVIEWED: ${missing.join(', ')}.` : '') +
        (extra.length > 0 ? ` NEVER SENT: ${extra.join(', ')}.` : '') +
        ' A model that stopped early cannot report on files it never opened, which is exactly what ' +
        'claude-code-action#1644 does while exiting 0. REMEDY: re-run; if it recurs, read `num_turns` ' +
        'in the review step\'s log rather than re-running indefinitely.',
    );
  }

  const rc = response.riskiest_change;
  const file = input.files.get(rc.path);
  if (!file) {
    throw new ValidateFindingsError(
      'PROOF_OF_WORK_FAILED',
      `\`riskiest_change.path\` is \`${rc.path}\`, which was never sent. REMEDY: re-run.`,
    );
  }
  if (!quoteAppearsIn(file.patch, rc.quoted_line, MIN_PROOF_QUOTE_CHARS)) {
    throw new ValidateFindingsError(
      'PROOF_OF_WORK_FAILED',
      `\`riskiest_change.quoted_line\` is not a line of \`${rc.path}\`'s patch (or is shorter than ` +
        `${MIN_PROOF_QUOTE_CHARS} characters, which would not be evidence of anything): ` +
        `${JSON.stringify(String(rc.quoted_line).slice(0, 120))}. This is the one thing a model that ` +
        'quit early cannot fake. REMEDY: re-run. Quote a WHOLE line, not a fragment; and if the ' +
        'line you nominated is too long to reproduce exactly, nominate a SHORTER line from the ' +
        'same file instead -- any real line of the diff proves you read it.',
    );
  }
}

/** The top-level shape. An individual finding is validated -- and dropped -- later. */
function checkSchema(response) {
  const fail = (msg) => {
    throw new ValidateFindingsError('SCHEMA_INVALID', `${msg} REMEDY: fix the prompt's output contract.`);
  };
  if (response.verdict !== 'clean' && response.verdict !== 'findings') {
    fail(`\`verdict\` must be "clean" or "findings"; got ${JSON.stringify(response.verdict)}.`);
  }
  if (!Array.isArray(response.files_reviewed) || response.files_reviewed.some((p) => !isNonEmptyString(p))) {
    fail('`files_reviewed` must be an array of non-empty strings.');
  }
  const rc = response.riskiest_change;
  if (rc === null || typeof rc !== 'object' || Array.isArray(rc) || !isNonEmptyString(rc.path) || !isNonEmptyString(rc.quoted_line)) {
    // REQUIRED EVEN WHEN CLEAN, and especially then: a clean verdict has no
    // findings to prove the work with, so this is the ONLY evidence that the model
    // read anything. Making it optional on `clean` would put the proof exactly
    // where it is least needed and remove it exactly where it is most.
    fail('`riskiest_change` must be an object with non-empty `path` and `quoted_line` strings.');
  }
  if (!Array.isArray(response.findings)) {
    fail('`findings` must be an array (empty on a clean verdict, never omitted).');
  }
  if (response.verdict === 'clean' && response.findings.length > 0) {
    throw new ValidateFindingsError(
      'VERDICT_CONTRADICTS_FINDINGS',
      `\`verdict\` is "clean" but ${response.findings.length} finding(s) were emitted. Both ways of ` +
        'resolving this are wrong: trusting the verdict throws away real findings, trusting the ' +
        'findings posts them under a marker that says the diff was clean. REMEDY: re-run. Never guess ' +
        'which half was meant.',
    );
  }
}

/**
 * A cross-file claim is only admissible if the harness put the evidence there.
 *
 * The largest defect family in this repository is "the same fix applied at one
 * site when there are two", and until the context pack the reviewer could not
 * see the second site at all. Now it can -- but a model that has been TOLD
 * about a sibling can also invent one, and a fabricated cross-file claim is
 * worse than silence: it sends the author to a file that is fine.
 *
 * So the sibling is checked the same way the anchor quote is: against text the
 * harness retrieved, never against the model's word for it. `path` and `line`
 * must match an excerpt actually placed in the pack, and the quote must appear
 * in that excerpt. A finding whose sibling does not verify is dropped as
 * fabricated, exactly like a bad anchor.
 */
export function siblingVerifies(sibling, contextPack) {
  if (sibling == null) return { ok: true, reason: null };       // absent is fine
  if (typeof sibling !== 'object' || Array.isArray(sibling)) {
    return { ok: false, reason: '`sibling` is not an object' };
  }
  const { path, line, quote } = sibling;
  if (!isNonEmptyString(path)) return { ok: false, reason: '`sibling.path` is missing' };
  if (!Number.isInteger(line) || line < 1) return { ok: false, reason: '`sibling.line` is not a line number' };
  const excerpts = contextPack?.siblings ?? [];
  if (excerpts.length === 0) {
    return { ok: false, reason: 'no sibling excerpts were provided, so a cross-file claim has no evidence' };
  }
  const near = excerpts.filter((e) => e.path === path && Math.abs(e.line - line) <= 3);
  if (near.length === 0) {
    return { ok: false, reason: `no excerpt from \`${path}\` near line ${line} was in the pack` };
  }
  if (isNonEmptyString(quote)) {
    const needle = quote.trim();
    // ONE WAY ONLY: the excerpt must contain the quote, never the reverse. The
    // second direction let a fabricated quote pass by merely CONTAINING a real
    // excerpt line -- "the importer does cache.set(n, scaled); and then silently
    // drops the alpha channel" verified against an excerpt of
    // `cache.set(n, scaled);`, because the invented sentence contains it. That
    // defeats the whole check: the model can wrap one real line in any amount of
    // invented prose and the harness certifies the lot.
    //
    // The reviewer is shown these excerpts, so quoting FROM one is the only
    // honest direction. A quote longer than the excerpt is not evidence of
    // anything the harness put there.
    if (!near.some((e) => e.text.includes(needle))) {
      return { ok: false, reason: `\`sibling.quote\` is not in the excerpt from \`${path}\`` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Per-finding validation. INVALID FINDINGS ARE DROPPED, NOT FATAL, and that is a
 * deliberate asymmetry: a model that gets three of four right should still deliver
 * the three. Every drop is warned about by name, so a silent drop is impossible.
 *
 * A malformed MEMBER is dropped for the same reason a wrong path is -- it is one
 * finding the model got wrong, not a broken contract. The top-level `findings`
 * being the wrong TYPE is fatal, above, because then there is nothing to iterate.
 *
 * STATED HOLE: five garbage findings and one good one exits 0 with one finding.
 * That is the intended trade. The verdict-level check (VALIDATION_EMPTY) is what
 * stands behind it when NOTHING survives.
 */

function validateFindings({ response, input, warn }) {
  const kept = [];
  for (const [i, f] of response.findings.entries()) {
    const drop = (why) => {
      warn(`DROPPED findings[${i}]: ${why}`);
      return true;
    };
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      drop('not an object.');
      continue;
    }
    if (!isNonEmptyString(f.path)) {
      drop('`path` is missing or not a non-empty string.');
      continue;
    }
    const sib = siblingVerifies(f.sibling, input.contextPack);
    if (!sib.ok) {
      drop(`\`sibling\` does not verify: ${sib.reason}. A cross-file claim the harness cannot confirm is fabricated.`);
      continue;
    }
    const file = input.files.get(f.path);
    if (!file) {
      drop(`\`${f.path}\` was never sent to the model, so this finding is about code we did not review.`);
      continue;
    }
    if (typeof f.quote !== 'string' || !quoteAppearsIn(file.patch, f.quote, MIN_FINDING_QUOTE_CHARS)) {
      drop(
        `\`quote\` is not a line of \`${f.path}\`'s patch (or is under ${MIN_FINDING_QUOTE_CHARS} ` +
          `characters): ${JSON.stringify(String(f.quote).slice(0, 120))}.`,
      );
      continue;
    }
    if (!lineIsAdded(f.line, file.addedLineRanges)) {
      drop(
        `\`line\` ${JSON.stringify(f.line)} is not inside an added range of \`${f.path}\` ` +
          `(${JSON.stringify(file.addedLineRanges)}). Commenting there would annotate code this PR ` +
          'did not touch.',
      );
      continue;
    }
    if (!isNonEmptyString(f.body)) {
      // An empty body posts a comment that says nothing while the marker counts it
      // as a finding -- the "marker with an empty body" hole check-review-posted
      // states about itself. Closed here, where the body still exists.
      drop('`body` is missing or empty; it would post a comment that says nothing.');
      continue;
    }
    kept.push(f);
  }
  return kept;
}

/**
 * The whole policy, pure over already-read inputs so the harness can drive every
 * branch without touching a filesystem.
 *
 * @returns {{ verdict: string, findings: object[], warnings: string[], counts: object }}
 */
export function validate({ response, input, onWarn = null }) {
  const warnings = [];
  // WARNINGS ARE EMITTED AS THEY HAPPEN, not collected and printed by the caller
  // afterwards. VALIDATION_EMPTY's remedy is "read the DROPPED warnings above",
  // and on that path `validate` THROWS -- so a caller that printed the returned
  // array would print nothing at all, and the remedy would point at output that
  // does not exist. A gate whose remedy contradicts its finding is worse than one
  // with no remedy. Caught by its own test, which is why the sink is a parameter.
  const warn = (m) => {
    warnings.push(m);
    if (onWarn) onWarn(m);
  };

  // THE SENTINEL FIRST, before the field-by-field schema pass. A response that
  // stopped early usually fails several schema checks at once, and reporting the
  // first missing field would send the reader to fix the prompt when the real
  // problem is the token budget. The sentinel names the actual cause.
  if (response.end !== SENTINEL) {
    throw new ValidateFindingsError(
      'RESPONSE_TRUNCATED',
      `The terminal sentinel is ${JSON.stringify(response.end)}, not ${JSON.stringify(SENTINEL)}. ` +
        'Valid JSON is not evidence of a complete response: `{"verdict":"clean"}` parses perfectly ' +
        'and reviewed nothing. The sentinel is the LAST field the model writes, so its absence means ' +
        'the response ended before the model meant it to. REMEDY: raise the output token budget, or ' +
        'send fewer files per run.',
    );
  }

  checkSchema(response);
  checkProofOfWork({ response, input });

  let kept = validateFindings({ response, input, warn });
  const survived = kept.length;

  if (response.verdict === 'findings' && survived === 0) {
    throw new ValidateFindingsError(
      'VALIDATION_EMPTY',
      `The model reported ${response.findings.length} finding(s) and NONE survived validation. ` +
        'Not downgraded to clean, which would post a verdict the model never gave, and not passed ' +
        'through empty, which would leave the marker claiming findings that do not exist. ' +
        'REMEDY: read the DROPPED warnings above -- they name what was wrong with each one.',
    );
  }

  let capped = 0;
  if (kept.length > MAX_FINDINGS) {
    capped = kept.length - MAX_FINDINGS;
    warn(
      `CAPPED: ${kept.length} valid findings, keeping the first ${MAX_FINDINGS} in the model's own ` +
        `order and dropping ${capped}. That order is not a severity order (stated hole 5).`,
    );
    kept = kept.slice(0, MAX_FINDINGS);
  }

  // SANITISED LAST. Every check above compared against the RAW model text, so
  // "verbatim" meant verbatim; defanging first would have made a quote of a line
  // containing the marker token fail its own verbatim check and be dropped as a
  // fabrication, which is the wrong diagnosis and the wrong remedy.
  const findings = kept.map((f) => ({
    path: f.path,
    line: f.line,
    quote: sanitizeBody(f.quote),
    // Sanitised FIRST, then required non-empty. Checking the raw body let a
    // finding whose body is only an HTML comment pass validation, sanitise to the
    // empty string, and be refused downstream by post-review as BAD_FINDING -- a
    // red job with no marker, for input this validator had certified. Two files
    // in one change disagreeing about the same contract.
    body: sanitizeBody(f.body),
    class: sanitizeLabel(f.class ?? 'unclassified') || 'unclassified',
    // CARRIED THROUGH, because verifying it and then dropping it is worse than
    // never checking. `siblingVerifies` above proves the excerpt the finding
    // names is really in the pack at the line it claims -- and this map then
    // emitted everything BUT the sibling, so the judge read "verified sibling:
    // none" on every finding and post-review could not render one either. The
    // defect family this repository calls its largest -- a fix applied at one of
    // two sites -- reached the judge stripped of the single piece of evidence
    // supporting it, beside a rubric that says to drop assertions the quoted
    // lines do not show. It was the class most likely to be deleted, and the
    // deletion is not fail-soft.
    ...(f.sibling
      ? {
          sibling: {
            path: f.sibling.path,
            line: f.sibling.line,
            ...(f.sibling.quote ? { quote: sanitizeBody(f.sibling.quote) } : {}),
          },
        }
      : {}),
  }));

  // A finding whose body sanitises to nothing is DROPPED here rather than
  // certified. It would otherwise reach post-review, which refuses an empty body
  // as BAD_FINDING and reddens the job with no marker -- for input this file had
  // just approved.
  const nonEmpty = findings.filter((f) => f.body.trim() !== '');
  if (findings.length > 0 && nonEmpty.length === 0) {
    throw new ValidateFindingsError(
      'VALIDATION_EMPTY',
      'Every surviving finding sanitised to an empty body. Reporting `clean` here would be a lie ' +
        'and reporting findings would name comments that cannot be posted. REMEDY: re-run.',
    );
  }


  return {
    verdict: response.verdict,
    findings: nonEmpty,
    warnings,
    counts: { emitted: response.findings.length, surviving: survived, capped, kept: findings.length },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.raw) throw new ValidateFindingsError('NO_RAW', 'Pass `--raw <path>`, the model\'s raw output.');
  if (!args.input) {
    throw new ValidateFindingsError(
      'NO_INPUT',
      'Pass `--input <path>`, the review-input JSON that was sent. Without it there is nothing to ' +
        'check the model\'s claims AGAINST, and every check below would pass vacuously.',
    );
  }
  if (!args.out) throw new ValidateFindingsError('NO_OUT', 'Pass `--out <path>` for findings.json.');

  const input = readInput(args.input);
  const response = parseRaw(readText(args.raw, 'raw'));
  const result = validate({ response, input, onWarn: (w) => console.log(`⚠️  ${w}`) });

  const doc = {
    headSha: input.headSha,
    verdict: result.verdict,
    findings: result.findings,
    counts: result.counts,
    warnings: result.warnings,
  };
  try {
    writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    throw new ValidateFindingsError(
      'OUT_UNWRITABLE',
      `Cannot write \`${args.out}\`: ${err.code || err.message}. A poster reading a missing or stale ` +
        'file is the absence-reads-as-success shape this lane exists to close.',
    );
  }

  console.log(
    `✅ VALIDATED: verdict=${result.verdict}, ${result.counts.kept} finding(s) written to ${args.out} ` +
      `(${result.counts.emitted} emitted, ${result.counts.emitted - result.counts.surviving} dropped, ` +
      `${result.counts.capped} capped).`,
  );
  console.log(
    '   This proves the model READ the diff and that each surviving finding is ANCHORED to it. It ' +
      'proves nothing about whether the findings are CORRECT.',
  );
  process.exit(0);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof ValidateFindingsError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      // NOTHING IS LEFT BEHIND ON A FATAL PATH. A previous run's findings.json
      // next to a failed validation is indistinguishable from a fresh one, and a
      // poster reading it would post the last commit's findings under this
      // commit's marker.
      const out = process.argv[process.argv.indexOf('--out') + 1];
      if (process.argv.includes('--out') && out) {
        try {
          rmSync(out, { force: true });
        } catch {
          // The refusal above is the finding; failing to clean up is not worth
          // masking it with a second error.
        }
      }
      process.exit(1);
    }
    throw err;
  }
}
