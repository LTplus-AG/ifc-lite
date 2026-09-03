/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * READING THE TWO INPUTS (module-size budget, #3795 split out of
 * validate-findings.mjs): the model's raw text (`readText`/`stripFence`/
 * `parseRaw`) and the review-input JSON we ourselves built (`readInput`),
 * validated as strictly as the model's output -- a broken input makes every
 * check downstream pass vacuously, which is a green tick over an unreviewed
 * diff.
 */

import { readFileSync } from 'node:fs';
import { ValidateFindingsError } from './validate-findings-error.mjs';


/** @param {string} path @param {string} kind */
export function readText(path, kind) {
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
