/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from '@/store/types';
import { toGlobalIdFromModels, type ForwardModelMapLike } from '@/store/globalId';
import type { MultiSelectItem } from '@/hooks/useEntityListMultiSelect';
import type { TreeNode } from './types';

/** The entities a hierarchy row represents, independent of its visibility actions. */
export function hierarchyRowSelection(
  node: TreeNode,
  models: ForwardModelMapLike,
  resolveGlobalId: (globalId: number) => EntityRef | null,
): MultiSelectItem[] {
  const rows: MultiSelectItem[] = [];
  const seen = new Set<number>();
  const push = (globalId: number, ref: EntityRef | null) => {
    if (!ref || seen.has(globalId)) return;
    seen.add(globalId);
    rows.push({ globalId, modelId: ref.modelId, expressId: ref.expressId });
  };
  const pushLocal = (modelId: string, expressId: number, globalId?: number) => {
    push(globalId ?? (modelId === 'legacy' ? expressId : toGlobalIdFromModels(models, modelId, expressId)),
      { modelId, expressId });
  };

  // Class and IFC-type groups carry an aligned member list. Their geometry
  // IDs may substitute assembly parts, so selecting from globalIds would
  // silently select different entities from those listed in the tree.
  if ((node.type === 'type-group' || node.type === 'ifc-type' || node.type === 'other-group') && node.memberGlobalIds) {
    node.memberGlobalIds.forEach((globalId, index) => {
      const expressId = node.expressIds[index];
      const modelId = node.modelIds[index];
      if (expressId != null && modelId) pushLocal(modelId, expressId, globalId);
      else push(globalId, resolveGlobalId(globalId));
    });
    return rows;
  }

  if (node.type === 'material-group' || node.type === 'group') {
    const members = node.type === 'group' ? node.memberGlobalIds ?? node.globalIds : node.globalIds;
    members.forEach((globalId) => push(globalId, resolveGlobalId(globalId)));
    return rows;
  }

  if (node.type === 'unified-storey') {
    node.expressIds.forEach((expressId, index) => {
      pushLocal(node.modelIds[index] ?? 'legacy', expressId);
    });
    return rows;
  }

  if (node.type === 'model-header' || node.type === 'model-tag-group') return rows;

  // Assemblies have no shape of their own: select the parts for the renderer,
  // then the assembly entity last so it remains the primary properties row.
  node.assemblyChildGlobalIds?.forEach((globalId) => push(globalId, resolveGlobalId(globalId)));
  const expressId = node.expressIds[0] ?? node.entityExpressId;
  if (expressId != null) pushLocal(node.modelIds[0] ?? 'legacy', expressId, node.globalIds[0]);
  return rows;
}
