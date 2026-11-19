/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store';
import { effectiveSpatialMembers } from '@/lib/effective-spatial-members';
import type { TreeNode, UnifiedStorey } from './types';

/** What resolving a row's elements reads: one input generation of the tree. */
export interface NodeElementsInputs {
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null | undefined;
  unifiedStoreys: readonly UnifiedStorey[];
  getUnifiedStoreyElements: (unified: UnifiedStorey) => number[];
  toGlobalIdsForModel: (modelId: string, expressIds: number[]) => number[];
  mutationViews: ReadonlyMap<string, MutablePropertyView>;
}

/** Rows whose elements come from spatial membership rather than the node itself. */
function resolvesMembership(node: TreeNode): boolean {
  return node.type === 'unified-storey' || node.type === 'IfcBuildingStorey' || node.type === 'IfcSpace'
    || node.type === 'IfcSpatialZone' || (node.type === 'model-header' && node.id.startsWith('contrib-'));
}

/** All elements a row stands for (type groups, ifc-type, unified storeys, single storeys, model contributions, and elements). */
function resolveNodeElements(node: TreeNode, inputs: NodeElementsInputs): number[] {
  const { models, ifcDataStore, unifiedStoreys, getUnifiedStoreyElements, toGlobalIdsForModel, mutationViews } = inputs;
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
      const elements = effectiveSpatialMembers(ifcDataStore, mutationViews.get('legacy'), storeyId);
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
      const elements = effectiveSpatialMembers(ifcDataStore, mutationViews.get('legacy'), spaceId);
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
}

/** The rows' views' mutation revisions: remote and skip-history writes advance them without a viewer mutationVersion. */
function revisionOf(node: TreeNode, views: ReadonlyMap<string, MutablePropertyView>): string {
  return node.modelIds.map((modelId) => views.get(modelId)?.getMutationRevision()).join();
}

/**
 * The elements of a row, resolved once per row for one input generation
 * (#10535). The panel asks for every visible row on each render, up to three
 * times per row, and a storey's membership reads the session's relationship
 * overlay; a placement edit and its mesh swap render the panel several times
 * with the same inputs. An entry is reused only while its models' views are
 * at the revision it was resolved at. Callers must not mutate the returned array.
 */
export function createNodeElementsResolver(inputs: NodeElementsInputs): (node: TreeNode) => number[] {
  const resolved = new Map<string, { revision: string; elements: number[] }>();
  return (node) => {
    if (!resolvesMembership(node)) return resolveNodeElements(node, inputs);
    const revision = revisionOf(node, inputs.mutationViews);
    const cached = resolved.get(node.id);
    if (cached?.revision === revision) return cached.elements;
    const elements = resolveNodeElements(node, inputs);
    resolved.set(node.id, { revision, elements });
    return elements;
  };
}
