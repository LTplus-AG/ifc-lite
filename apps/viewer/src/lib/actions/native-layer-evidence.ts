/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { liveEntityConforms, readRelatedLists } from '@ifc-lite/create';
import { effectiveMetadataRecord, materialAssignmentsAvailable } from '@ifc-lite/parser';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { entityName, layerSetOf, occurrencesOf, typeOf } from '@/lib/commands/modeling/authored-kinds';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable, type NativeReadState } from './model-authoring-read-target';
import { uniqueSplitGuid } from './model-authoring-split';
import { nativeTypeEvidence } from './native-type-evidence';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import type { ExpectedSize } from './model-authoring-size-params';
import type { ExistingElement } from './model-authoring';

export const NATIVE_LAYER_LIMIT = 32;
export const NATIVE_LAYER_PEER_LIMIT = 200;
export type LayerKind = 'wall' | 'slab' | 'roof' | 'plate';
export interface NativeMaterialRef { modelId: string; expressId: number; Name: string }
export interface NativeExpectedLayer { LayerThickness: number; Material: NativeMaterialRef | null }
export interface NativeLayerPopulation {
  assignments: Array<{ expressId: number; ifcClass: string }>;
  layerSetId: number | null;
  MaterialLayers: NativeExpectedLayer[];
}
export interface NativeLayerExpected {
  typeLayers: NativeLayerPopulation | null;
  assignments: Array<{ expressId: number; ifcClass: string }>;
  layerSetId: number | null;
  via: 'element' | 'type' | 'none';
  MaterialLayers: NativeExpectedLayer[];
  type: { GlobalId: string; Name: string } | null;
  typeStatus: 'typed' | 'untyped' | 'unavailable';
  peers: ExistingElement[] | null;
  wall: ExpectedSize | null;
}
export interface NativeLayerEvidence {
  units: 'm';
  status: 'available' | 'unavailable' | 'unsupported' | 'truncated';
  kind: LayerKind | null;
  assignmentCount: number | null;
  layerCount: number | null;
  peerCount: number | null;
  typeAssignmentCount: number | null;
  typeLayerCount: number | null;
  typeScopeStatus: 'available' | 'unavailable' | 'truncated';
  expected: NativeLayerExpected | null;
}

const kinds = { wall: 'IfcWall', slab: 'IfcSlab', roof: 'IfcRoof', plate: 'IfcPlate' } as const;
const caches = new WeakMap<ModelEditTarget, Map<number, NativeLayerEvidence>>();

/** Complete current native layer facts; bounds keep counts and revoke incomplete expected snapshots (#7275). */
export function nativeLayerEvidence(state: NativeReadState, target: ModelEditTarget | null, expressId: number): NativeLayerEvidence {
  const unknown: NativeLayerEvidence = { units: 'm', status: 'unavailable', kind: null,
    assignmentCount: null, layerCount: null, peerCount: null, typeAssignmentCount: null, typeLayerCount: null, typeScopeStatus: 'unavailable', expected: null };
  if (!target || target.view.isDeleted(expressId)) return unknown;
  let cache = caches.get(target);
  if (!cache) { cache = new Map(); caches.set(target, cache); }
  const cached = cache.get(expressId);
  if (cached) return cached;
  const read = (): NativeLayerEvidence => {
    const kind = (Object.keys(kinds) as LayerKind[]).find(key => liveEntityConforms(target.dataStore, expressId, kinds[key], target.view));
    if (!kind) return { ...unknown, status: 'unsupported' };
    const unavailable = { ...unknown, kind };
    if (!nativeLengthUnitAvailable(target) || !materialAssignmentsAvailable(target.dataStore, expressId, target.view)) return unavailable;
    if (!target.dataStore.source.length && !target.view.getNewEntity(expressId)) return unavailable;
    const typeId = typeOf(target, expressId);
    const binding = nativeTypeEvidence(state, target, expressId);
    const relations = readRelatedLists(target.dataStore, 'IfcRelAssociatesMaterial', target.view, { includeMalformedRelatingTargets: true });
    const own = relations.filter(row => row.relatedIds.includes(expressId));
    const inherited = typeId === null ? [] : relations.filter(row => row.relatedIds.includes(typeId));
    const current = own.length ? own : inherited;
    const population = readPopulation(target, expressId, current);
    const typePopulation = typeId === null ? null : materialAssignmentsAvailable(target.dataStore, typeId, target.view)
      ? readPopulation(target, typeId, inherited) : { assignmentCount: null, layerCount: null, truncated: false, value: null };
    const peers = typeId === null ? [] : [...new Set(occurrencesOf(target, typeId))].sort((a, b) => a - b);
    const counts = { assignmentCount: population.assignmentCount, layerCount: population.layerCount, peerCount: peers.length,
      typeAssignmentCount: typePopulation?.assignmentCount ?? (binding.status === 'untyped' ? 0 : null),
      typeLayerCount: typePopulation?.layerCount ?? (binding.status === 'untyped' ? 0 : null) };
    if (!population.value) return { ...unavailable, ...counts, status: population.truncated ? 'truncated' : 'unavailable' };
    let typeScopeStatus: NativeLayerEvidence['typeScopeStatus'] = binding.status === 'unavailable' || typePopulation && !typePopulation.value ? 'unavailable' : 'available';
    let peerRefs: ExistingElement[] | null = [];
    if (typePopulation?.truncated) typeScopeStatus = 'truncated';
    if (peers.length > NATIVE_LAYER_PEER_LIMIT) { typeScopeStatus = 'truncated'; peerRefs = null; }
    else for (const id of peers) {
      const record = effectiveMetadataRecord(target.dataStore, id, target.view), name = entityName(target, id);
      const nativeGuid = record?.attributes[0];
      const globalId = typeof nativeGuid === 'string' ? nativeGuid : null;
      if (!globalId || !isValidIfcGuid(globalId) || !uniqueSplitGuid(target.dataStore, target.editor, globalId) || !record || name.length > 200) { typeScopeStatus = 'unavailable'; peerRefs = null; break; }
      peerRefs!.push({ globalId, modelId: target.modelId, ifcClass: record.type, name });
    }
    return { units: 'm', status: 'available', kind, ...counts, typeScopeStatus, expected: {
      ...population.value, typeLayers: typePopulation?.value ?? null, via: own.length ? 'element' : inherited.length ? 'type' : 'none',
      type: binding.expected, typeStatus: binding.status, peers: peerRefs,
      wall: kind === 'wall' ? readAuthoringSizeFromTarget(target, expressId, 'wall') : null,
    } };
  };
  const result = read();
  cache.set(expressId, result);
  return result;
}


/** One canonical population reader for occurrence and separately pinned type assignments. */
function readPopulation(target: ModelEditTarget, expressId: number,
  relations: ReturnType<typeof readRelatedLists>): { assignmentCount: number; layerCount: number | null; truncated: boolean; value: NativeLayerPopulation | null } {
  const assignmentCount = relations.length;
  const unavailable = { assignmentCount, layerCount: null, truncated: false, value: null };
  const assignments: NativeLayerPopulation['assignments'] = [];
  for (const row of relations) {
    if (row.relatingId === undefined) return unavailable;
    const record = effectiveMetadataRecord(target.dataStore, row.relatingId, target.view);
    if (!record || !record.attributes.length || !liveEntityConforms(target.dataStore, row.relatingId, 'IfcMaterialSelect', target.view)) return unavailable;
    assignments.push({ expressId: row.relatingId, ifcClass: record.type });
  }
  // The review contract describes one native definition; never choose among distinct associations.
  if (new Set(assignments.map(row => row.expressId)).size > 1) return unavailable;
  const set = layerSetOf(target, expressId);
  if (!set && assignments.some(row => ['IfcMaterialLayerSet', 'IfcMaterialLayerSetUsage'].includes(row.ifcClass))) return unavailable;
  const layerCount = set?.layers.length ?? 0;
  const counts = { ...unavailable, layerCount };
  if (layerCount > NATIVE_LAYER_LIMIT || assignmentCount > NATIVE_LAYER_LIMIT) return { ...counts, truncated: true };
  const MaterialLayers: NativeExpectedLayer[] = [];
  for (const layer of set?.layers ?? []) {
    if (!Number.isFinite(layer.thickness) || layer.thickness < 0) return counts;
    let Material: NativeMaterialRef | null = null;
    if (layer.materialId !== null) {
      if (!liveEntityConforms(target.dataStore, layer.materialId, 'IfcMaterial', target.view)) return counts;
      const record = effectiveMetadataRecord(target.dataStore, layer.materialId, target.view);
      if (!record || !record.attributes.length) return counts;
      const Name = entityName(target, layer.materialId);
      if (Name.length > 200) return counts;
      Material = { modelId: target.modelId, expressId: layer.materialId, Name };
    }
    MaterialLayers.push({ LayerThickness: layer.thickness, Material });
  }
  return { ...counts, value: { assignments, layerSetId: set?.layerSetId ?? null, MaterialLayers } };
}
