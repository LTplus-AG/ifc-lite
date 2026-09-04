/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PROOF OF WORK (module-size budget, #3795 split out of validate-findings.mjs).
 * The anti-#1644 checks: `checkProofOfWork` proves the model actually read
 * every file it was sent (and only those), and `siblingVerifies` proves a
 * cross-file claim is anchored to an excerpt the harness really provided,
 * never to the model's word for it.
 */

import { ValidateFindingsError } from './validate-findings-error.mjs';
import { quoteAppearsIn, quotedLineFailureMessage } from '../quote-line-coupling.mjs';
import { sanitizePath } from './finding-sanitizers.mjs';

/** @param {unknown} v */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

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
export function checkProofOfWork({ response, input }) {
  const expected = new Set(input.files.keys());
  const claimed = new Set(response.files_reviewed);
  const missing = [...expected].filter((p) => !claimed.has(p));
  const extra = [...claimed].filter((p) => !expected.has(p));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidateFindingsError(
      'PROOF_OF_WORK_FAILED',
      '`files_reviewed` is not the set of files that were sent.' +
        (missing.length > 0 ? ` NOT REVIEWED: ${missing.map(sanitizePath).join(', ')}.` : '') +
        (extra.length > 0 ? ` NEVER SENT: ${extra.map(sanitizePath).join(', ')}.` : '') +
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
      `\`riskiest_change.path\` is \`${sanitizePath(rc.path)}\`, which was never sent. REMEDY: re-run.`,
    );
  }
  if (!quoteAppearsIn(file.patch, rc.quoted_line, MIN_PROOF_QUOTE_CHARS)) {
    throw new ValidateFindingsError(
      'PROOF_OF_WORK_FAILED',
      quotedLineFailureMessage(input.files, rc.path, rc.quoted_line, MIN_PROOF_QUOTE_CHARS),
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
    return { ok: false, reason: `no excerpt from \`${sanitizePath(path)}\` near line ${line} was in the pack` };
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
      return { ok: false, reason: `\`sibling.quote\` is not in the excerpt from \`${sanitizePath(path)}\`` };
    }
  }
  return { ok: true, reason: null };
}
