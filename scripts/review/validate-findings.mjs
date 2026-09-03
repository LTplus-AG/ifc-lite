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
 *   2. CLOSED (#3658). `line` and `quote` used to be checked INDEPENDENTLY: the
 *      quote had to appear somewhere in the file's patch, and the line had to
 *      fall in one of that file's added ranges, but nothing compared the two --
 *      so a finding quoting one added line and anchored at a different added
 *      line passed and posted on the wrong line. `addedLinesMatching` below now
 *      requires the quote to be the TEXT of the added line AT `f.line`,
 *      trimmed the way `newFileLines` trims a context line. A mismatch is
 *      DROPPED, not corrected to the line the quote actually sits on: a comment
 *      moved to a line the model never named is a second guess this file has no
 *      basis for, and a dropped finding is loud (a DROPPED warning naming both
 *      the claimed line and, when found, the line the quote actually matches)
 *      where a silently-relocated one would not be.
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

import { writeFileSync, rmSync } from 'node:fs';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { ValidateFindingsError } from './lib/validate-findings-error.mjs';
// quotableLines/quoteAppearsIn/lineIsAdded/addedLinesMatching moved to
// ./quote-line-coupling.mjs (module-size budget). Re-exported below so every
// existing import of them from this file keeps working unchanged.
import { quotableLines, quoteAppearsIn, lineIsAdded, addedLinesMatching, quotedLineFailureMessage } from './quote-line-coupling.mjs';
// readText/stripFence/parseRaw/readInput moved to ./lib/review-input-reader.mjs
// (module-size budget, #3795). Imported (not `export ... from`) because
// main() below calls `readInput` and `parseRaw` itself, and re-exported so
// every existing import of `stripFence`/`readInput` from this file keeps
// working unchanged.
import { readText, stripFence, parseRaw, readInput } from './lib/review-input-reader.mjs';
// SENTINEL/MAX_FINDINGS/validate/omittedForPromptPaths moved to
// ./lib/finding-schema.mjs (module-size budget, #3795). Imported (not `export
// ... from`) because main() below calls `validate` and `omittedForPromptPaths`
// itself, and re-exported so every existing import of these four names from
// this file keeps working unchanged.
import { SENTINEL, MAX_FINDINGS, validate, omittedForPromptPaths, DROPPED_LABEL } from './lib/finding-schema.mjs';
// MAX_BODY_CHARS/sanitizeBody/sanitizeLabel/sanitizePath moved to
// ./lib/finding-sanitizers.mjs (module-size budget, #3795). Re-exported below.
import { MAX_BODY_CHARS, sanitizeBody, sanitizeLabel, sanitizePath } from './lib/finding-sanitizers.mjs';
// siblingVerifies moved to ./lib/finding-proof-of-work.mjs (module-size
// budget, #3795), alongside checkProofOfWork, which stays private there.
// Re-exported below.
import { siblingVerifies } from './lib/finding-proof-of-work.mjs';

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


export { quotableLines, quoteAppearsIn, lineIsAdded, addedLinesMatching, quotedLineFailureMessage };

export { ValidateFindingsError };
export { stripFence, readInput };
export { SENTINEL, MAX_FINDINGS, validate, omittedForPromptPaths };
export { MAX_BODY_CHARS, sanitizeBody, sanitizeLabel, sanitizePath };
export { siblingVerifies };

/**
 * The warning sink's own prefix, and the whole line-start claude-review.yml
 * greps for when it copies the drop reasons onto the pull request.
 *
 * COMPOSED, not spelled a second time: `DROPPED_LOG_PREFIX` is exactly what this
 * file prints in front of what `finding-schema.mjs` writes, so the constant
 * cannot describe a line the code does not emit. A test pins it against the YAML
 * grep AND against a real CLI run, because pinning it against the YAML alone
 * would pass with the sink emitting something else entirely.
 */
const WARN_PREFIX = '\u26a0\ufe0f  ';
export const DROPPED_LOG_PREFIX = `${WARN_PREFIX}${DROPPED_LABEL}`;

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
  const result = validate({ response, input, onWarn: (w) => console.log(`${WARN_PREFIX}${w}`) });

  const doc = {
    headSha: input.headSha,
    verdict: result.verdict,
    findings: result.findings,
    // What the review DID NOT read, dropped upstream to fit the model prompt
    // (#3679). Carried here because findings.json is the only artefact the
    // poster sees: without this row the marker for a partial review would be
    // byte-identical to a full one.
    omitted: omittedForPromptPaths(input.unreviewable),
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
  if (doc.omitted.length > 0) {
    console.log(
      `   PARTIAL: ${doc.omitted.length} file(s) were dropped upstream to fit the model prompt and were ` +
        'NOT reviewed; the poster will say so on the PR.',
    );
  }
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
