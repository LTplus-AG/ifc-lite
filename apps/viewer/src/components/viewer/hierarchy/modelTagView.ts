/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Models section's tag view (#4215), as a pure transform over the rows
 * `treeDataBuilder` already produces for that section: which model rows are
 * LISTED (the tag filter) and whether they are grouped under one header per
 * tag plus an explicit **Untagged** group.
 *
 * Two things this is not:
 *  - It is not visibility. Filtering the rows changes nothing in the
 *    viewport; "Isolate matching models" is a separate, explicit action
 *    (`modelSlice.isolateModels`) that this module only computes the input
 *    for ({@link modelIdsMatchingTagView}).
 *  - It is not a second evaluator. The filter here is the hierarchy's quick
 *    "show me models tagged …" (any-of, plus untagged); the search / clash /
 *    list predicates with their four operators live in `lib/model-tags`.
 *
 * ## One model, several groups
 * A model carrying two tags is listed under both groups. It is still ONE
 * model: its rows keep `modelIds: [modelId]`, so the eye toggle and the
 * row's actions act on the model wherever it was clicked; each group's count
 * is its DISTINCT members; and the row ids are made unique per group
 * (`model-<id>@<group>`) only so React can key the two rows — the id still
 * starts with `model-`, which is how `HierarchyNode` and the panel's node
 * state recognise a model row.
 *
 * Grouped rows do not expand to Project / Site / Building: expansion is
 * keyed on the ungrouped `model-<id>` id in `treeDataBuilder`, and a model
 * under two groups would otherwise have to expand in both or neither. The
 * flat view and the storeys section keep the spatial drill-down.
 */

import type { ModelTag } from '@/lib/model-tags/types';
import type { ModelTagView } from '@/store/slices/modelTagsSlice';
import type { TreeNode } from './types';

/** Group id of the explicit Untagged group; never a tag id (tag ids are UUIDs). */
export const UNTAGGED_GROUP_ID = 'untagged';

export type ModelTagAssignments = ReadonlyMap<string, ReadonlySet<string>>;

/** Is any row filter set? (Grouping alone is not a filter.) */
export function isModelTagFilterActive(view: ModelTagView): boolean {
  return view.filterTagIds.length > 0 || view.filterUntagged;
}

/** Does a model carrying `tagIds` pass the row filter? Everything passes an inactive filter. */
export function modelMatchesTagView(view: ModelTagView, tagIds: ReadonlySet<string> | undefined): boolean {
  if (!isModelTagFilterActive(view)) return true;
  const size = tagIds?.size ?? 0;
  if (view.filterUntagged && size === 0) return true;
  return view.filterTagIds.some((id) => tagIds?.has(id));
}

/** The loaded models the row filter lists — the input to "Isolate matching models". */
export function modelIdsMatchingTagView(
  modelIds: Iterable<string>,
  view: ModelTagView,
  assignments: ModelTagAssignments,
): string[] {
  const out: string[] = [];
  for (const id of modelIds) if (modelMatchesTagView(view, assignments.get(id))) out.push(id);
  return out;
}

/** One model row and the rows nested under it, as `treeDataBuilder` emitted them. */
export interface ModelBlock {
  modelId: string;
  /** `nodes[0]` is the `model-<id>` row; the rest its expanded descendants. */
  nodes: TreeNode[];
}

/** Cut the Models-section row list into per-model blocks, in federation order. */
export function splitModelBlocks(nodes: readonly TreeNode[]): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  for (const node of nodes) {
    if (node.type === 'model-header' && node.id.startsWith('model-')) {
      blocks.push({ modelId: node.modelIds[0], nodes: [node] });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1].nodes.push(node);
    }
  }
  return blocks;
}

/** One group of the "By tag" view: a tag (or Untagged) and its distinct members. */
export interface ModelTagGroup {
  id: string;
  name: string;
  tag: ModelTag | null;
  modelIds: string[];
}

/**
 * Groups for `blocks`: one per tag some listed model carries (by name), then
 * Untagged. Untagged is emitted even when empty unless the row filter is
 * active and excludes untagged models — "every model is tagged" is worth a
 * row that says so; "you filtered them out" is not.
 */
export function groupModelBlocks(
  blocks: readonly ModelBlock[],
  view: ModelTagView,
  tags: ReadonlyMap<string, ModelTag>,
  assignments: ModelTagAssignments,
): ModelTagGroup[] {
  const byTag = new Map<string, string[]>();
  const untagged: string[] = [];
  for (const { modelId } of blocks) {
    const carried = [...(assignments.get(modelId) ?? [])].filter((id) => tags.has(id));
    if (carried.length === 0) { untagged.push(modelId); continue; }
    for (const id of carried) {
      const members = byTag.get(id) ?? [];
      if (!members.includes(modelId)) members.push(modelId);
      byTag.set(id, members);
    }
  }
  const groups: ModelTagGroup[] = [...byTag]
    .map(([id, modelIds]) => ({ id, name: tags.get(id)!.name, tag: tags.get(id)!, modelIds }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const showUntagged = untagged.length > 0 || !isModelTagFilterActive(view) || view.filterUntagged;
  if (showUntagged) groups.push({ id: UNTAGGED_GROUP_ID, name: 'Untagged', tag: null, modelIds: untagged });
  return groups;
}

/**
 * The rows the Models section renders under `view`: the filter applied, and
 * when `groupByTag` is on, one `model-tag-group` header per group followed by
 * its members' model rows (collapsed — see the module doc).
 */
export function applyModelTagView(
  nodes: readonly TreeNode[],
  view: ModelTagView,
  tags: ReadonlyMap<string, ModelTag>,
  assignments: ModelTagAssignments,
): TreeNode[] {
  if (!view.groupByTag && !isModelTagFilterActive(view)) return [...nodes];
  const blocks = splitModelBlocks(nodes).filter((b) => modelMatchesTagView(view, assignments.get(b.modelId)));
  if (!view.groupByTag) return blocks.flatMap((b) => b.nodes);

  const rowOf = new Map(blocks.map((b) => [b.modelId, b.nodes[0]]));
  const out: TreeNode[] = [];
  for (const group of groupModelBlocks(blocks, view, tags, assignments)) {
    out.push({
      id: `model-tag-group:${group.id}`,
      expressIds: [],
      globalIds: [],
      modelIds: group.modelIds,
      name: group.name,
      type: 'model-tag-group',
      depth: 0,
      hasChildren: group.modelIds.length > 0,
      isExpanded: true,
      isVisible: true,
      elementCount: group.modelIds.length,
    });
    for (const modelId of group.modelIds) {
      const row = rowOf.get(modelId)!;
      out.push({ ...row, id: `${row.id}@${group.id}`, hasChildren: false, isExpanded: false, depth: 1 });
    }
  }
  return out;
}
