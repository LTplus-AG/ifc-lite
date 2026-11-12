/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { ReadyModel } from './types.js';

/** Read this model's source and pending overlay as one entity set. */
export function effectiveEntities(model: ReadyModel, types?: readonly string[]) {
  return iterateEffectiveEntityIds(model.store, model.mutationView(), types);
}

export function effectiveTypeCounts(model: ReadyModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entity of effectiveEntities(model)) {
    const type = IFC_ENTITY_NAMES[entity.type] ?? entity.type;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

export function effectiveEntityCount(model: ReadyModel): number {
  let count = 0;
  for (const _entity of effectiveEntities(model)) count++;
  return count;
}

/**
 * Another source row carrying the same GlobalId as `rejectedId`, for when the
 * index's row for it has been deleted or had its GlobalId edited away.
 *
 * Cost: two passes over the entity table's integer columns (find the rejected
 * row's interned GlobalId string id, then every row with that id), no entity
 * reads and no string decoding. It runs only on this rejected-duplicate path,
 * never for an ordinary lookup. Of several live duplicates the last in table
 * order wins, matching the index (which keeps the last row per GlobalId).
 */
function liveDuplicateOf(model: ReadyModel, rejectedId: number, isLive: (id: number) => boolean): number | undefined {
  const { expressId: ids, globalId: globalIds, count } = model.store.entities;
  if (!ids || !globalIds) return undefined;
  let stringId = -1;
  for (let row = 0; row < count; row++) if (ids[row] === rejectedId) { stringId = globalIds[row]; break; }
  if (stringId <= 0) return undefined;
  for (let row = count - 1; row >= 0; row--) {
    if (globalIds[row] === stringId && ids[row] !== rejectedId && isLive(ids[row])) return ids[row];
  }
  return undefined;
}

/**
 * GlobalId → expressId over the effective entity set, built once per call.
 *
 * Cost: O(K) entity reads to build, where K is the overlay's own candidate
 * set (entities with a named, positional or type override, plus entities
 * created this session), then O(1) per lookup through the entity table's
 * GlobalId index. It never walks the model: the main viewer runs this on the
 * user's live session, synchronously, on models of hundreds of MB. The one
 * exception is `liveDuplicateOf`, an integer-column scan on the rare path
 * where the indexed row was deleted or edited away.
 *
 * An overlay candidate answers by its effective GlobalId (so an edited or
 * created GlobalId resolves); a source id from the index is accepted only
 * when the overlay neither overrides nor deletes it (so an edited-away or
 * deleted GlobalId does not), otherwise another live row with that GlobalId
 * answers.
 *
 * Duplicated GlobalIds in an unedited file (common in real exports) resolve
 * to the row the entity table indexes, which is the LAST one in table order.
 * Before this resolver, the playground returned the FIRST in effective
 * iteration order (type buckets in file order); answering that exactly would
 * need a whole-table duplicate scan on every lookup.
 */
export function createGlobalIdResolver(model: ReadyModel): (globalId: string) => number | undefined {
  let overlay: { byGlobalId: Map<string, number>; overridden: Set<number> } | null = null;
  const view = () => model.mutationView();
  const build = () => {
    const mutationView = view();
    const overridden = new Set<number>();
    const byGlobalId = new Map<string, number>();
    if (mutationView) {
      for (const id of mutationView.getAttributeOverrideEntityIds()) overridden.add(id);
      for (const { expressId } of mutationView.readNewEntityKinds()) overridden.add(expressId);
      for (const expressId of overridden) {
        const globalId = model.bim.entity({ modelId: model.id, expressId })?.globalId;
        if (globalId && !byGlobalId.has(globalId)) byGlobalId.set(globalId, expressId);
      }
    }
    return { byGlobalId, overridden };
  };
  const isLiveSource = (id: number) => !overlay!.overridden.has(id) && !view()?.isDeleted(id);
  return (globalId) => {
    overlay ??= build();
    const edited = overlay.byGlobalId.get(globalId);
    if (edited !== undefined) return edited;
    const sourceId = model.store.entities.getExpressIdByGlobalId(globalId);
    if (!(sourceId > 0)) return undefined;
    if (isLiveSource(sourceId)) return sourceId;
    return liveDuplicateOf(model, sourceId, isLiveSource);
  };
}
