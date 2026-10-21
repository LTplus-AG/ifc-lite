/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DiffEntry, EntityFingerprint } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints';

/** Follow the overlay's drawable-copy rule for selection as well (#8017). */
export function drawableEntryRef(entry: DiffEntry<CompareRef>): CompareRef | undefined {
  if (entry.state === 'deleted') return entry.base?.ref;
  return (entry.head?.ref.meshed !== false ? entry.head?.ref : entry.base?.ref) ?? entry.head?.ref;
}

export function drawableMatchRefs(match: {
  base: readonly EntityFingerprint<CompareRef>[];
  head: readonly EntityFingerprint<CompareRef>[];
}): CompareRef[] {
  return (match.head.some((item) => item.ref.meshed !== false) ? match.head : match.base).map((item) => item.ref);
}
