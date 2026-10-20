/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { resolvePresentationLayers } from '@/lib/presentation-layers';
import { effectiveTreeEntityName } from './effectiveTypeEntities';
import { makeAssemblyGeometry, resolveTreeGlobalId } from './productTree';
import { effectiveRowType, overlayViewFor, type TreeOverlay } from './treeOverlay';
import type { ExpansionLookup, TreeNode } from './types';

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Presentation assignment membership is independent of spatial containment.
 * Keep rows per assignment and model: names need not be unique, and one product
 * can belong to several assignments. Selection targets products; visibility
 * targets their drawable geometry, following the existing assembly contract. */
export function buildPresentationLayerTree(
  models: Map<string, FederatedModel>,
  legacyStore: IfcDataStore | null | undefined,
  expansion: ExpansionLookup,
  geometricIds: Set<number>,
  geometryReadyModelIds: ReadonlySet<string>,
  overlay?: TreeOverlay,
): TreeNode[] {
  const nodes: TreeNode[] = [];
  const append = (store: IfcDataStore, ownerModelIds: string[]) => {
    // A shared IFCX composition has no per-layer provenance. Resolve IDs through
    // its representative owner, and keep every owner so badges never invent it.
    const modelId = ownerModelIds[0];
    const attributedModelId = ownerModelIds.length === 1 ? modelId : undefined;
    const view = overlayViewFor(overlay, modelId);
    const geometryKnown = ownerModelIds.some((owner) => geometryReadyModelIds.has(owner));
    const geometry = makeAssemblyGeometry(store, modelId, models, geometricIds, geometryKnown, view);
    const productRows = new Map<number, TreeNode>();
    const layers = resolvePresentationLayers(store, view).sort((a, b) =>
      names.compare(a.Name, b.Name) || a.expressId - b.expressId);
    for (const layer of layers) {
      const id = `presentation-layer-${modelId}-${layer.expressId}`;
      const members: TreeNode[] = [];
      const visibility = new Set<number>();
      for (const expressId of new Set(layer.productIds)) {
        let row = productRows.get(expressId);
        if (!row) {
          const ifcType = effectiveRowType(store, view, expressId);
          if (!ifcType) continue;
          const globalId = resolveTreeGlobalId(modelId, expressId, models);
          const parts = geometry.parts(expressId, ifcType);
          row = {
            id: '', expressIds: [expressId], globalIds: [globalId],
            modelIds: ownerModelIds, modelId: attributedModelId,
            name: effectiveTreeEntityName(store, view, expressId),
            ifcType, type: 'element', depth: 1,
            hasChildren: false, isExpanded: false, isVisible: true,
            assemblyChildGlobalIds: parts,
            noGeometry: geometryKnown && !geometricIds.has(globalId) && !parts?.length,
          };
          productRows.set(expressId, row);
        }
        members.push(row);
        if (row.assemblyChildGlobalIds?.length) {
          for (const globalId of row.assemblyChildGlobalIds) visibility.add(globalId);
        } else if (!geometryKnown || geometricIds.has(row.globalIds[0])) {
          visibility.add(row.globalIds[0]);
        }
      }
      if (members.length === 0) continue;
      nodes.push({
        id, expressIds: [layer.expressId], entityExpressId: layer.expressId,
        globalIds: [...visibility], memberGlobalIds: members.map((row) => row.globalIds[0]),
        modelIds: ownerModelIds, modelId: attributedModelId,
        name: layer.Name || `${layer.type} #${layer.expressId}`,
        secondaryName: layer.Identifier || undefined,
        ifcType: layer.type, type: 'presentation-layer', depth: 0,
        hasChildren: true, isExpanded: expansion.has(id), isVisible: true,
        elementCount: members.length,
        noGeometry: geometryKnown && visibility.size === 0,
      });
      if (expansion.has(id)) {
        members.sort((a, b) => names.compare(a.name, b.name) || a.expressIds[0] - b.expressIds[0]);
        for (const member of members) nodes.push({ ...member, id: `${id}-product-${member.expressIds[0]}` });
      }
    }
  };
  if (models.size > 0) {
    // Shared stores are aliases only within the same renderer ID space.
    const storeOwners = new Map<IfcDataStore, Map<number, string[]>>();
    for (const [modelId, model] of models) {
      if (!model.ifcDataStore) continue;
      const byOffset = storeOwners.get(model.ifcDataStore) ?? new Map<number, string[]>();
      const owners = byOffset.get(model.idOffset) ?? [];
      owners.push(modelId);
      byOffset.set(model.idOffset, owners);
      storeOwners.set(model.ifcDataStore, byOffset);
    }
    for (const [store, byOffset] of storeOwners) {
      for (const owners of byOffset.values()) append(store, owners);
    }
  } else if (legacyStore) append(legacyStore, ['legacy']);
  return nodes;
}
