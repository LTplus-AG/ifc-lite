/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer-side vocabulary for the diff engine's content-matching pass (issue
 * #1891), shared by the overlay, the results list, the report export and
 * telemetry so all four agree on what a match means.
 *
 * The engine splits its {@link ContentMatch} kinds into two families, and the
 * difference is load-bearing for every consumer:
 *
 * - **retiring** (`renamed`, `moved`, `reshaped`) — the pass is confident, so
 *   it REMOVES the corresponding `added`/`deleted` entries from
 *   `ModelDiff.entries`. Anything reading only `entries` therefore loses these
 *   elements entirely: the overlay would strand both copies at full material
 *   colour, the list would show counts that dropped with no row explaining
 *   where they went, and the report would silently omit them.
 * - **review** (`duplicated`, `deduplicated`, `ambiguous`) — the pass refuses
 *   to guess, so it retires NOTHING. Those entities keep their `added` /
 *   `deleted` entries and their add/delete colours; the group is extra
 *   information to badge, never a reason to recolour or re-count.
 */

import type { ContentMatch, ContentMatchKind } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';

/** Kinds whose `added`/`deleted` entries the engine removed from the diff. */
const RETIRING_KINDS: ReadonlySet<ContentMatchKind> = new Set<ContentMatchKind>([
  'renamed',
  'moved',
  'reshaped',
]);

/** Did this match retire its entities' `added`/`deleted` entries? */
export function isRetiringMatch(kind: ContentMatchKind): boolean {
  return RETIRING_KINDS.has(kind);
}

/**
 * Did the content-matching pass run for this comparison? THE signal for that
 * question - the panel's Matched badge, its counts grid and `useCompare`'s
 * reconciliation gate all read it here rather than each spelling out their own
 * test.
 *
 * `undefined` (the flag was off, the pass never ran) and `[]` (it ran and found
 * nothing to pair) are DIFFERENT states and the UI shows them differently: a
 * Matched badge reading 0 says the pass looked and found nothing, a missing
 * badge says it was never asked. So this tests PRESENCE, never
 * `matches.length` - "are there matches" is a different question, and a
 * consumer wanting that one should count the rows it is about to render.
 */
export function contentMatchingRan(
  matches: readonly ContentMatch<CompareRef>[] | undefined,
): boolean {
  return matches !== undefined;
}

/** Short human labels, used verbatim in the panel and in the report's `change`
 *  column so a CSV reader and a UI reader see the same word. */
export const MATCH_KIND_LABEL: Record<ContentMatchKind, string> = {
  renamed: 'Renamed',
  moved: 'Moved',
  reshaped: 'Reshaped',
  duplicated: 'Duplicated',
  deduplicated: 'Deduplicated',
  ambiguous: 'Ambiguous',
};

/** One-line explanation per kind for the panel's row tooltips. */
export const MATCH_KIND_HINT: Record<ContentMatchKind, string> = {
  renamed: 'Same content in the same place under a new GlobalId (re-export).',
  moved: 'Same content, different geometry hash - it looks relocated.',
  reshaped: 'Same content, different geometry hash - its shape or tessellation changed.',
  duplicated: 'One element in A matches several in B - it looks copied.',
  deduplicated: 'Several elements in A match one in B - they look merged.',
  ambiguous: 'Several candidates on both sides; no principled pairing.',
};

export interface ContentMatchCounts extends Record<ContentMatchKind, number> {
  /** Element pairs the pass retired from `entries` (sum over retiring kinds,
   *  counted on the head side - a group renamed N:N retires N pairs). */
  matchedElements: number;
  /** Entities sitting in an unresolved group, still present in `entries`. */
  needsReviewElements: number;
  /** Total match records, retiring and review alike. */
  total: number;
}

/** Tally a comparison's content matches. `undefined` (the pass did not run)
 *  and `[]` (it ran and found nothing) both tally to all-zero — the caller
 *  distinguishes them by whether `contentMatches` exists, not by the counts. */
export function contentMatchCounts(
  matches: readonly ContentMatch<CompareRef>[] | undefined,
): ContentMatchCounts {
  const counts: ContentMatchCounts = {
    renamed: 0,
    moved: 0,
    reshaped: 0,
    duplicated: 0,
    deduplicated: 0,
    ambiguous: 0,
    matchedElements: 0,
    needsReviewElements: 0,
    total: 0,
  };
  for (const match of matches ?? []) {
    counts[match.kind] += 1;
    counts.total += 1;
    if (isRetiringMatch(match.kind)) {
      counts.matchedElements += match.head.length;
    } else {
      counts.needsReviewElements += match.base.length + match.head.length;
    }
  }
  return counts;
}
