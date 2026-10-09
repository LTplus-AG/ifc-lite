/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { liveEntityConforms } from '@ifc-lite/create';
import { setWallSectionInStore } from '../../../../../packages/create/src/in-store/wall-section-edit.js';
import { AUTHORED_KINDS, occurrencesOf } from '@/lib/commands/modeling/authored-kinds';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import type { ModelEditTarget, ModellingMethods } from '@/store/slices/mutation-modelling-records';

export interface LayerInput {
  /** SI metres, > 0. */
  readonly thickness: number;
  readonly material: { readonly id: number } | { readonly name: string } | null;
}
export interface ApplyLayersSpec {
  readonly kind: AuthoredElementKind;
  readonly layers: readonly LayerInput[];
  readonly target: 'element' | 'type';
  /** Native inspector defaults may create an unassigned set; reviewed proposals require an existing element. */
  readonly elementId?: number;
  readonly typeId: number | null;
}

/** The inspector's native layer constructor and coupled wall edit, on the caller's unpublished atomic draft (#7275). */
export function writeMaterialLayersInDraft(target: ModelEditTarget, draft: StoreEditor, methods: ModellingMethods, spec: ApplyLayersSpec): {
  layerSetId: number; remesh: readonly number[];
} {
  const { kind, layers, elementId, typeId } = spec;
  const direction = AUTHORED_KINDS[kind].layers;
  if (!direction) throw new Error(`A ${kind} has no material layers`);
  if (layers.length === 0 || layers.some(layer => !Number.isFinite(layer.thickness) || layer.thickness <= 0)) {
    throw new Error('Material layers require positive finite thicknesses');
  }
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  if (!Number.isFinite(total)) throw new Error('The material layer total must be finite');
  const live = { ...target, view: draft.getMutationView(), editor: draft };
  const MaterialLayers = layers.map(layer => {
    let Material: number | undefined;
    if (layer.material !== null) {
      if ('id' in layer.material) {
        if (!liveEntityConforms(target.dataStore, layer.material.id, 'IfcMaterial', live.view)) throw new Error('The selected layer material is not a current IfcMaterial');
        Material = layer.material.id;
      } else Material = methods.addMaterial(target.modelId, { Name: layer.material.name }).expressId;
    }
    return { LayerThickness: layer.thickness, Material };
  });
  const layerSetId = methods.addMaterialLayerSet(target.modelId, { MaterialLayers }).expressId;
  if (spec.target === 'type') {
    if (typeId === null) throw new Error('This element has no type to layer');
    methods.assignMaterial(target.modelId, layerSetId, [typeId]);
    return { layerSetId, remesh: occurrencesOf(live, typeId) };
  }
  if (elementId === undefined) return { layerSetId, remesh: [] };
  const usage = methods.addMaterialLayerSetUsage(target.modelId, {
    ForLayerSet: layerSetId, LayerSetDirection: direction, OffsetFromReferenceLine: direction === 'AXIS2' ? -total / 2 : 0,
  });
  methods.assignMaterial(target.modelId, usage.expressId, [elementId]);
  if (kind !== 'wall') return { layerSetId, remesh: [elementId] };
  const section = setWallSectionInStore(live, elementId, { thickness: total });
  if (!section.ok) throw new Error(section.reason);
  return { layerSetId, remesh: section.remesh };
}
