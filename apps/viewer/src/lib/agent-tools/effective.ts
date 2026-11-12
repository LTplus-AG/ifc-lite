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
 * GlobalId → expressId over the effective entity set, built once per call.
 *
 * Cost: O(K) entity reads to build, where K is the overlay's own candidate
 * set (entities with a named, positional or type override, plus entities
 * created this session), then O(1) per lookup through the entity table's
 * GlobalId index. It never walks the model: the main viewer runs this on the
 * user's live session, synchronously, on models of hundreds of MB.
 *
 * An overlay candidate answers by its effective GlobalId (so an edited or
 * created GlobalId resolves); a source id from the index is accepted only
 * when the overlay neither overrides nor deletes it (so an edited-away or
 * deleted GlobalId does not).
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
  return (globalId) => {
    overlay ??= build();
    const edited = overlay.byGlobalId.get(globalId);
    if (edited !== undefined) return edited;
    const sourceId = model.store.entities.getExpressIdByGlobalId(globalId);
    if (!(sourceId > 0) || overlay.overridden.has(sourceId) || view()?.isDeleted(sourceId)) return undefined;
    return sourceId;
  };
}
