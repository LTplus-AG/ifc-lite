/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The model's spatial tree, in one place.
 *
 * `spatial_hierarchy` and the `ifc-lite://model/{id}/spatial-tree` resource
 * answer the same question and used to answer it with two walks that disagreed:
 * the tool recursed through containment as well as aggregation, the resource did
 * not; the tool fell back to a queued `IfcProject` when the file's was deleted,
 * the resource returned null; and neither carried a visited set, so a cyclic
 * aggregation edge recursed until the stack gave out. A malformed IFC could hang
 * the server rather than be reported.
 *
 * One walk, used by both. Reads go through `m.bim`, so the tree reflects the
 * session's queued and deleted relationships like the rest of the read surface
 * (#2014).
 */

import type { LoadedModel } from './context.js';
import { pendingOverlay } from './overlay.js';

/** One node of the spatial tree. `elements` is present only when asked for. */
export interface SpatialNode {
  expressId: number;
  globalId: string;
  type: string;
  name: string;
  /** Express ids contained in this spatial node (`IfcRelContainedInSpatialStructure`). */
  elements?: number[];
  children: SpatialNode[];
}

/**
 * The `IfcProject` this tree hangs from, or null.
 *
 * A session can delete the file's project, and can create one — so the answer is
 * "the first live persisted `IfcProject`, else the first queued one". The
 * resource used to consider only the persisted list and return null where the
 * tool succeeded, which is two answers to one question.
 */
export function spatialRootId(model: LoadedModel): number | null {
  const overlay = pendingOverlay(model);
  for (const id of model.store.entityIndex.byType.get('IFCPROJECT') ?? []) {
    if (!overlay?.deleted.has(id)) return id;
  }
  for (const created of overlay?.createdAll ?? []) {
    if (created.ifcType.toUpperCase() === 'IFCPROJECT') return created.expressId;
  }
  return null;
}

/** The whole tree from {@link spatialRootId}, or null when there is no project. */
export function buildSpatialTree(
  model: LoadedModel,
  options: { includeElements?: boolean } = {},
): SpatialNode | null {
  const root = spatialRootId(model);
  if (root === null) return null;
  return buildNode(model, root, options.includeElements === true, new Set());
}

/**
 * One node and its descendants.
 *
 * **Children come from aggregation only.** `IfcRelContainedInSpatialStructure`
 * names the *elements* a spatial node holds — walls, doors — and those are not
 * spatial nodes; recursing into them put every wall in the file into the tree
 * twice, once as a child and once in `elements`. The spatial chain
 * (project → site → building → storey → space) is aggregation, which is what
 * this follows.
 *
 * **`visited` is threaded, not re-created.** A file whose aggregation contains a
 * cycle — or merely a diamond, where one entity is aggregated under two parents
 * — otherwise recurses forever. An entity already placed is not placed again, so
 * it appears under the first parent reached and the walk is finite. Acyclic
 * input is unaffected: nothing is ever reached twice.
 */
function buildNode(
  model: LoadedModel,
  expressId: number,
  includeElements: boolean,
  visited: Set<number>,
): SpatialNode {
  visited.add(expressId);
  const ref = { modelId: model.id, expressId };
  const data = model.bim.entity(ref);
  const children: SpatialNode[] = [];
  for (const child of model.bim.decomposes(ref)) {
    if (visited.has(child.ref.expressId)) continue;
    children.push(buildNode(model, child.ref.expressId, includeElements, visited));
  }
  const node: SpatialNode = {
    expressId,
    globalId: data?.globalId ?? '',
    type: data?.type ?? 'Unknown',
    name: data?.name ?? '',
    children,
  };
  if (includeElements) {
    node.elements = model.bim.contains(ref).map((e) => e.ref.expressId);
  }
  return node;
}
