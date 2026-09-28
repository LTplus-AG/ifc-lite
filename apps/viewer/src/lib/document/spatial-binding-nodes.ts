/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcTypeEnumFromString, IfcTypeEnumToString, type SpatialNode } from '@ifc-lite/data';
import { normalizeIfcTypeName } from '@ifc-lite/parser';
import type { BindingModel } from './bindings.js';

/** Spatial binding candidates in hierarchy order, followed by session creations. */
export function spatialBindingNodes(model: BindingModel, typeName: string): SpatialNode[] {
  const project = model.store.spatialHierarchy?.project;
  if (!project) return [];
  const nodes: SpatialNode[] = [];
  const seen = new Set<number>();
  const pending = [project];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node.expressId)) continue;
    seen.add(node.expressId);
    const editedType = model.view?.getEntityTypeMutation(node.expressId)?.newType;
    const type = editedType ? normalizeIfcTypeName(editedType) : IfcTypeEnumToString(node.type);
    if (!model.view?.isDeleted(node.expressId) && type === typeName) nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  for (const created of model.view?.getNewEntities() ?? []) {
    if (model.view?.isDeleted(created.expressId)) continue;
    const type = model.view?.getEntityTypeMutation(created.expressId)?.newType ?? created.type;
    if (normalizeIfcTypeName(type) !== typeName) continue;
    nodes.push({
      expressId: created.expressId,
      type: IfcTypeEnumFromString(typeName),
      name: '',
      children: [],
      elements: [],
    });
  }
  return nodes;
}
