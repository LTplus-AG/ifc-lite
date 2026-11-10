/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-kind type and layer-set defaults, applied to what a command just
 * built (charter #6232, M2.5). `runTransaction` calls this after every
 * commit, inside the same undo step, so no command wires it itself: a new
 * wall picks up the Model inspector's chosen IfcWallType and layer set the
 * moment it exists, and one Ctrl+Z removes wall and assignment together.
 *
 * A pick from another model, or one that no longer exists (its creation was
 * undone), is skipped. A layer set is attached through an
 * IfcMaterialLayerSetUsage per element: across a wall, centred on its axis;
 * along a slab's depth from its reference plane.
 *
 * With a type picked too, the element is drawn with the TYPE's build-up: its
 * usage places the type's layer set, so a later change to the type's layers
 * reaches it (`typeLayerScopeInStore`). A type with no layers yet takes the
 * layer default as its own, when every element it already types was drawn
 * with that same default (so nothing else changes size).
 */

import { liveEntityConforms, typeLayerScopeInStore, typeLayerSetInStore } from '@ifc-lite/create';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from '@/store/slices/mutation-modelling-records';
import { layerSenseOf, takeLayerFollow, type LayerFollow } from '@/lib/authoring/material-layers';
import { AUTHORED_KINDS, authoredKindOf, readLayerSet } from './authored-kinds.js';

/**
 * Apply the defaults to `ids`. A layered type or layer set sizes what it types
 * through the backend, which can re-trim joined walls and refit generated
 * rooms: the elements that changed come back for the caller's re-mesh, with
 * any element that could not follow, to report once the edit commits. Null
 * when nothing applied.
 */
export function applyAuthoredDefaults(store: ModellingStore, modelId: string, ids: readonly number[]): { remesh: number[]; follow: LayerFollow } | null {
  const state = store.getState();
  const { typeIds, layerSetIds } = state.authoringDefaults;
  if (ids.length === 0 || (Object.keys(typeIds).length === 0 && Object.keys(layerSetIds).length === 0)) return null;
  const target = modelEditTarget(state, modelId);
  if (!target) return null;
  const model = { dataStore: target.dataStore, view: target.view };

  const byKind = new Map<AuthoredElementKind, number[]>();
  for (const id of ids) {
    const kind = authoredKindOf(model, id);
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
  }
  const live = (pick: { modelId: string; expressId: number } | undefined, ifcClass: string) =>
    pick && pick.modelId === modelId && liveEntityConforms(model.dataStore, pick.expressId, ifcClass, model.view) ? pick.expressId : null;

  const plan = [...byKind].map(([kind, elements]) => {
    const info = AUTHORED_KINDS[kind];
    const typeId = live(typeIds[kind], info.type);
    const defaultSet = info.layers ? live(layerSetIds[kind], 'IfcMaterialLayerSet') : null;
    let layerSetId = defaultSet, adopt = false;
    if (typeId !== null && info.layers) {
      const scope = typeLayerScopeInStore(model, typeId);
      if (scope.layerSetId !== null) layerSetId = scope.layerSetId;
      else adopt = defaultSet !== null && scope.inheriting.length === 0 && scope.differing.every((id) => typeLayerSetInStore(model, id) === defaultSet);
    }
    const total = layerSetId === null ? 0 : (readLayerSet(model, layerSetId) ?? []).reduce((sum, layer) => sum + layer.thickness, 0);
    return { elements, typeId, layerSetId, adopt, direction: info.layers, offset: info.layers === 'AXIS2' ? -total / 2 : 0 };
  }).filter((step) => step.typeId !== null || step.layerSetId !== null);
  if (plan.length === 0) return null;

  return recordModellingEdit(store, modelId, (methods, draft) => {
    for (const { elements, typeId, layerSetId, adopt, direction, offset } of plan) {
      if (typeId !== null) methods.assignType(modelId, typeId, elements);
      if (layerSetId === null) continue;
      if (adopt && typeId !== null) methods.assignMaterial(modelId, layerSetId, [typeId]);
      for (const element of elements) {
        const usage = methods.addMaterialLayerSetUsage(modelId, {
          ForLayerSet: layerSetId, LayerSetDirection: direction, OffsetFromReferenceLine: offset,
          ...(direction === 'AXIS3' ? { DirectionSense: layerSenseOf(target, element) } : {}),
        });
        methods.assignMaterial(modelId, usage.expressId, [element]);
      }
    }
    return takeLayerFollow(draft, []);
  });
}
