/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExpansionLookup, TreeNode } from './types';

export type LayerGrouping = 'none' | 'class' | 'classification';

/** #9272: reuse class rows, keeping selection owners separate from geometry. */
export function appendLayerGroups(
  nodes: TreeNode[], layerId: string, members: TreeNode[],
  groupsFor: (row: TreeNode) => { key: string; name: string; ifcType?: string }[],
  expansion: ExpansionLookup, geometryKnown: boolean, geometricIds: Set<number>,
): void {
  const groups = new Map<string, { name: string; ifcType?: string; members: TreeNode[] }>();
  for (const member of members) {
    for (const { key, name, ifcType } of new Map(groupsFor(member).map(group => [group.key, group])).values()) {
      const group = groups.get(key) ?? { name, ifcType, members: [] };
      group.members.push(member);
      groups.set(key, group);
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  for (const [key, group] of [...groups].sort((a, b) => collator.compare(a[1].name, b[1].name) || a[0].localeCompare(b[0]))) {
    const id = `${layerId}-group-${encodeURIComponent(key)}`;
    const visibility = new Set<number>();
    for (const member of group.members) {
      if (member.assemblyChildGlobalIds?.length) {
        for (const part of member.assemblyChildGlobalIds) visibility.add(part);
      } else if (!geometryKnown || geometricIds.has(member.globalIds[0])) visibility.add(member.globalIds[0]);
    }
    nodes.push({
      id, name: group.name, ifcType: group.ifcType, type: 'type-group', depth: 1,
      expressIds: group.members.map(row => row.expressIds[0]),
      memberGlobalIds: group.members.map(row => row.globalIds[0]),
      globalIds: [...visibility],
      modelIds: group.members.map(row => row.modelIds[0]),
      modelId: group.members[0].modelId,
      hasChildren: true, isExpanded: expansion.has(id), isVisible: true,
      elementCount: group.members.length, noGeometry: geometryKnown && visibility.size === 0,
    });
    if (expansion.has(id)) {
      for (const member of group.members) nodes.push({ ...member, depth: 2,
        id: `${id}-product-${member.expressIds[0]}` });
    }
  }
}
