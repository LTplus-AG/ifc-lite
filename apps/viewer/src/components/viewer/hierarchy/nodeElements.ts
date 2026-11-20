/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store';
import { effectiveSpatialMembers } from '@/lib/effective-spatial-members';
import { getLegacySourceMutationView } from '@/sdk/adapters/model-compat';
import type { TreeNode, UnifiedStorey } from './types';

/** Rows whose elements come from spatial membership; the rest carry theirs on the node. */
const MEMBERSHIP_ROWS = new Set(['unified-storey', 'IfcBuildingStorey', 'IfcSpace', 'IfcSpatialZone']);

/**
 * The elements a row stands for (type groups, ifc-type, unified storeys,
 * single storeys, model contributions, and elements), resolved once per
 * membership row for one input generation (#10535). The panel asks for every
 * visible row on each render, up to three times per row, and a storey's
 * membership reads the session's relationship overlay; a placement edit and
 * its mesh swap render the panel several times with the same inputs. An
 * entry is reused only while its models' views are at the revision it was
 * resolved at. Callers must not mutate the returned array.
 */
export function createNodeElementsResolver(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  unifiedStoreys: readonly UnifiedStorey[],
  getUnifiedStoreyElements: (unified: UnifiedStorey) => number[],
  toGlobalIdsForModel: (modelId: string, expressIds: number[]) => number[],
  mutationViews: ReadonlyMap<string, MutablePropertyView>,
): (node: TreeNode) => number[] {
  const legacyView = getLegacySourceMutationView({ models, ifcDataStore: ifcDataStore ?? null, mutationViews });
  const resolve = (node: TreeNode): number[] => {
    if (node.type === 'type-group' || node.type === 'ifc-type' || node.type === 'material-group' ||
        node.type === 'group' || node.type === 'presentation-layer' || node.type === 'group-member') {
      // GlobalIds are pre-stored on the node during tree construction — O(1).
      // For 'group' rows these are the RESOLVED member geometry ids (#1622).
      return node.globalIds;
    }
    if (node.type === 'unified-storey') {
      // Get all elements from all models for this unified storey
      const unified = unifiedStoreys.find(u => `unified-${u.key}` === node.id);
      if (unified) {
        return getUnifiedStoreyElements(unified);
      }
    } else if (node.type === 'model-header' && node.id.startsWith('contrib-')) {
      // Model contribution header inside a unified storey - get elements for this model's storey
      const storeyId = node.expressIds[0];
      const modelId = node.modelIds[0];
      const model = models.get(modelId);
      if (model?.ifcDataStore?.spatialHierarchy) {
        const localIds = effectiveSpatialMembers(model.ifcDataStore, mutationViews.get(modelId), storeyId);
        return toGlobalIdsForModel(modelId, localIds);
      }
    } else if (node.type === 'IfcBuildingStorey') {
      // Get storey elements
      const storeyId = node.expressIds[0];
      const modelId = node.modelIds[0];

      if (modelId === 'legacy' && ifcDataStore?.spatialHierarchy) {
        const elements = effectiveSpatialMembers(ifcDataStore, legacyView, storeyId);
        if (elements.length) return elements;
      }

      const model = models.get(modelId);
      if (model?.ifcDataStore?.spatialHierarchy) {
        const localIds = effectiveSpatialMembers(model.ifcDataStore, mutationViews.get(modelId), storeyId);
        return toGlobalIdsForModel(modelId, localIds);
      }
    } else if (node.type === 'IfcSpace' || node.type === 'IfcSpatialZone') {
      const spaceId = node.expressIds[0];
      const modelId = node.modelIds[0];

      if (modelId === 'legacy' && ifcDataStore?.spatialHierarchy) {
        const elements = effectiveSpatialMembers(ifcDataStore, legacyView, spaceId);
        return [spaceId, ...elements];
      }

      const model = models.get(modelId);
      if (model?.ifcDataStore?.spatialHierarchy) {
        const localIds = effectiveSpatialMembers(model.ifcDataStore, mutationViews.get(modelId), spaceId);
        return [...node.globalIds, ...toGlobalIdsForModel(modelId, localIds)];
      }
    } else if (node.type === 'element') {
      // A decomposing assembly folds in its IfcRelAggregates parts so the eye
      // toggle / isolate / basket act on the whole assembly at once (#1133).
      return node.assemblyChildGlobalIds && node.assemblyChildGlobalIds.length > 0
        ? [...node.globalIds, ...node.assemblyChildGlobalIds]
        : node.globalIds;
    }
    // Spatial containers (Project, Site, Building) and top-level models don't have direct element visibility toggle
    return [];
  };
  /** Row id to [views' revisions, elements]. */
  const resolved = new Map<string, [string, number[]]>();
  return (node) => {
    // Only a model's contribution header inside a unified storey has a `contrib-` id (treeDataBuilder).
    if (!MEMBERSHIP_ROWS.has(node.type) && !node.id.startsWith('contrib-')) return resolve(node);
    // SDK raw, skip-history and remote writes advance the views' revisions without a viewer mutationVersion.
    const revision = node.modelIds.map((id) => mutationViews.get(id)?.getMutationRevision()).join();
    const legacyRevision = node.modelIds.includes('legacy') ? legacyView?.getMutationRevision() : undefined;
    const cacheKey = legacyRevision === undefined ? revision : `${revision}:${legacyRevision}`;
    const cached = resolved.get(node.id);
    if (cached?.[0] === cacheKey) return cached[1];
    const elements = resolve(node);
    resolved.set(node.id, [cacheKey, elements]);
    return elements;
  };
}
