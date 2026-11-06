/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parsed spatial tree with the session's storey edits applied (#9013):
 * a storey added this session sits under its building, a deleted one is
 * gone, and every storey shows its live Name and elevation.
 *
 * Derived, never written back: the parsed tree stays the parse result, so
 * Undo and Redo of a storey edit need no bookkeeping here. Only the nodes on
 * the way to a changed storey are copied; everything else is shared.
 */

import { IfcTypeEnum, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { readStoreyInventory } from '@ifc-lite/create';
import { effectiveTreeEntityName } from './effectiveTypeEntities.js';

const cache = new WeakMap<SpatialNode, { view: MutablePropertyView; revision: number; project: SpatialNode }>();

/** A cheap revision of the overlay: storey edits always add mutations or entities. */
function revision(view: MutablePropertyView): number {
  return view.getMutations().length * 1_000_003 + view.getNewEntities().length * 7 + view.getTombstones().size;
}

export function effectiveSpatialProject(store: IfcDataStore, view: MutablePropertyView | null | undefined): SpatialNode | undefined {
  const project = store.spatialHierarchy?.project;
  if (!project || !view?.hasPendingChanges()) return project;
  const at = revision(view);
  const hit = cache.get(project);
  if (hit && hit.view === view && hit.revision === at) return hit.project;

  const inventory = readStoreyInventory(store, view);
  const live = new Map(inventory.storeys.map((storey) => [storey.expressId, storey]));
  const placed = new Set<number>();
  // Direct containment, live: a storey added this session has no parsed entry.
  const contained = (storeyId: number) => [...new Set((inventory.outgoing.get(storeyId) ?? [])
    .filter((rel) => rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE').flatMap((rel) => rel.children))];

  const rebuild = (node: SpatialNode): SpatialNode | null => {
    const storey = node.type === IfcTypeEnum.IfcBuildingStorey;
    if (storey && !live.has(node.expressId)) return null;
    if (storey) placed.add(node.expressId);
    let changed = false;
    const children: SpatialNode[] = [];
    for (const child of node.children ?? []) {
      const next = rebuild(child);
      if (next !== child) changed = true;
      if (next) children.push(next);
    }
    const added = inventory.storeys.filter((candidate) => candidate.parentId === node.expressId
      && !placed.has(candidate.expressId) && !(node.children ?? []).some((child) => child.expressId === candidate.expressId));
    for (const record of added) {
      placed.add(record.expressId);
      children.push({
        expressId: record.expressId, type: IfcTypeEnum.IfcBuildingStorey, name: record.Name,
        elevation: record.elevation, children: [], elements: contained(record.expressId),
      });
      changed = true;
    }
    if (!storey && !changed) return node;
    if (!storey) return { ...node, children };
    const record = live.get(node.expressId)!;
    const name = effectiveTreeEntityName(store, view, node.expressId, node.name);
    if (!changed && name === node.name && record.elevation === node.elevation) return node;
    return { ...node, children, name, elevation: record.elevation };
  };

  const effective = rebuild(project) ?? project;
  cache.set(project, { view, revision: at, project: effective });
  return effective;
}

/**
 * The storey rows of a model, `[storeyId, contained, liveNode]`: the parsed
 * `byStorey` rows when nothing changed, else the live storeys of the
 * effective tree (an added storey has no parsed row; a deleted one is gone).
 */
export function effectiveStoreyRows(
  hierarchy: SpatialHierarchy, project: SpatialNode | undefined, index: ReadonlyMap<number, SpatialNode>,
): Array<[number, readonly number[], SpatialNode | undefined]> {
  if (!project || project === hierarchy.project) return [...hierarchy.byStorey.entries()].map(([id, elements]) => [id, elements, undefined]);
  return [...index.values()].filter((node) => node.type === IfcTypeEnum.IfcBuildingStorey)
    .map((node) => [node.expressId, hierarchy.byStorey.get(node.expressId) ?? [], node]);
}
