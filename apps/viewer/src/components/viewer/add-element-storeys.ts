/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Storeys available as authoring anchors in this model's live session. */
export function effectiveStoreyIds(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): number[] {
  return Array.from(
    iterateEffectiveEntityIds(store, view, ['IFCBUILDINGSTOREY']),
    ({ expressId }) => expressId,
  );
}

/** Prefer a live selection, otherwise use the first available storey. */
export function selectEffectiveStoreyId(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  preferred: number | null,
): number | null {
  const ids = effectiveStoreyIds(store, view);
  return preferred !== null && ids.includes(preferred) ? preferred : ids[0] ?? null;
}
