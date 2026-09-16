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
}

export interface CostTreeScheduleNode {
  ref: EntityRefLike;
  schedule: CostScheduleData;
  items: CostTreeItemNode[];
}

export interface CostTree {
  schedules: CostTreeScheduleNode[];
  /** Items reachable from no `IfcRelAssignsToControl` schedule assignment
   *  AND not nested under another item — surfaced explicitly so nothing a
   *  real model declares is silently dropped from the tree. */
  unassignedItems: CostTreeItemNode[];
}

const CYCLE_CODES = new Set<CostDiagnosticData['Code']>(['NESTING_CYCLE', 'QUANTITY_CYCLE', 'VALUE_CYCLE']);

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

/**
 * Build the schedule → item → nested-item tree. Two relationship shapes
 * drive it:
 *  - `IfcRelAssignsToControl` where `RelatingControl` is a KNOWN SCHEDULE
 *    ref assigns its `RelatedObjects` (cost items) to that schedule.
 *  - `IfcRelNests` where `RelatingObject` is a KNOWN ITEM ref nests its
 *    `RelatedObjects` (cost items) as children.
 *
 * A child appearing under its parent via `IfcRelNests` is not ALSO listed
 * as a schedule root even if it happens to carry its own control
 * assignment elsewhere — the tree shows nesting structure once.
 */
export function buildCostTree(graph: CostGraphData): CostTree {
  const itemsByKey = buildItemMap(graph);
  const schedulesByKey = buildScheduleMap(graph);

  const childKeysByParent = new Map<string, string[]>();
  const nestedChildKeys = new Set<string>();
  for (const rel of graph.Relationships) {
    if (rel.Type !== 'IfcRelNests' || !rel.RelatingObject) continue;
    const parentKey = refKey(rel.RelatingObject);
    if (!itemsByKey.has(parentKey)) continue;
    const list = childKeysByParent.get(parentKey) ?? [];
    for (const child of rel.RelatedObjects ?? []) {
      const childKey = refKey(child);
      if (!itemsByKey.has(childKey)) continue;
      list.push(childKey);
      nestedChildKeys.add(childKey);
    }
    childKeysByParent.set(parentKey, list);
  }

  function buildNode(key: string, visiting: Set<string>): CostTreeItemNode {
    const item = itemsByKey.get(key);
    if (!item) throw new Error(`cost-tree: item ${key} vanished mid-build`);
    // Defensive cycle guard: the extractor already reports NESTING_CYCLE in
    // graph.Diagnostics, but the tree builder must not infinite-loop or
    // stack-overflow if it is ever handed a cyclic graph before that
    // diagnostic is checked upstream.
    if (visiting.has(key)) return { ref: item.ref, item, children: [] };
    const nextVisiting = new Set(visiting);
    nextVisiting.add(key);
    const childKeys = childKeysByParent.get(key) ?? [];
    return {
      ref: item.ref,
      item,
      children: childKeys.map((childKey) => buildNode(childKey, nextVisiting)),
    };
  }

  const scheduleRootKeysBySchedule = new Map<string, string[]>();
  const assignedItemKeys = new Set<string>();
  for (const rel of graph.Relationships) {
    if (rel.Type !== 'IfcRelAssignsToControl' || !rel.RelatingControl) continue;
    const controlKey = refKey(rel.RelatingControl);
    if (!schedulesByKey.has(controlKey)) continue;
    const list = scheduleRootKeysBySchedule.get(controlKey) ?? [];
    for (const related of rel.RelatedObjects ?? []) {
      const relatedKey = refKey(related);
      if (!itemsByKey.has(relatedKey)) continue;
      list.push(relatedKey);
      assignedItemKeys.add(relatedKey);
    }
    scheduleRootKeysBySchedule.set(controlKey, list);
  }

  const schedules: CostTreeScheduleNode[] = graph.CostSchedules.map((schedule) => {
    const key = refKey(schedule.ref);
    const rootKeys = scheduleRootKeysBySchedule.get(key) ?? [];
    return {
      ref: schedule.ref,
      schedule,
      items: rootKeys.map((rootKey) => buildNode(rootKey, new Set())),
    };
  });

  const unassignedItems: CostTreeItemNode[] = [];
  for (const item of graph.CostItems) {
    const key = refKey(item.ref);
    if (assignedItemKeys.has(key) || nestedChildKeys.has(key)) continue;
    unassignedItems.push(buildNode(key, new Set()));
  }

  return { schedules, unassignedItems };
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
    if (rel.Type !== 'IfcRelAssignsToControl' || !rel.RelatingControl) continue;
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
