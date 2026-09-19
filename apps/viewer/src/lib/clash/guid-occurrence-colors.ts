/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { collectAggregatedDescendants } from '@/utils/aggregation';
import { CLASH_COLOR_A, CLASH_COLOR_B, type RGBA } from './clash-colors';

export function setClashColor(colors: Map<number, RGBA>, rendererId: number, color: RGBA): void {
  if (color === CLASH_COLOR_A || !colors.has(rendererId)) colors.set(rendererId, color);
}

/** Find every loaded source or live-overlay occurrence BCF will address by IFC GlobalId. */
export function loadedGuidOccurrences(
  state: ReturnType<typeof useViewerStore.getState>,
  guids: Iterable<string>,
): { rendererIdsByGuid: Map<string, Set<number>>; modelIds: Set<string> } {
  const occurrences = new Map([...guids].map(guid => [guid, new Set<number>()]));
  const modelIds = new Set<string>();
  for (const [modelId, model] of state.models) {
    const entities = model.ifcDataStore?.entities;
    const view = state.mutationViews.get(modelId);
    const attributeMutations = view?.getAttributeMutationsByEntity() ?? new Map();
    const refsByGuid = new Map<string, Set<number>>();
    const addRef = (guid: string, expressId: number): void => {
      const refs = refsByGuid.get(guid) ?? new Set<number>();
      refs.add(expressId);
      refsByGuid.set(guid, refs);
    };
    if (entities?.getExpressIdByGlobalId) {
      for (const guid of occurrences.keys()) {
        const expressId = entities.getExpressIdByGlobalId(guid);
        const editedGuid = attributeMutations.get(expressId)?.get('GlobalId');
        if (expressId >= 0 && (editedGuid === undefined || editedGuid === guid)) addRef(guid, expressId);
      }
    }
    for (const [expressId, attributes] of attributeMutations) {
      const guid = attributes.get('GlobalId');
      if (guid && occurrences.has(guid)) addRef(guid, expressId);
    }
    for (const entity of view?.getNewEntities() ?? []) {
      const guid = attributeMutations.get(entity.expressId)?.get('GlobalId') ?? entity.attributes[0];
      if (typeof guid !== 'string') continue;
      if (occurrences.has(guid)) addRef(guid, entity.expressId);
    }
    const relationships = model.ifcDataStore?.relationships;
    for (const [guid, expressIds] of refsByGuid) {
      modelIds.add(modelId);
      const rendererIds = occurrences.get(guid)!;
      for (const expressId of expressIds) {
        rendererIds.add(toGlobalIdFromModels(state.models, modelId, expressId));
        if (!relationships) continue;
        for (const descendantId of collectAggregatedDescendants(relationships, expressId)) {
          rendererIds.add(toGlobalIdFromModels(state.models, modelId, descendantId));
        }
      }
    }
  }
  for (const rendererIds of occurrences.values()) {
    const expanded = resolvePresentationIds(state.cameraCallbacks.resolveHighlightIds, [...rendererIds]);
    rendererIds.clear();
    for (const rendererId of expanded) rendererIds.add(rendererId);
  }
  return { rendererIdsByGuid: occurrences, modelIds };
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
