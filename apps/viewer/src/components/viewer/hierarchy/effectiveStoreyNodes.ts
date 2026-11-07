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
import { effectiveStoreyElevation, readStoreyInventory } from '@ifc-lite/create';
import { effectiveTreeEntityName } from './effectiveTypeEntities.js';

const cache = new WeakMap<SpatialNode, { view: MutablePropertyView; revision: string; project: SpatialNode }>();

/**
 * A cheap revision of the overlay. Counts alone collide: a preview undone and
 * replaced by another adds as many mutations and entities as the first. The
 * last mutation's id and the highest authored express id never repeat, so
 * two different overlay states never share a revision.
 */
function revision(view: MutablePropertyView): string {
  const mutations = view.getMutations();
  let newest = 0, entities = 0;
  for (const entity of view.getNewEntities()) { entities++; if (entity.expressId > newest) newest = entity.expressId; }
  return `${mutations.length}:${mutations.at(-1)?.id ?? ''}:${entities}:${newest}:${view.getTombstones().size}`;
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
    // Live direct containment: an element moved here (or away) this session is listed where it now is.
    const elements = contained(node.expressId);
    const sameElements = elements.length === node.elements.length && elements.every((id, i) => id === node.elements[i]);
    if (!changed && sameElements && name === node.name && record.elevation === node.elevation) return node;
    return { ...node, children, name, elevation: record.elevation, elements };
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
  // Every level the parsed rows had (IFC4.3 facility parts included), plus storeys added this session.
  const rows: Array<[number, readonly number[], SpatialNode | undefined]> = [...index.values()]
    .filter((node) => node.type === IfcTypeEnum.IfcBuildingStorey || hierarchy.byStorey.has(node.expressId))
    .map((node) => [node.expressId, node.type === IfcTypeEnum.IfcBuildingStorey ? node.elements : hierarchy.byStorey.get(node.expressId) ?? [], node]);
  // A partial source can list a level in `byStorey` that its tree never had.
  // Only a level the parsed tree had can have been deleted; the others stay.
  const parsed = treeIds(hierarchy.project);
  for (const [id, elements] of hierarchy.byStorey) {
    if (!index.has(id) && !parsed.has(id)) rows.push([id, elements, undefined]);
  }
  return rows;
}

function treeIds(root: SpatialNode | undefined): Set<number> {
  const ids = new Set<number>();
  const stack = root ? [root] : [];
  for (let node = stack.pop(); node; node = stack.pop()) {
    ids.add(node.expressId);
    stack.push(...node.children);
  }
  return ids;
}

/**
 * Storeys added this session to a source with no project tree (#9013): the
 * parsed `byStorey` rows cannot list them, so they come from the overlay,
 * with their live direct containment.
 */
export function addedStoreyRows(
  store: IfcDataStore, view: MutablePropertyView | null | undefined, hierarchy: SpatialHierarchy,
): Array<[number, readonly number[], undefined]> {
  if (!view || !view.getNewEntities().some((entity) => entity.type.toUpperCase() === 'IFCBUILDINGSTOREY')) return [];
  const inventory = readStoreyInventory(store, view);
  return inventory.storeys
    .filter((storey) => !hierarchy.byStorey.has(storey.expressId))
    .map((storey) => [storey.expressId, [...new Set((inventory.outgoing.get(storey.expressId) ?? [])
      .filter((rel) => rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE').flatMap((rel) => rel.children))], undefined]);
}

export interface LiveStoreyRow {
  readonly storeyId: number;
  readonly elements: readonly number[];
  readonly name: string;
  /** Metres, as authored this session. */
  readonly elevation: number;
}

/**
 * Every storey row of a model with its live name and elevation (#9013): the
 * parsed or effective-tree rows, plus storeys added this session that neither
 * lists (e.g. under a building a partial tree omits). A row with no live node
 * reads the session's edits directly; one deleted this session is dropped.
 */
export function liveStoreyRows(
  store: IfcDataStore, view: MutablePropertyView | null | undefined, hierarchy: SpatialHierarchy,
  project: SpatialNode | undefined, index: ReadonlyMap<number, SpatialNode>,
): LiveStoreyRow[] {
  const listedRows = effectiveStoreyRows(hierarchy, project, index);
  const listed = new Set(listedRows.map(([id]) => id));
  const rows = [...listedRows, ...addedStoreyRows(store, view, hierarchy).filter(([id]) => !listed.has(id))];
  const out: LiveStoreyRow[] = [];
  for (const [storeyId, elements, live] of rows) {
    if (!live && view?.isDeleted(storeyId)) continue;
    const elevation = live?.elevation
      ?? (view ? effectiveStoreyElevation(store, view, storeyId) : hierarchy.storeyElevations.get(storeyId)) ?? 0;
    const fallbackName = store.entities.getName(storeyId) || `Storey #${storeyId}`;
    const name = live?.name || (view ? effectiveTreeEntityName(store, view, storeyId, fallbackName) : fallbackName);
    out.push({ storeyId, elements, name, elevation });
  }
  return out;
}
