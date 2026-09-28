/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveSpatialMembers } from '@/lib/effective-spatial-members';
import { effectiveStoreyId } from '@/lib/effective-storey';

/** Direct members of the selected element's effective storey. The parser's
 * byStorey list is direct containment, while elementToStorey can also locate
 * an aggregated part or spatial child. Preserve that distinction (#5249). */
export function sameEffectiveStoreyIds(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  selectedId: number,
): number[] {
  const storeyId = effectiveStoreyId(store, view, selectedId);
  if (storeyId === undefined) return [];

  return effectiveStoreyMemberIds(store, view, storeyId);
}

/** Direct members of a storey after relationship edits, tombstones and creates. */
export function effectiveStoreyMemberIds(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  storeyId: number,
): number[] {
  return effectiveSpatialMembers(store, view, storeyId);
}
