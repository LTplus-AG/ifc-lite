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
 * up from a slab's underside.
 */

import { liveEntityConforms } from '@ifc-lite/create';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from '@/store/slices/mutation-modelling-records';
import { AUTHORED_KINDS, authoredKindOf, readLayerSet } from './authored-kinds.js';

export function applyAuthoredDefaults(store: ModellingStore, modelId: string, ids: readonly number[]): void {
  const state = store.getState();
  const { typeIds, layerSetIds } = state.authoringDefaults;
  if (ids.length === 0 || (Object.keys(typeIds).length === 0 && Object.keys(layerSetIds).length === 0)) return;
  const target = modelEditTarget(state, modelId);
  if (!target) return;
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
    const layerSetId = info.layers ? live(layerSetIds[kind], 'IfcMaterialLayerSet') : null;
    const total = layerSetId === null ? 0 : (readLayerSet(model, layerSetId) ?? []).reduce((sum, layer) => sum + layer.thickness, 0);
    return { elements, typeId, layerSetId, direction: info.layers, offset: info.layers === 'AXIS2' ? -total / 2 : 0 };
  }).filter((step) => step.typeId !== null || step.layerSetId !== null);
  if (plan.length === 0) return;

  recordModellingEdit(store, modelId, (methods) => {
    for (const { elements, typeId, layerSetId, direction, offset } of plan) {
      if (typeId !== null) methods.assignType(modelId, typeId, elements);
      if (layerSetId === null) continue;
      for (const element of elements) {
        const usage = methods.addMaterialLayerSetUsage(modelId, { ForLayerSet: layerSetId, LayerSetDirection: direction, OffsetFromReferenceLine: offset });
        methods.assignMaterial(modelId, usage.expressId, [element]);
      }
    }
  });
}
