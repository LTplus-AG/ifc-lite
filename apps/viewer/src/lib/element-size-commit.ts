/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one size write a Model workspace edit makes (charter #6232, C4): the
 * inspector's Dimensions rows and the push / pull handles both call
 * `commitElementSize`, inside their transaction.
 *
 * It is `setElementSize` plus the layers. A wall or slab with a material layer
 * set has a thickness that IS the layers' total, so a new thickness would leave
 * the set saying otherwise. The rule (decided, reversible): the ELEMENT gets
 * its own copy of the set whose LAST layer takes the change, as a new
 * IfcMaterialLayerSetUsage on the element; the set on the type, and every
 * other occurrence of it, is untouched. When the last layer would shrink to
 * nothing the whole set is scaled instead, keeping the layers' proportions.
 * Both are written in the same undo step as the size.
 */

import { AUTHORED_KINDS, authoredKindOf, layerSetOf, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import { recordModellingEdit, type ModellingStore } from '@/store/slices/mutation-modelling-records';
import { setElementSize, type ElementSizeOutcome, type ElementSizePatch } from '@/store/slices/mutation-element-size';

/** The smallest a layer may be squeezed to before the set is scaled instead (metres). */
const MIN_LAYER = 0.001;

/** `layers` adjusted so they total `thickness`: the last layer takes the change, else all scale. */
export function layersForThickness(layers: readonly number[], thickness: number): number[] {
  const total = layers.reduce((sum, v) => sum + v, 0);
  const last = layers[layers.length - 1] + (thickness - total);
  if (last >= MIN_LAYER) return [...layers.slice(0, -1), last];
  return layers.map((v) => (v * thickness) / total);
}

export function commitElementSize(store: ModellingStore, modelId: string, expressId: number, patch: ElementSizePatch): ElementSizeOutcome {
  const get = store.getState;
  const dataStore = get().models.get(modelId)?.ifcDataStore;
  const live: LiveModel | null = dataStore ? { dataStore, view: get().mutationViews.get(modelId) } : null;
  const thickness = patch.kind === 'wall' || patch.kind === 'slab' ? patch.thickness : undefined;
  const kind = live && thickness !== undefined ? authoredKindOf(live, expressId) : null;
  const direction = kind === null ? undefined : AUTHORED_KINDS[kind].layers;
  const before = live && direction ? layerSetOf(live, expressId) : null;
  const outcome = setElementSize(store, modelId, expressId, patch);
  if (!outcome.ok || !before || !direction || thickness === undefined || !outcome.remesh.includes(expressId)) return outcome;

  const total = before.layers.reduce((sum, l) => sum + l.thickness, 0);
  if (Math.abs(total - thickness) < 1e-6) return outcome;
  const next = layersForThickness(before.layers.map((l) => l.thickness), thickness);
  recordModellingEdit(store, modelId, (m) => {
    const setId = m.addMaterialLayerSet(modelId, {
      MaterialLayers: before.layers.map((layer, i) => ({ LayerThickness: next[i], Material: layer.materialId ?? undefined })),
    }).expressId;
    const usage = m.addMaterialLayerSetUsage(modelId, {
      ForLayerSet: setId, LayerSetDirection: direction, OffsetFromReferenceLine: direction === 'AXIS2' ? -thickness / 2 : 0,
    }).expressId;
    m.assignMaterial(modelId, usage, [expressId]);
  });
  return outcome;
}
