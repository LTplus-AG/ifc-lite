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

import { setElementSizeInStore } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AUTHORED_KINDS, authoredKindOf, layerSetOf, type LiveLayerSet, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import { recordModellingEdit, type ModellingMethods, type ModellingStore } from '@/store/slices/mutation-modelling-records';
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
  const layers = layerResizePlan(live, expressId, patch);
  const outcome = setElementSize(store, modelId, expressId, patch);
  if (needsLayerResize(layers, outcome, expressId)) recordModellingEdit(store, modelId, (methods) => writeLayerResize(methods, modelId, expressId, layers!));
  return outcome;
}

interface LayerResize { before: LiveLayerSet; direction: 'AXIS1' | 'AXIS2' | 'AXIS3'; thickness: number }

function layerResizePlan(live: LiveModel | null, expressId: number, patch: ElementSizePatch): LayerResize | null {
  const thickness = patch.kind === 'wall' || patch.kind === 'slab' ? patch.thickness : undefined;
  const kind = live && thickness !== undefined ? authoredKindOf(live, expressId) : null;
  const direction = kind === null ? undefined : AUTHORED_KINDS[kind].layers;
  const before = live && direction ? layerSetOf(live, expressId) : null;
  return before && direction && thickness !== undefined ? { before, direction, thickness } : null;
}

function needsLayerResize(layers: LayerResize | null, outcome: ElementSizeOutcome, expressId: number): boolean {
  return outcome.ok && layers !== null && outcome.remesh.includes(expressId)
    && Math.abs(layers.before.layers.reduce((sum, layer) => sum + layer.thickness, 0) - layers.thickness) >= 1e-6;
}

function writeLayerResize(methods: ModellingMethods, modelId: string, expressId: number, { before, direction, thickness }: LayerResize): void {
  const next = layersForThickness(before.layers.map((l) => l.thickness), thickness);
  const setId = methods.addMaterialLayerSet(modelId, {
      MaterialLayers: before.layers.map((layer, i) => ({ LayerThickness: next[i], Material: layer.materialId ?? undefined })),
    }).expressId;
  const usage = methods.addMaterialLayerSetUsage(modelId, {
      ForLayerSet: setId, LayerSetDirection: direction, OffsetFromReferenceLine: direction === 'AXIS2' ? -thickness / 2 : 0,
    }).expressId;
  methods.assignMaterial(modelId, usage, [expressId]);
}

/** #7229: the same native size/layer write on an unpublished atomic draft. */
export function draftElementSize(dataStore: IfcDataStore, draft: StoreEditor, methods: ModellingMethods, modelId: string, expressId: number, patch: ElementSizePatch): ElementSizeOutcome {
  const view = draft.getMutationView();
  const layers = layerResizePlan({ dataStore, view }, expressId, patch);
  const outcome = setElementSizeInStore({ dataStore, view, editor: draft }, expressId, patch);
  if (needsLayerResize(layers, outcome, expressId)) writeLayerResize(methods, modelId, expressId, layers!);
  return outcome;
}
