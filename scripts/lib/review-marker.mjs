/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE MARKER GRAMMAR: what a posted review verdict looks like, and which
 * verdicts exist.
 *
 * One place, because three files write markers and two read them, and the
 * vocabulary is the contract between them. Split out of check-review-posted.mjs
 * under the shrink-or-split rule; it is a cohesive slice rather than a line-count
 * one -- the pattern and the list of verdicts are the same fact.
 *
 * THE FOUR VERDICTS:
 *   clean              reviewed, nothing to flag.
 *   findings           reviewed, N findings stand on this head.
 *   nothing-to-review  the model was never run (everything excluded, or no part
 *                      of the diff fits the prompt). COVERED, not full.
 *   dropped            the model ran, was retried, and every finding it produced
 *                      was refused. NOT covered -- see review-dropped-verdict.mjs.
 */

/**
 * The marker the reviewer writes at the END of a successful post, and the `\s*$`
 * says END rather than merely describing it.
 *
 * ANCHORED AT THE TAIL ONLY, and the missing head anchor is deliberate: every
 * real summary carries prose above its marker, so `^` would reject all of them.
 * The tail anchor is what closes the forgery channel the writers already defang
 * from the other side. The summary body renders PR-chosen text BEFORE the
 * marker -- `omitted` paths and the `path:line - title` index lines -- under our
 * own identity, in a comment the gate trusts by author. Unanchored, `exec`
 * returned the FIRST match, so a marker smuggled into one of those lines
 * outranked the real one written at the end. scripts/review/lib/
 * finding-sanitizers.mjs breaks the token before it can get there; this is the
 * second lock on the same door. Text after the marker now fails to parse, which
 * the gate reports as MARKER_MALFORMED -- loud, and pointed at the writer that
 * would have to have drifted for it to happen. Raised by CodeRabbit on #3828.
 */
export const MARKER_RE = /<!--\s*ifc-lite-review\s+sha=([0-9a-f]{40})\s+verdict=(clean|findings|nothing-to-review|dropped)\s+count=(\d+)(?:\s+omitted=(\d+))?\s*-->\s*$/;

/** The shape a malformed-marker diagnosis should tell the reader to produce. */
export const MARKER_SHAPE =
  '`<!-- ifc-lite-review sha=<40-hex> verdict=clean|findings|nothing-to-review|dropped count=<n>' +
  '[ omitted=<n>] -->`';
