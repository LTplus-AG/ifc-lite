/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentMatchKind, DiffChangeKind, DiffState } from '@ifc-lite/diff';
import { isRetiringMatch } from './contentMatches';

/** Post-run filters (#8017), shared by the list, bulk selection and overlay. */
export interface CompareResultFilter {
  category: Exclude<DiffState, 'unchanged'> | 'matched' | null;
  kind: DiffChangeKind | null;
}
export const ALL_COMPARE_RESULTS: CompareResultFilter = { category: null, kind: null };

export function matchesCompareEntry(
  entry: { state: DiffState; changeKinds: readonly string[] },
  filter: CompareResultFilter,
): boolean {
  return (!filter.category || entry.state === filter.category)
    && (!filter.kind || (entry.state === 'modified' && entry.changeKinds.includes(filter.kind)));
}

export function matchesCompareMatch(
  match: { kind: ContentMatchKind },
  filter: CompareResultFilter,
): boolean {
  return !filter.kind && (!filter.category || (filter.category === 'matched' && isRetiringMatch(match.kind)));
}
