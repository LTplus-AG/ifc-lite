/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isEntityVisible } from '@ifc-lite/renderer';
import type { MeshData, PointCloudAsset } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { collectIfcBuildingStoreyElementsWithIfcSpace } from '@/store/basketVisibleSet';
import type { AggregationRelationships } from '@/utils/aggregation';

/** The renderer's intersection of selected storeys, class filter and isolation. */
export type VisibilityIsolationState = Pick<ViewerState,
  'models' | 'ifcDataStore' | 'selectedStoreys' | 'classFilter' | 'isolatedEntities' | 'resolveGlobalIdFromModels'>;

export function computeVisibilityIsolation(state: VisibilityIsolationState): Set<number> | null {
  const { models, ifcDataStore, selectedStoreys, classFilter, isolatedEntities } = state;
  let storeyIsolation: Set<number> | null = null;
  if (selectedStoreys.size > 0) {
    const ids = new Set<number>();
    for (const [modelId, model] of models) {
      const hierarchy = model.ifcDataStore?.spatialHierarchy;
      if (!hierarchy) continue;
      const relationships = model.ifcDataStore?.relationships as AggregationRelationships | undefined;
      for (const storeyId of selectedStoreys) {
        // Storey selection may contain a local or global id. Resolve a global
        // id through the store-backed model lookup, including overlay ids.
        const resolved = state.resolveGlobalIdFromModels(storeyId);
        const localId = hierarchy.byStorey.has(storeyId)
          ? storeyId
          : resolved?.modelId === modelId ? resolved.expressId : -1;
        const elements = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, localId, relationships);
        for (const id of elements ?? []) ids.add(toGlobalIdFromModels(models, modelId, id));
      }
    }
    if (models.size === 0 && ifcDataStore?.spatialHierarchy) {
      const hierarchy = ifcDataStore.spatialHierarchy;
      const relationships = ifcDataStore.relationships as AggregationRelationships | undefined;
      for (const storeyId of selectedStoreys) {
        const elements = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, storeyId, relationships);
        for (const id of elements ?? []) ids.add(id);
      }
    }
    if (ids.size > 0) storeyIsolation = ids;
  }

  const filters = [storeyIsolation, classFilter?.ids ?? null, isolatedEntities]
    .filter((ids): ids is Set<number> => ids !== null);
  if (filters.length === 0) return null;
  if (filters.length === 1) return filters[0];
  filters.sort((a, b) => a.size - b.size);
  const intersection = new Set<number>();
  for (const id of filters[0]) {
    if (filters.every((set) => set.has(id))) intersection.add(id);
  }
  return intersection;
}

export interface EffectiveGeometry {
  /** Already filtered for model, type toggle and Model/Types view mode. */
  meshes: ReadonlyArray<Pick<MeshData, 'expressId' | 'entityIds'>> | null;
  /** Point scans are drawn independently of mesh hide/isolate channels. */
  pointClouds: ReadonlyArray<Pick<PointCloudAsset, 'chunk'>>;
  isolatedIds: ReadonlySet<number> | null;
  /** Shards with no retained entity inventory cannot prove an empty view. */
  hasUnenumeratedInstances?: boolean;
}

/** True only when loaded geometry exists and the effective drawable set is empty. */
export type VisibleResultState = Pick<ViewerState, 'models' | 'geometryResult' | 'hiddenEntities'>;

export function isVisibleResultEmpty(state: VisibleResultState, geometry: EffectiveGeometry): boolean {
  if (state.models.size === 0) return false;
  const sources = [...state.models.values()].map((model) =>
    model.geometryResult ?? (state.models.size === 1 ? state.geometryResult : null));
  const hasSource = sources.some((source) => source && (
    source.meshes.length > 0 || source.pointClouds?.some((asset) => asset.chunk.pointCount > 0)
    || (source.instancedGeometryHashes?.size ?? 0) > 0 || source.totalTriangles > 0
  ));
  if (!hasSource) return false;
  if (geometry.pointClouds.some((asset) => asset.chunk.pointCount > 0)) return false;
  const hidden = state.hiddenEntities;
  const isolated = geometry.isolatedIds;
  for (const mesh of geometry.meshes ?? []) {
    if (mesh.entityIds?.length) {
      for (const id of mesh.entityIds) if (isEntityVisible(id, hidden, isolated)) return false;
    } else if (isEntityVisible(mesh.expressId, hidden, isolated)) {
      return false;
    }
  }
  // Instanced occurrences leave the flat mesh list once uploaded. Their hash
  // keys keep an entity-level signal where hashing is enabled. If a visible
  // model has unenumerated instance geometry, avoid a false blank notice.
  for (const model of state.models.values()) {
    if (!model.visible) continue;
    const source = model.geometryResult ?? (state.models.size === 1 ? state.geometryResult : null);
    if (!source) continue;
    for (const id of source.instancedGeometryHashes?.keys() ?? []) {
      if (isEntityVisible(id, hidden, isolated)) return false;
    }
    if (source.totalTriangles > 0 && source.meshes.length === 0
      && !source.instancedGeometryHashes?.size && isolated?.size !== 0) return false;
  }
  if (geometry.hasUnenumeratedInstances && isolated?.size !== 0) return false;
  return true;
}
