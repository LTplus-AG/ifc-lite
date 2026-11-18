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
 * The answer depends only on which GlobalId each live entity carries now,
 * never on which entities happen to have an overlay entry: an edit to an
 * entity's Name (or any attribute other than its GlobalId) leaves that entity
 * exactly where an untouched row would be. Precedence, highest first:
 *
 *   1. An entity CREATED this session, or one whose GlobalId was EDITED to G
 *      (its effective GlobalId differs from the parsed one). Session edits
 *      win over the parsed file, as in the viewer's `modelGlobalIdOwner`.
 *      Several such claimants: the lowest expressId.
 *   2. The row the entity table indexes for G (the LAST row in table order
 *      carrying G), unless it was deleted or its GlobalId edited away.
 *   3. Otherwise another live source row still carrying G (`liveDuplicateOf`,
 *      last in table order, same rule as the index).
 *
 * Duplicated GlobalIds in an unedited file (common in real exports) therefore
 * resolve to the indexed (last) row. Before this resolver, the playground
 * returned the FIRST in effective iteration order (type buckets in file
 * order); answering that exactly would need a whole-table duplicate scan on
 * every lookup.
 *
 * Cost: O(K) entity reads to build, where K is the overlay's own candidate
 * set (entities with a named, positional or type override, plus entities
 * created this session), then O(1) per lookup through the entity table's
 * GlobalId index. It never walks the model: the main viewer runs this on the
 * user's live session, synchronously, on models of hundreds of MB. The one
 * exception is `liveDuplicateOf`, an integer-column scan on the rare path
 * where the indexed row was deleted or edited away.
 */
export function createGlobalIdResolver(model: ReadyModel): (globalId: string) => number | undefined {
  let overlay: { claimed: Map<string, number>; movedAway: Set<number> } | null = null;
  const view = () => model.mutationView();
  const build = () => {
    const mutationView = view();
    /** GlobalId → lowest expressId created with it or edited to it (rule 1). */
    const claimed = new Map<string, number>();
    /** Source rows whose GlobalId was edited, so their parsed GlobalId is no longer theirs. */
    const movedAway = new Set<number>();
    if (mutationView) {
      const candidates = new Set<number>(mutationView.getAttributeOverrideEntityIds());
      for (const { expressId } of mutationView.readNewEntityKinds()) candidates.add(expressId);
      for (const expressId of candidates) {
        if (mutationView.isDeleted(expressId)) continue;
        const effective = model.bim.entity({ modelId: model.id, expressId })?.globalId ?? '';
        const created = mutationView.hasNewEntity(expressId);
        const parsed = created ? '' : model.store.entities.getGlobalId(expressId);
        if (!created && effective === parsed) continue; // unchanged GlobalId: an ordinary row
        if (!created) movedAway.add(expressId);
        if (!effective) continue;
        const holder = claimed.get(effective);
        if (holder === undefined || expressId < holder) claimed.set(effective, expressId);
      }
    }
    return { claimed, movedAway };
  };
  const isLiveSource = (id: number) => !overlay!.movedAway.has(id) && !view()?.isDeleted(id);
  return (globalId) => {
    overlay ??= build();
    const claimant = overlay.claimed.get(globalId);
    if (claimant !== undefined) return claimant;
    const sourceId = model.store.entities.getExpressIdByGlobalId(globalId);
    if (!(sourceId > 0)) return undefined;
    if (isLiveSource(sourceId)) return sourceId;
    return liveDuplicateOf(model, sourceId, isLiveSource);
  };
}
