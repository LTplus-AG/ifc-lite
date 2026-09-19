/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addCost*` / `nestCostItems` / `assignCostItemsToSchedule` /
 * `assignToCostItem` / `setCostItemValues` / `removeCostEntity` (#4857 PR A) —
 * the host-agnostic implementation of `CostStoreBackendMethods`. A host
 * (CLI/MCP headless backend, viewer adapter, sandbox bridge) wires this in by
 * supplying a resolver for its own model bookkeeping; the reparent / append /
 * safe-delete bookkeeping that needs to know what ALREADY references an
 * entity is done here ONCE, by reading the same `bim.cost` graph every other
 * cost consumer reads (mutation-aware, so a rel created earlier in the same
 * session is seen by the next call) — the in-store builders themselves
 * (`@ifc-lite/create`) stay pure and know nothing of the graph (see
 * `in-store/cost.ts`'s module header for why that split exists).
 */

import {
  addCostItemToStore, addCostQuantityToStore, addCostScheduleToStore, addCostValueToStore,
  assignCostItemsToScheduleInStore, assignObjectsToCostItemInStore, attachCostValuesToItemInStore,
  nestCostItemsInStore, removeCostEntityInStore,
  type CostAnchor, type CostItemParams, type CostQuantityParams, type CostRemovalReferrers,
  type CostScheduleParams, type CostValueParams, type ExistingRelatedList,
} from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityRef } from './types.js';
import type { CostStoreBackendMethods } from './store-cost-types.js';
import type { CostBackendMethods } from './cost-types.js';
import type { CostGraphData } from './cost-types.js';

/** What a host resolves per call: the model's store, its `StoreEditor` (already
 *  wired to the same `MutablePropertyView` `bim.cost` reads), and its owner history. */
export interface CostStoreModelResolution {
  modelId: string;
  store: IfcDataStore;
  editor: StoreEditor;
  ownerHistoryId: number | null;
}

export type CostStoreModelResolver = (modelId?: string) => CostStoreModelResolution;

function ref(modelId: string, expressId: number): EntityRef { return { modelId, expressId }; }

function anchorOf(resolved: CostStoreModelResolution): CostAnchor {
  return { ownerHistoryId: resolved.ownerHistoryId, schema: (resolved.store.schemaVersion as CostAnchor['schema']) ?? 'IFC4' };
}

/**
 * Every `IfcRelNests`, keyed both by parent (RelatingObject) and — as the
 * FULL LIST of every rel a child is a member of, not just one — by each
 * child. A file can legally list the same child under more than one
 * `IfcRelNests` (`MULTIPLE_NESTING_PARENTS` is a diagnostic, not a refusal),
 * and a reparent has to detach it from ALL of them or it stays nested under
 * whichever one this map happened to keep.
 */
function findNests(graph: CostGraphData) {
  const byParent = new Map<number, ExistingRelatedList>();
  const byChild = new Map<number, ExistingRelatedList[]>();
  for (const rel of graph.Relationships) {
    if (rel.Type !== 'IfcRelNests' || !rel.RelatingObject || !rel.RelatedObjects) continue;
    const entry: ExistingRelatedList = { relId: rel.ref.expressId, relatedIds: rel.RelatedObjects.map(r => r.expressId) };
    byParent.set(rel.RelatingObject.expressId, entry);
    for (const child of entry.relatedIds) {
      const list = byChild.get(child);
      if (list) list.push(entry); else byChild.set(child, [entry]);
    }
  }
  return { byParent, byChild };
}

/**
 * The `IfcRelAssignsToControl` whose `RelatingControl` is `controlId` to
 * append new assignments to (the first one found, if more than one exists —
 * `IfcRelAssignsToControl` does not forbid a controller having several), with
 * `relatedIds` the UNION across every one of them. Appending against the
 * union, not just the primary rel's own list, is what keeps a caller from
 * assigning an id that is already listed in a DIFFERENT rel for the same
 * controller a second time.
 */
function findControlAssignment(graph: CostGraphData, controlId: number): ExistingRelatedList | undefined {
  let primaryRelId: number | undefined;
  const union = new Set<number>();
  for (const rel of graph.Relationships) {
    if (rel.Type !== 'IfcRelAssignsToControl' || rel.RelatingControl?.expressId !== controlId) continue;
    if (primaryRelId === undefined) primaryRelId = rel.ref.expressId;
    for (const related of rel.RelatedObjects ?? []) union.add(related.expressId);
  }
  return primaryRelId === undefined ? undefined : { relId: primaryRelId, relatedIds: [...union] };
}

/** Every existing reference to `expressId` the cost graph currently reports — the safe-delete input. */
function buildRemovalReferrers(graph: CostGraphData, expressId: number): CostRemovalReferrers {
  const itemCostValues = new Map<number, readonly number[]>();
  for (const item of graph.CostItems) {
    const ids = (item.CostValues ?? []).map(r => r.expressId);
    if (ids.includes(expressId)) itemCostValues.set(item.ref.expressId, ids);
  }
  const valueComponents = new Map<number, readonly number[]>();
  const valueAppliedValueRef = new Map<number, number>();
  for (const value of graph.CostValues) {
    const ids = (value.Components ?? []).map(r => r.expressId);
    if (ids.includes(expressId)) valueComponents.set(value.ref.expressId, ids);
    // AppliedValue's `Reference` branch is IfcCostValue.AppliedValue pointing
    // at an IfcMeasureWithUnit (or another IfcAppliedValue) THROUGH
    // AppliedValueRef — a single required-when-present attribute, not a list,
    // but still a live reference this deletion must not leave dangling.
    if (value.AppliedValue?.Kind === 'Reference' && value.AppliedValue.ref.expressId === expressId) {
      valueAppliedValueRef.set(value.ref.expressId, expressId);
    }
  }
  const nestRelatedObjects = new Map<number, readonly number[]>();
  const assignmentRelatedObjects = new Map<number, readonly number[]>();
  const nestsAsParent: number[] = [];
  const assignmentsAsControl: number[] = [];
  const otherRelationships: number[] = [];
  for (const rel of graph.Relationships) {
    const related = (rel.RelatedObjects ?? []).map(r => r.expressId);
    if (rel.Type === 'IfcRelNests') {
      if (related.includes(expressId)) nestRelatedObjects.set(rel.ref.expressId, related);
      if (rel.RelatingObject?.expressId === expressId) nestsAsParent.push(rel.ref.expressId);
      continue;
    }
    if (rel.Type === 'IfcRelAssignsToControl') {
      if (related.includes(expressId)) assignmentRelatedObjects.set(rel.ref.expressId, related);
      if (rel.RelatingControl?.expressId === expressId) assignmentsAsControl.push(rel.ref.expressId);
      continue;
    }
    // Every OTHER cost relationship type the reader enumerates
    // (IfcRelAssignsToProduct, IfcRelAssignsToProcess, IfcRelDeclares,
    // IfcRelAssociatesAppliedValue, IfcRelSchedulesCostItems,
    // IfcAppliedValueRelationship, and any future subtype the reader adds) —
    // walked generically over every reference-bearing field `graph.Relationships`
    // already exposes, not a hand list of types, so a new subtype the cost
    // reader starts enumerating is covered automatically rather than silently
    // missed. See CostRemovalReferrers.otherRelationships for why these are
    // never partially rewritten.
    const scalarRefs = [
      rel.RelatingObject, rel.RelatingControl, rel.RelatingProduct, rel.RelatingProcess,
      rel.RelatingContext, rel.RelatingAppliedValue, rel.ComponentOfTotal,
    ];
    const listRefs = [...related, ...(rel.RelatedDefinitions ?? []).map(r => r.expressId), ...(rel.Components ?? []).map(r => r.expressId)];
    const references = scalarRefs.some(r => r?.expressId === expressId) || listRefs.includes(expressId);
    if (references) otherRelationships.push(rel.ref.expressId);
  }
  return {
    itemCostValues, valueComponents, valueAppliedValueRef, nestRelatedObjects, assignmentRelatedObjects,
    nestsAsParent, assignmentsAsControl, otherRelationships,
  };
}

/** The cost-graph kind `expressId` names, or `undefined` when it is not a cost entity at all. */
function costKindOf(graph: CostGraphData, expressId: number): 'IfcCostSchedule' | 'IfcCostItem' | 'IfcCostValue' | undefined {
  if (graph.CostSchedules.some(s => s.ref.expressId === expressId)) return 'IfcCostSchedule';
  if (graph.CostItems.some(i => i.ref.expressId === expressId)) return 'IfcCostItem';
  if (graph.CostValues.some(v => v.ref.expressId === expressId)) return 'IfcCostValue';
  return undefined;
}

/** Values referenced ONLY by `itemId`'s own `CostValues` — the cascade-delete set for removing that item. */
function cascadeValuesForItem(graph: CostGraphData, itemId: number): number[] {
  const item = graph.CostItems.find(i => i.ref.expressId === itemId);
  const ownValues = (item?.CostValues ?? []).map(r => r.expressId);
  return ownValues.filter(valueId => {
    const referencedElsewhere =
      graph.CostItems.some(other => other.ref.expressId !== itemId && (other.CostValues ?? []).some(r => r.expressId === valueId))
      || graph.CostValues.some(v => (v.Components ?? []).some(r => r.expressId === valueId));
    return !referencedElsewhere;
  });
}

/**
 * Build `bim.store`'s cost-authoring methods. `cost` is the model's
 * `CostBackendMethods` (from `createCostBackend`) — reads through it are
 * always mutation-aware (`includeMutations: true`) so a rel this session
 * already authored is visible to the very next authoring call.
 */
export function createCostStoreBackend(
  resolve: CostStoreModelResolver, cost: Pick<CostBackendMethods, 'data'>,
): CostStoreBackendMethods {
  const graphOf = (modelId: string): CostGraphData => cost.data(modelId, { includeMutations: true });

  return {
    addCostSchedule(modelId: string, params: CostScheduleParams): EntityRef {
      const resolved = resolve(modelId);
      return ref(resolved.modelId, addCostScheduleToStore(resolved.editor, anchorOf(resolved), params));
    },
    addCostItem(modelId: string, params: CostItemParams): EntityRef {
      const resolved = resolve(modelId);
      return ref(resolved.modelId, addCostItemToStore(resolved.editor, anchorOf(resolved), params));
    },
    addCostValue(modelId: string, params: CostValueParams): EntityRef {
      const resolved = resolve(modelId);
      return ref(resolved.modelId, addCostValueToStore(resolved.editor, anchorOf(resolved), params));
    },
    addCostQuantity(modelId: string, params: CostQuantityParams): EntityRef {
      const resolved = resolve(modelId);
      return ref(resolved.modelId, addCostQuantityToStore(resolved.editor, anchorOf(resolved), params));
    },
    nestCostItems(modelId: string, parentExpressId: number, childExpressIds: number[]): EntityRef {
      const resolved = resolve(modelId);
      const { byChild, byParent } = findNests(graphOf(resolved.modelId));
      const relId = nestCostItemsInStore(
        resolved.editor, anchorOf(resolved), parentExpressId, childExpressIds, byChild, byParent.get(parentExpressId),
      );
      return ref(resolved.modelId, relId);
    },
    assignCostItemsToSchedule(modelId: string, scheduleExpressId: number, itemExpressIds: number[]): EntityRef {
      const resolved = resolve(modelId);
      const existing = findControlAssignment(graphOf(resolved.modelId), scheduleExpressId);
      const relId = assignCostItemsToScheduleInStore(resolved.editor, anchorOf(resolved), scheduleExpressId, itemExpressIds, existing);
      return ref(resolved.modelId, relId);
    },
    assignToCostItem(modelId: string, costItemExpressId: number, objectExpressIds: number[]): EntityRef {
      const resolved = resolve(modelId);
      const existing = findControlAssignment(graphOf(resolved.modelId), costItemExpressId);
      const relId = assignObjectsToCostItemInStore(resolved.editor, anchorOf(resolved), costItemExpressId, objectExpressIds, existing);
      return ref(resolved.modelId, relId);
    },
    setCostItemValues(modelId: string, itemExpressId: number, valueExpressIds: number[]): void {
      const resolved = resolve(modelId);
      attachCostValuesToItemInStore(resolved.editor, itemExpressId, valueExpressIds);
    },
    removeCostEntity(modelId: string, expressId: number, options?: { detach?: boolean }): void {
      const resolved = resolve(modelId);
      const graph = graphOf(resolved.modelId);
      const kind = costKindOf(graph, expressId);
      if (!kind) {
        throw new Error(
          `removeCostEntity: #${expressId} is not an IfcCostSchedule/IfcCostItem/IfcCostValue in this model's cost `
          + 'graph — this method only removes cost entities; use bim.store.removeEntity for anything else.');
      }
      const referrers = buildRemovalReferrers(graph, expressId);
      const cascadeValueIds = kind === 'IfcCostItem' ? cascadeValuesForItem(graph, expressId) : [];
      removeCostEntityInStore(resolved.editor, anchorOf(resolved), expressId, referrers, { detach: options?.detach, cascadeValueIds });
    },
  };
}
