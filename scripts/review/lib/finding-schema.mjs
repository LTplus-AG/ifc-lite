/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SCHEMA / ANCHOR VALIDATION (module-size budget, #3795 split out of
 * validate-findings.mjs). `validate()` is the whole pure policy: schema shape,
 * proof of work, per-finding anchoring, sanitisation and capping, over
 * already-read inputs so the harness can drive every branch without touching a
 * filesystem. `checkSchema`/`validateFindings` are its private steps;
 * `omittedForPromptPaths` is the sibling helper that turns the files the
 * reviewer never saw into a sanitised, posted-comment-ready list.
 */

import { ValidateFindingsError } from './validate-findings-error.mjs';
import { lineIsAdded, addedLinesMatching } from '../quote-line-coupling.mjs';
import { sanitizeBody, sanitizeLabel, sanitizePath } from './finding-sanitizers.mjs';
import { checkProofOfWork, siblingVerifies } from './finding-proof-of-work.mjs';
import { isUnread } from '../build-review-input.mjs';

/** @param {unknown} v */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

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

/** Sibling budget to `MIN_PROOF_QUOTE_CHARS` in ./finding-proof-of-work.mjs -- see that file's comment for why the two differ. */
const MIN_FINDING_QUOTE_CHARS = 3;

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
      drop(`\`${sanitizePath(f.path)}\` was never sent to the model, so this finding is about code we did not review.`);
      continue;
    }
    if (typeof f.quote !== 'string' || f.quote.trim().length < MIN_FINDING_QUOTE_CHARS) {
      drop(
        `\`quote\` is missing or under ${MIN_FINDING_QUOTE_CHARS} characters, which would not be ` +
          `evidence of anything: ${JSON.stringify(String(f.quote).slice(0, 120))}.`,
      );
      continue;
    }
    if (!lineIsAdded(f.line, file.addedLineRanges)) {
      drop(
        `\`line\` ${JSON.stringify(f.line)} is not inside an added range of \`${sanitizePath(f.path)}\` ` +
          `(${JSON.stringify(file.addedLineRanges)}). Commenting there would annotate code this PR ` +
          'did not touch.',
      );
      continue;
    }
    // THE COUPLING CHECK (#3658). `quote` and `line` used to be validated
    // independently, so a real quote anchored at the wrong added line passed
    // both checks and posted on the wrong line. Requiring the quote to BE the
    // text at that exact line closes it. On a mismatch, name where the quote
    // WAS found (if anywhere) so the drop is diagnosable rather than a bare
    // refusal -- this is the loud failure direction: the finding is dropped,
    // never silently re-anchored to a line the model did not name.
    const matches = addedLinesMatching(file.patch, f.quote);
    if (!matches.includes(f.line)) {
      drop(
        matches.length > 0
          ? `\`quote\` is not the text at \`line\` ${f.line} of \`${sanitizePath(f.path)}\` -- it IS the text of added ` +
            `line(s) ${matches.join(', ')} instead. Posting at ${f.line} would anchor a real finding to ` +
            'the wrong line, which is worse than not posting it.'
          : `\`quote\` is not the text of any added line of \`${sanitizePath(f.path)}\`: ` +
            `${JSON.stringify(f.quote.slice(0, 120))}.`,
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
  checkProofOfWork({ response, input, warn });

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

/**
 * The paths the reviewer NEVER SAW THE CONTENT OF, ready for a posted comment
 * body. Both ways that happens count: dropped to fit the model prompt (#3679),
 * and refused a patch by GitHub for being too large.
 *
 * IT USED TO BE ONLY THE FIRST, matched by `reason === OMITTED_FOR_PROMPT_REASON`
 * inline, HERE, while build-review-input.mjs's own PARTIAL REVIEW log matched
 * a DIFFERENT inline predicate over the same rows. A PR whose one unreviewable
 * file was one GitHub declined to send therefore produced a marker
 * byte-identical to a full review's, and CodeRabbit stood down on it -- the
 * absence-reads-as-success shape one layer below where #3679 put the
 * disclosure. Both call sites now share `isUnread`, exported from
 * build-review-input.mjs next to the `kind` field it reads, so the log line
 * and the posted marker cannot drift apart the way two independently spelled
 * copies did.
 *
 * A deletion or a pure rename is NOT counted: there was no changed content for
 * the reviewer to read, so nothing is being withheld and disclosing it would
 * train readers to ignore the warning.
 *
 * Sanitised HERE, because this file is the boundary between model-or-PR
 * controlled bytes and the poster: a git path may contain any byte but NUL and
 * `/`, including `-->` and the literal marker token, and an unsanitised path in
 * the summary would be a marker-forgery channel opened by the very feature
 * whose job is to keep absence visible. `sanitizePath` defangs the token and
 * strips HTML comments but keeps the path WHOLE (`sanitizeLabel`'s 60-char
 * `class` cap stood here once and rewrote real paths into names that exist
 * nowhere -- and collapsed sibling files into one string); a path that
 * sanitises to nothing still has to appear, so it is named as unprintable
 * rather than dropped.
 *
 * @param {{path: string, reason?: string}[]} unreviewable
 * @returns {string[]}
 */
export function omittedForPromptPaths(unreviewable) {
  return unreviewable
    .filter(isUnread)
    .map((u) => sanitizePath(u.path) || '(a path that sanitised to nothing)');
}
