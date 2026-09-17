/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * cost-tree — pure, store-free presentation logic for the Cost panel
 * (issue #4858). Builds a schedule/item tree and per-item assigned-target
 * lookups directly from `CostGraphData` (the `bim.cost` read model exposed
 * by the merged #4863/#4867 work) — no cost arithmetic lives here, only
 * relationship traversal over what the extractor already produced.
 *
 * The five states the issue calls out are NOT computed here as one collapsed
 * flag: `classifyCostModel` returns each as an independent boolean/field so
 * a caller can show a schedule that is BOTH cyclic AND mixed-currency
 * without one diagnostic masking the other. `HasCostData` is read verbatim
 * from the extractor — never re-derived from "is any array non-empty",
 * which would conflate a genuinely empty model with one whose extraction
 * degraded (see AGENTS.md's null-vs-empty-collection convention,
 * `packages/renderer/src/entity-visibility.ts`).
 */

import type {
  CostDiagnosticData,
  CostGraphData,
  CostItemData,
  CostRelationshipData,
  CostScheduleData,
} from '@ifc-lite/sdk';

export interface EntityRefLike {
  modelId: string;
  expressId: number;
}

function refKey(ref: EntityRefLike): string {
  return `${ref.modelId}:${ref.expressId}`;
}

export interface CostTreeItemNode {
  ref: EntityRefLike;
  item: CostItemData;
  children: CostTreeItemNode[];
  /** True when this item's subtree was already expanded elsewhere in the
   *  same `CostTree` (a second nesting parent, a second schedule, or a
   *  nesting cycle). Such an occurrence is a leaf reference: `children` is
   *  always empty, so shared descendants are expanded once per tree. */
  repeated?: boolean;
}

export interface CostTreeScheduleNode {
  ref: EntityRefLike;
  schedule: CostScheduleData;
  items: CostTreeItemNode[];
}

export interface CostTree {
  schedules: CostTreeScheduleNode[];
  /** Items reachable from no schedule assignment AND not nested under
   *  another item (plus one representative per otherwise-unreachable
   *  nesting cycle) — surfaced explicitly so nothing a
   *  real model declares is silently dropped from the tree. */
  unassignedItems: CostTreeItemNode[];
}

/** The cycle diagnostic codes the Cost panel treats as "cyclic". Exported
 *  so `templates.ts` can inject the same list into the `cost-report`
 *  script template at build time instead of duplicating it — a hand-copied
 *  list in the template would silently drift from this one the next time a
 *  cycle code is added here (see `templates.test.ts`). */
export const CYCLE_CODES_LIST: readonly CostDiagnosticData['Code'][] = ['NESTING_CYCLE', 'QUANTITY_CYCLE', 'VALUE_CYCLE'];
const CYCLE_CODES = new Set<CostDiagnosticData['Code']>(CYCLE_CODES_LIST);

export interface CostModelStateFlags {
  /** Verbatim from the extractor — the authoritative "this model genuinely
   *  has no cost data" signal. Never re-derived from array lengths. */
  hasCostData: boolean;
  cyclic: boolean;
  mixedCurrency: boolean;
  diagnostics: CostDiagnosticData[];
}

export function classifyCostModel(graph: CostGraphData): CostModelStateFlags {
  return {
    hasCostData: graph.HasCostData,
    cyclic: graph.Diagnostics.some((d) => CYCLE_CODES.has(d.Code)),
    mixedCurrency: graph.Diagnostics.some((d) => d.Code === 'MIXED_CURRENCY'),
    diagnostics: graph.Diagnostics,
  };
}

/** An evaluation whose `Amount` never resolved is "unresolved" — regardless
 *  of *why* (missing value, invalid number, unsupported applied value, …).
 *  The caller still has the evaluation's own `Diagnostics` to explain why. */
export function isUnresolved(evaluation: { Amount?: string }): boolean {
  return evaluation.Amount === undefined;
}

function buildItemMap(graph: CostGraphData): Map<string, CostItemData> {
  const map = new Map<string, CostItemData>();
  for (const item of graph.CostItems) map.set(refKey(item.ref), item);
  return map;
}

function buildScheduleMap(graph: CostGraphData): Map<string, CostScheduleData> {
  const map = new Map<string, CostScheduleData>();
  for (const schedule of graph.CostSchedules) map.set(refKey(schedule.ref), schedule);
  return map;
}

/** Relationship types that assign cost items to a controlling schedule.
 *  `IfcRelSchedulesCostItems` is the IFC2X3 subtype of
 *  `IfcRelAssignsToControl` with the same schedule-to-item endpoints, and
 *  the parser's cost extractor emits it as its own `Type`. */
function isScheduleAssignment(rel: CostRelationshipData): boolean {
  return rel.Type === 'IfcRelAssignsToControl' || rel.Type === 'IfcRelSchedulesCostItems';
}

/** Append `key` to the de-duplicated list stored under `owner`. Duplicate
 *  relationship entities naming the same pair must not render twice. */
function pushUnique(lists: Map<string, string[]>, seen: Set<string>, owner: string, key: string): void {
  const pairKey = `${owner}>${key}`;
  if (seen.has(pairKey)) return;
  seen.add(pairKey);
  const list = lists.get(owner);
  if (list) list.push(key);
  else lists.set(owner, [key]);
}

/**
 * Build the schedule → item → nested-item tree. Two relationship shapes
 * drive it:
 *  - `IfcRelAssignsToControl` (or IFC2X3 `IfcRelSchedulesCostItems`) where
 *    `RelatingControl` is a KNOWN SCHEDULE ref assigns its `RelatedObjects`
 *    (cost items) to that schedule.
 *  - `IfcRelNests` where `RelatingObject` is a KNOWN ITEM ref nests its
 *    `RelatedObjects` (cost items) as children.
 *
 * A child appearing under its parent via `IfcRelNests` is not ALSO listed
 * as a root of a schedule whose tree already contains that parent — within
 * one schedule the tree shows nesting structure once. When the parent is
 * outside the schedule, the directly assigned child is still that
 * schedule's root.
 *
 * Items reachable from no root (an unscheduled nesting cycle A → B → A has
 * no un-nested member) get one representative root per component, chosen
 * as the first unreached item in `CostItems` order, so they stay visible.
 */
export function buildCostTree(graph: CostGraphData): CostTree {
  const itemsByKey = buildItemMap(graph);
  const schedulesByKey = buildScheduleMap(graph);

  const childKeysByParent = new Map<string, string[]>();
  const nestedChildKeys = new Set<string>();
  const firstParentByChild = new Map<string, string>();
  const parentKeysByChild = new Map<string, string[]>();
  const seenNestPairs = new Set<string>();
  const scheduleRootKeysBySchedule = new Map<string, string[]>();
  const assignedItemKeys = new Set<string>();
  const seenAssignPairs = new Set<string>();

  for (const rel of graph.Relationships) {
    if (rel.Type === 'IfcRelNests' && rel.RelatingObject) {
      const parentKey = refKey(rel.RelatingObject);
      if (!itemsByKey.has(parentKey)) continue;
      for (const child of rel.RelatedObjects ?? []) {
        const childKey = refKey(child);
        if (!itemsByKey.has(childKey)) continue;
        pushUnique(childKeysByParent, seenNestPairs, parentKey, childKey);
        nestedChildKeys.add(childKey);
        if (!firstParentByChild.has(childKey)) firstParentByChild.set(childKey, parentKey);
        const parents = parentKeysByChild.get(childKey);
        if (parents) parents.push(parentKey);
        else parentKeysByChild.set(childKey, [parentKey]);
      }
    } else if (isScheduleAssignment(rel) && rel.RelatingControl) {
      const controlKey = refKey(rel.RelatingControl);
      if (!schedulesByKey.has(controlKey)) continue;
      for (const related of rel.RelatedObjects ?? []) {
        const relatedKey = refKey(related);
        if (!itemsByKey.has(relatedKey)) continue;
        pushUnique(scheduleRootKeysBySchedule, seenAssignPairs, controlKey, relatedKey);
        assignedItemKeys.add(relatedKey);
      }
    }
  }

  /** Keys whose subtree has already been expanded somewhere in this tree.
   *
   *  Bounded-expansion rule: each item's subtree is expanded at most ONCE per
   *  `CostTree`, at its first occurrence in build order (schedules in
   *  `CostSchedules` order, then unassigned roots). Any later occurrence —
   *  a second nesting parent (diamond / MULTIPLE_NESTING_PARENTS), a second
   *  schedule, or a nesting cycle back to an ancestor — is a leaf reference
   *  with `repeated: true` and no children. Without this, a diamond chain
   *  N levels deep expands 2^N paths and the node count, and the rendered
   *  rows, grow exponentially. With it, the node count is bounded by
   *  (items + nesting edges + roots). */
  const expanded = new Set<string>();

  /** Iterative depth-first build — an arbitrarily deep acyclic nesting
   *  chain must not exhaust the JS call stack. */
  function buildNode(rootKey: string): CostTreeItemNode {
    const makeNode = (key: string): CostTreeItemNode => {
      const item = itemsByKey.get(key);
      if (!item) throw new Error(`cost-tree: item ${key} vanished mid-build`);
      return { ref: item.ref, item, children: [] };
    };
    const root = makeNode(rootKey);
    if (expanded.has(rootKey)) {
      root.repeated = true;
      return root;
    }
    expanded.add(rootKey);
    const stack: Array<{ key: string; node: CostTreeItemNode; next: number }> = [
      { key: rootKey, node: root, next: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const childKeys = childKeysByParent.get(frame.key) ?? [];
      if (frame.next >= childKeys.length) {
        stack.pop();
        continue;
      }
      const childKey = childKeys[frame.next++];
      const child = makeNode(childKey);
      frame.node.children.push(child);
      if (expanded.has(childKey)) {
        child.repeated = true;
        continue;
      }
      expanded.add(childKey);
      stack.push({ key: childKey, node: child, next: 0 });
    }
    return root;
  }

  /** Add every key reachable from `rootKey` through nesting to `into`. */
  function collectReachable(rootKey: string, into: Set<string>): void {
    const pending = [rootKey];
    while (pending.length > 0) {
      const key = pending.pop()!;
      if (into.has(key)) continue;
      into.add(key);
      for (const childKey of childKeysByParent.get(key) ?? []) pending.push(childKey);
    }
  }

  const reached = new Set<string>();
  const markReachable = (rootKey: string): void => collectReachable(rootKey, reached);

  const schedules: CostTreeScheduleNode[] = graph.CostSchedules.map((schedule) => {
    const key = refKey(schedule.ref);
    const assignedKeys = scheduleRootKeysBySchedule.get(key) ?? [];
    // A directly assigned item is a root of THIS schedule unless one of its
    // nesting parents is already placed in this schedule's tree (it then
    // shows under that parent). A parent outside the schedule does not
    // hide it, or the schedule would render empty.
    const inSchedule = new Set<string>();
    for (const assignedKey of assignedKeys) collectReachable(assignedKey, inSchedule);
    const rootKeys = assignedKeys.filter(
      (k) => !(parentKeysByChild.get(k) ?? []).some((parentKey) => inSchedule.has(parentKey)),
    );
    // Assigned items that nest each other in a cycle all have a parent in
    // the schedule; the first one not yet covered becomes a root.
    const covered = new Set<string>();
    for (const rootKey of rootKeys) collectReachable(rootKey, covered);
    for (const assignedKey of assignedKeys) {
      if (covered.has(assignedKey)) continue;
      rootKeys.push(assignedKey);
      collectReachable(assignedKey, covered);
    }
    rootKeys.forEach(markReachable);
    return {
      ref: schedule.ref,
      schedule,
      items: rootKeys.map((rootKey) => buildNode(rootKey)),
    };
  });

  const unassignedKeys: string[] = [];
  for (const item of graph.CostItems) {
    const key = refKey(item.ref);
    if (assignedItemKeys.has(key) || nestedChildKeys.has(key)) continue;
    unassignedKeys.push(key);
    markReachable(key);
  }
  // Components with no un-nested member (pure nesting cycles, or items
  // hanging off one) are otherwise unreachable from every root. Every
  // unreached item is nested under an unreached parent, so climbing first
  // parents always ends on a cycle member: that member becomes the
  // representative root, so an item hanging off the cycle is not promoted
  // above it.
  for (const item of graph.CostItems) {
    let key = refKey(item.ref);
    if (reached.has(key)) continue;
    const climbed = new Set<string>();
    while (!climbed.has(key)) {
      climbed.add(key);
      const parentKey = firstParentByChild.get(key);
      if (parentKey === undefined) break;
      key = parentKey;
    }
    unassignedKeys.push(key);
    markReachable(key);
  }

  return { schedules, unassignedItems: unassignedKeys.map((key) => buildNode(key)) };
}

/**
 * Whether evaluating the tree's items reports `MIXED_CURRENCY`. Arithmetic
 * that combines explicitly GBP- and USD-valued operands only surfaces that
 * code at evaluation time, never in `graph.Diagnostics`, so the model-level
 * badge must also consult evaluations. Only root items are evaluated: an
 * item evaluation includes its nested items, and every item is reachable
 * from some root.
 */
export function treeHasMixedCurrencyEvaluation(
  tree: CostTree,
  evaluateItem: (ref: EntityRefLike) => { Diagnostics: ReadonlyArray<Pick<CostDiagnosticData, 'Code'>> },
): boolean {
  const seen = new Set<string>();
  const roots = [...tree.schedules.flatMap((s) => s.items), ...tree.unassignedItems];
  for (const root of roots) {
    const key = refKey(root.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (evaluateItem(root.ref).Diagnostics.some((d) => d.Code === 'MIXED_CURRENCY')) return true;
  }
  return false;
}

/**
 * Assigned products/tasks for one cost item — the union of every
 * relationship shape the read model can carry:
 *  - `IfcRelAssignsToProduct` naming this item in `RelatedObjects` → target
 *    is `RelatingProduct`.
 *  - `IfcRelAssignsToProcess` naming this item in `RelatedObjects` → target
 *    is `RelatingProcess`.
 *  - `IfcRelAssignsToControl` where `RelatingControl` IS this item (an
 *    `IfcCostItem` is an `IfcControl`) → targets are `RelatedObjects`
 *    directly (products, tasks, or other controlled objects).
 * De-duplicated by ref key; order is relationship-array order.
 */
export function getAssignedTargets(graph: CostGraphData, itemRef: EntityRefLike): EntityRefLike[] {
  const itemKey = refKey(itemRef);
  const seen = new Set<string>();
  const targets: EntityRefLike[] = [];
  const add = (ref?: CostRelationshipData['RelatingProduct']) => {
    if (!ref) return;
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(ref);
  };

  for (const rel of graph.Relationships) {
    const related = rel.RelatedObjects ?? [];
    if (rel.Type === 'IfcRelAssignsToProduct' && related.some((r) => refKey(r) === itemKey)) {
      add(rel.RelatingProduct);
    } else if (rel.Type === 'IfcRelAssignsToProcess' && related.some((r) => refKey(r) === itemKey)) {
      add(rel.RelatingProcess);
    } else if (rel.Type === 'IfcRelAssignsToControl' && rel.RelatingControl && refKey(rel.RelatingControl) === itemKey) {
      for (const target of related) add(target);
    }
  }
  return targets;
}

/** Which schedule(s) (by ref key) directly control a given item, for the
 *  detail view's "part of schedule X" line. Empty when the item is
 *  unassigned (see `CostTree.unassignedItems`). */
export function getOwningSchedules(graph: CostGraphData, itemRef: EntityRefLike): CostScheduleData[] {
  const itemKey = refKey(itemRef);
  const schedulesByKey = buildScheduleMap(graph);
  const owners: CostScheduleData[] = [];
  const seen = new Set<string>();
  for (const rel of graph.Relationships) {
    if (!isScheduleAssignment(rel) || !rel.RelatingControl) continue;
    const controlKey = refKey(rel.RelatingControl);
    const schedule = schedulesByKey.get(controlKey);
    if (!schedule) continue;
    if (!(rel.RelatedObjects ?? []).some((r) => refKey(r) === itemKey)) continue;
    if (seen.has(controlKey)) continue;
    seen.add(controlKey);
    owners.push(schedule);
  }
  return owners;
}

export { refKey };
