/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { CLASH_COLOR_A, CLASH_COLOR_B, type RGBA } from './clash-colors';

export function setClashColor(colors: Map<number, RGBA>, rendererId: number, color: RGBA): void {
  if (color === CLASH_COLOR_A || !colors.has(rendererId)) colors.set(rendererId, color);
}

/** Find every loaded source or live-overlay occurrence BCF will address by IFC GlobalId. */
export function loadedGuidOccurrences(
  state: ReturnType<typeof useViewerStore.getState>,
  guids: Iterable<string>,
): Map<string, Set<number>> {
  const occurrences = new Map([...guids].map(guid => [guid, new Set<number>()]));
  for (const [modelId, model] of state.models) {
    const entities = model.ifcDataStore?.entities;
    if (entities?.getExpressIdByGlobalId) {
      for (const [guid, rendererIds] of occurrences) {
        const expressId = entities.getExpressIdByGlobalId(guid);
        if (expressId >= 0) {
          rendererIds.add(toGlobalIdFromModels(state.models, modelId, expressId));
        }
      }
    }
    for (const entity of state.mutationViews.get(modelId)?.getNewEntities() ?? []) {
      const guid = entity.attributes[0];
      if (typeof guid !== 'string') continue;
      occurrences.get(guid)?.add(toGlobalIdFromModels(state.models, modelId, entity.expressId));
    }
  }
  return occurrences;
}

/** Reconcile BCF GUID colors with renderer-ID collisions, with deterministic A precedence. */
export function reconcileGuidOccurrenceColors(
  colorByGuid: Map<string, RGBA>,
  occurrences: ReadonlyMap<string, ReadonlySet<number>>,
  colors: Map<number, RGBA>,
): void {
  let promoted = true;
  while (promoted) {
    promoted = false;
    for (const [guid, rendererIds] of occurrences) {
      const color = colorByGuid.get(guid);
      if (!color) continue;
      for (const rendererId of rendererIds) setClashColor(colors, rendererId, color);
    }
    for (const [guid, rendererIds] of occurrences) {
      if (colorByGuid.get(guid) !== CLASH_COLOR_B) continue;
      if ([...rendererIds].some(rendererId => colors.get(rendererId) === CLASH_COLOR_A)) {
        colorByGuid.set(guid, CLASH_COLOR_A);
        promoted = true;
      }
    }
  }
}
