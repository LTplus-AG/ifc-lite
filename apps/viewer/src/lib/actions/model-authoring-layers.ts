/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { liveEntityConforms } from '@ifc-lite/create';
import { entityName, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { writeMaterialLayersInDraft, type ApplyLayersSpec } from '@/lib/authoring/material-layers';
import type { ModelEditTarget, ModellingMethods } from '@/store/slices/mutation-modelling-records';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { NativeReadState } from './model-authoring-read-target';
import { nativeLayerEvidence, type NativeLayerExpected } from './native-layer-evidence';
import { layerExpectedInMetres } from './model-authoring-layer-params';
import { sameNativeDimensions } from './model-authoring-size';
import type { AuthoringOp, AuthoringUnits } from './model-authoring';
import { uniqueSplitGuid } from './model-authoring-split';
import { readAttributes } from '@/lib/placement-edit';

type Operation = Extract<AuthoringOp, { op: 'material.layers' }>;
export class LayerRefusal extends Error {
  constructor(readonly status: 'conflict' | 'unsupported', message: string) { super(message); }
}
function sameExpected(a: NativeLayerExpected, b: NativeLayerExpected): boolean {
  return a.layerSetId === b.layerSetId && a.via === b.via && a.typeStatus === b.typeStatus
    && JSON.stringify(a.assignments) === JSON.stringify(b.assignments)
    && (a.typeLayers === null && b.typeLayers === null || !!a.typeLayers && !!b.typeLayers
      && JSON.stringify(a.typeLayers.assignments) === JSON.stringify(b.typeLayers.assignments)
      && a.typeLayers.layerSetId === b.typeLayers.layerSetId
      && a.typeLayers.MaterialLayers.length === b.typeLayers.MaterialLayers.length
      && a.typeLayers.MaterialLayers.every((layer, i) => Math.abs(layer.LayerThickness - b.typeLayers!.MaterialLayers[i].LayerThickness) <= 1e-9
        && JSON.stringify(layer.Material) === JSON.stringify(b.typeLayers!.MaterialLayers[i].Material)))
    && JSON.stringify(a.type) === JSON.stringify(b.type) && JSON.stringify(a.peers) === JSON.stringify(b.peers)
    && (a.wall === null && b.wall === null || !!a.wall && !!b.wall && sameNativeDimensions(a.wall, b.wall))
    && a.MaterialLayers.length === b.MaterialLayers.length && a.MaterialLayers.every((layer, i) => {
      const other = b.MaterialLayers[i];
      return Math.abs(layer.LayerThickness - other.LayerThickness) <= 1e-9 && JSON.stringify(layer.Material) === JSON.stringify(other.Material);
    });
}

/** Compare complete transported facts before using the native inspector's constructor (#7275). */
export function resolveReviewedLayers(state: NativeReadState, target: ModelEditTarget, expressId: number,
  op: Operation, units: AuthoringUnits): ApplyLayersSpec {
  const evidence = nativeLayerEvidence(state, target, expressId);
  if (evidence.status !== 'available' || !evidence.expected || !evidence.kind) throw new LayerRefusal('unsupported', 'Complete current native material-layer evidence is unavailable; inspect and recapture the element');
  if (!sameExpected(evidence.expected, layerExpectedInMetres(op.expected, units))) throw new LayerRefusal('conflict', 'The current native layers, materials, type or peer population differs from the expected snapshot');
  if (op.scope === 'type' && (evidence.typeScopeStatus !== 'available' || evidence.expected.typeStatus !== 'typed'
    || evidence.expected.peers === null || evidence.expected.typeLayers === null)) throw new LayerRefusal('unsupported', 'Type scope requires a known current type and the complete current peer population');
  const typeId = typeOf(target, expressId);
  if (op.scope === 'type' && (!op.expected.type || !uniqueSplitGuid(target.dataStore, target.editor, op.expected.type.GlobalId))) {
    throw new LayerRefusal('conflict', 'The expected native type identity is not unique in its source');
  }
  const layers = op.MaterialLayers.map(layer => {
    const material = layer.Material;
    if (material && !('create' in material) && (material.modelId !== target.modelId
      || !liveEntityConforms(target.dataStore, material.expressId, 'IfcMaterial', target.view)
      || entityName(target, material.expressId) !== material.Name)) throw new LayerRefusal('conflict', 'The selected native layer material is missing, renamed or belongs to another source');
    return { thickness: units === 'mm' ? layer.LayerThickness / 1000 : layer.LayerThickness,
      material: material === null ? null : 'create' in material ? { name: material.create.Name } : { id: material.expressId } };
  });
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  if (total > 5) throw new LayerRefusal('unsupported', 'The proposed material-layer total exceeds 5 m; check the declared units');
  return { kind: evidence.kind, target: op.scope, elementId: expressId, typeId, layers };
}

export function writeReviewedLayers(target: ModelEditTarget, draft: StoreEditor, methods: ModellingMethods,
  spec: ApplyLayersSpec, op: Operation, units: AuthoringUnits, state: NativeReadState): readonly number[] {
  const occurrence = spec.elementId;
  if (occurrence === undefined || !uniqueSplitGuid(target.dataStore, draft, op.target.globalId)
    || readAttributes(target.dataStore, target.view, draft, occurrence)?.[0] !== op.target.globalId
    || entityName(target, occurrence) !== op.target.name) throw new Error('The native layer target identity changed or is ambiguous');
  if (op.scope === 'type') {
    const typeId = typeOf(target, occurrence);
    if (typeId === null || typeId !== spec.typeId || !op.expected.type
      || !uniqueSplitGuid(target.dataStore, draft, op.expected.type.GlobalId)
      || readAttributes(target.dataStore, target.view, draft, typeId)?.[0] !== op.expected.type.GlobalId
      || entityName(target, typeId) !== op.expected.type.Name) throw new Error('The native layer type binding changed or is ambiguous');
  }
  for (const layer of op.MaterialLayers) {
    const material = layer.Material;
    if (material && !('create' in material) && (!liveEntityConforms(target.dataStore, material.expressId, 'IfcMaterial', target.view)
      || entityName(target, material.expressId) !== material.Name)) throw new Error('The native layer material changed before writing');
  }
  const current = resolveReviewedLayers(state, target, occurrence, op, units);
  return writeMaterialLayersInDraft(target, draft, methods, current).remesh;
}
