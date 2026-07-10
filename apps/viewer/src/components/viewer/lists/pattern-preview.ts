/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live preview for the custom / pattern column entry (issue #1591 follow-up).
 *
 * The set-name field accepts a Bonsai-style `/regex/` pattern that pulls one
 * value across every matching property / quantity set. Before the column is
 * added, this resolves the pattern against the set names already discovered in
 * the loaded models so the builder can show "matches N sets: A, B", turning a
 * blind regex into an immediate confirmation. It reuses the SAME
 * `compileNameMatcher` the engine uses, so the preview and the executed column
 * can never disagree.
 */

import { compileNameMatcher, isNamePattern } from '@ifc-lite/lists';

/** Shape of a slash literal `/body/` or `/body/flags` (valid OR malformed body). */
const LOOKS_LIKE_PATTERN = /^\/.+\/[a-z]*$/;

export interface SetPatternPreview {
  /** The field is a valid `/regex/` slash literal. */
  isPattern: boolean;
  /** The field looks like a slash literal but the regex does not compile. The
   *  engine then falls back to an exact-literal match, which almost never hits a
   *  real set, so the builder disables Add and warns. */
  isInvalid: boolean;
  /** Discovered set names the pattern matches (only populated when `isPattern`). */
  matches: string[];
}

/**
 * Classify the set-name field and, for a valid pattern, list the discovered set
 * names it matches. A plain (non-slash) name is neither a pattern nor invalid:
 * it stays an exact match and needs no preview.
 */
export function previewSetPattern(setField: string, setNames: Iterable<string>): SetPatternPreview {
  const set = setField.trim();
  if (set.length === 0) return { isPattern: false, isInvalid: false, matches: [] };

  if (!isNamePattern(set)) {
    // A slash-shaped string that failed to compile is flagged so the UI can
    // warn; a plain name is just an exact match.
    return { isPattern: false, isInvalid: LOOKS_LIKE_PATTERN.test(set), matches: [] };
  }

  const match = compileNameMatcher(set);
  const matches: string[] = [];
  for (const name of setNames) {
    if (match(name)) matches.push(name);
  }
  return { isPattern: true, isInvalid: false, matches };
}

/**
 * Human hint for a pattern's matches: `matches 2 sets: A, B`, capping the named
 * sets at `cap` then appending ` +N more`. Zero matches reads
 * `matches 0 sets in loaded models` (the pattern is valid, just unmatched).
 */
export function formatMatchHint(matches: string[], cap = 3): string {
  const n = matches.length;
  if (n === 0) return 'matches 0 sets in loaded models';
  const shown = matches.slice(0, cap).join(', ');
  const extra = n - Math.min(cap, n);
  const suffix = extra > 0 ? ` +${extra} more` : '';
  return `matches ${n} ${n === 1 ? 'set' : 'sets'}: ${shown}${suffix}`;
}
