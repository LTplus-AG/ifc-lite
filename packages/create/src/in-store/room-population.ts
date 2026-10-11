/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { liveEntityConforms } from './resolve-relations.js';
import { effectiveStoreyId } from './edit/effective-storey.js';

/** Complete live IfcSpace ownership, including spaces without readable geometry (#7324). */
export function effectiveRoomIdsByStorey(
  store: IfcDataStore, view: MutablePropertyView | null | undefined, storeyIds: readonly number[],
): Map<number, number[]> {
  const populations = new Map(storeyIds.map(id => [id, [] as number[]]));
  let scanned = 0;
  for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
    if (++scanned > 200000) throw new Error('The loaded model is too large for a complete reviewed Room population');
    if (!liveEntityConforms(store, expressId, 'IfcSpace', view)) continue;
    const owner = effectiveStoreyId(store, view, expressId);
    const rows = owner === undefined ? undefined : populations.get(owner);
    if (!rows) continue;
    if (rows.length >= 128) throw new Error('More than 128 rooms belong to this storey; a complete review is unavailable');
    rows.push(expressId);
  }
  for (const rows of populations.values()) rows.sort((a, b) => a - b);
  return populations;
}
