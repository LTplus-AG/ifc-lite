/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { LoadedPlaygroundModel } from './playground-dispatcher.js';

/** Read this model's source and pending overlay as one entity set. */
export function effectiveEntities(model: LoadedPlaygroundModel, types?: readonly string[]) {
  return iterateEffectiveEntityIds(model.store, model.backend.getMutationView(), types);
}

export function effectiveTypeCounts(model: LoadedPlaygroundModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entity of effectiveEntities(model)) {
    const type = IFC_ENTITY_NAMES[entity.type] ?? entity.type;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

export function effectiveEntityCount(model: LoadedPlaygroundModel): number {
  let count = 0;
  for (const _entity of effectiveEntities(model)) count++;
  return count;
}

export function effectiveGlobalIdLookup(model: LoadedPlaygroundModel, globalId: string): number | undefined {
  for (const { expressId } of effectiveEntities(model)) {
    if (model.bim.entity({ modelId: model.id, expressId })?.globalId === globalId) return expressId;
  }
  return undefined;
}
