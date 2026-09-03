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
 * The marker the reviewer writes at the END of a successful post. Anchored at
 * both ends and tolerant of surrounding whitespace only -- a loose pattern here
 * would let a contributor hand-write a passing marker into a PR comment.
 */
export const MARKER_RE = /<!--\s*ifc-lite-review\s+sha=([0-9a-f]{40})\s+verdict=(clean|findings|nothing-to-review|dropped)\s+count=(\d+)(?:\s+omitted=(\d+))?\s*-->/;

/** The shape a malformed-marker diagnosis should tell the reader to produce. */
export const MARKER_SHAPE =
  '`<!-- ifc-lite-review sha=<40-hex> verdict=clean|findings|nothing-to-review|dropped count=<n>' +
  '[ omitted=<n>] -->`';
