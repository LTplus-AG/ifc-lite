/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loaded-model cost authoring (#4857 PR A) — `bim.store.addCost*` / `nestCostItems`
 * / `assignCostItemsToSchedule` / `assignToCostItem` / `setCostItemValues` /
 * `removeCostEntity`. The counterpart of `ifc-creator-cost.ts` for a model
 * that is already parsed and loaded rather than being built from scratch:
 * same validation (`cost-authoring-rules.ts`, shared so a value illegal from
 * one entry point is illegal from the other), different serialization —
 * `StoreEditor.addEntity` takes a typed attribute array, not raw STEP text.
 *
 * Pure: no I/O, no parser access, no read of the store's OWN existing graph.
 * `nestCostItemsInStore` (reparenting) and `removeCostEntityInStore`
 * (safe-delete / cascade) both need to know what ALREADY references an
 * entity, which only a graph READ can answer — the caller resolves referrers
 * first and hands them in. The editor is the only mutable thing touched.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor, IfcAttributeValue } from '@ifc-lite/mutations';
import { ownerHistoryRef } from './_emit-helpers.js';
import {
  requireAssignableIfcObjectDefinition, requireEntitySubtype, requireEntityType, requireEntityTypeOneOf,
} from './cost-reference-validation.js';
import {
  ARITHMETIC_OPERATORS, COST_ITEM_TYPES, COST_SCHEDULE_TYPES, QUANTITY_KINDS,
  assertCostSchema, assertOneOf, requireRef, validateRefList, validateTypedValue,
  type CostSchema, type CostTypedValueInput,
} from '../cost-authoring-rules.js';
import type {
  CostItemParams, CostQuantityParams, CostScheduleParams, CostValueParams,
} from '../types-cost.js';

/** What `nestCostItemsInStore` / `assign*InStore` / `removeCostEntityInStore` need to
 *  reparent or detach cleanly — the model's owner history and target schema. */
export interface CostAnchor {
  /** IfcOwnerHistory expressId, or null when the model has none (written as `$`). */
  ownerHistoryId: number | null;
  /** Target schema; IFC2X3 is refused (see `assertCostSchema`). Defaults to `'IFC4'`. */
  schema?: CostSchema;
  /** Optional seeded randomness for authored GlobalIds — see `SpatialAnchor.guidRandom`. */
  guidRandom?: RandomSource;
}

function schemaOf(anchor: CostAnchor): CostSchema {
  return anchor.schema ?? 'IFC4';
}

/** `IfcCostValue.Components` / `IfcAppliedValueSelect`'s entity branches: another cost/applied value. */
const APPLIED_VALUE_ENTITY_TYPES: ReadonlySet<string> = new Set(['IFCCOSTVALUE', 'IFCAPPLIEDVALUE']);
/** The entity branches of IFC4/IFC4X3 IfcAppliedValueSelect. */
const APPLIED_VALUE_REF_TYPES: ReadonlySet<string> = new Set(['IFCMEASUREWITHUNIT', 'IFCREFERENCE']);
function typedAttrValue(value: CostTypedValueInput, schema: CostSchema, context: string): IfcAttributeValue {
  validateTypedValue(value, schema, context);
  return { typed: { type: value.Type, value: value.Value } };
}

function refListAttr(ids: number[] | undefined): IfcAttributeValue {
  return ids === undefined ? null : ids.map(id => `#${id}`);
}

/**
 * Emit an `IfcCostSchedule` into the loaded model's overlay.
 *
 * [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description, [4] ObjectType,
 * [5] Identification, [6] PredefinedType, [7] Status, [8] SubmittedOn,
 * [9] UpdateDate — same IFC4 layout `emitCostSchedule` writes; refused for
 * IFC2X3 (different layout, see `assertCostSchema`).
 */
export function addCostScheduleToStore(editor: StoreEditor, anchor: CostAnchor, params: CostScheduleParams): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, 'addCostSchedule');
  if (typeof params.Name !== 'string' || params.Name.length === 0) {
    throw new Error('addCostSchedule: Name is required');
  }
  assertOneOf(params.PredefinedType, COST_SCHEDULE_TYPES, 'PredefinedType', 'addCostSchedule');
  return editor.addEntity('IfcCostSchedule', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name,
    params.Description ?? null,
    params.ObjectType ?? null,
    params.Identification ?? null,
    params.PredefinedType ? `.${params.PredefinedType}.` : null,
    params.Status ?? null,
    params.SubmittedOn ?? null,
    params.UpdateDate ?? null,
  ]).expressId;
}

/**
 * Emit an `IfcCostItem`. [0] GlobalId, [1] OwnerHistory, [2] Name,
 * [3] Description, [4] ObjectType, [5] Identification, [6] PredefinedType,
 * [7] CostValues, [8] CostQuantities — an empty `CostValues`/`CostQuantities`
 * array is refused (EXPRESS `[1:?]`); use `attachCostValuesToItemInStore` to
 * attach them after the fact instead.
 */
export function addCostItemToStore(editor: StoreEditor, anchor: CostAnchor, params: CostItemParams): number {
  const schema = schemaOf(anchor);
  const costValues = params.CostValues === undefined ? undefined : [...new Set(params.CostValues)];
  const costQuantities = params.CostQuantities === undefined ? undefined : [...new Set(params.CostQuantities)];
  assertCostSchema(schema, 'addCostItem');
  if (typeof params.Name !== 'string' || params.Name.length === 0) {
    throw new Error('addCostItem: Name is required');
  }
  assertOneOf(params.PredefinedType, COST_ITEM_TYPES, 'PredefinedType', 'addCostItem');
  validateRefList(costValues, 'CostValues', 'addCostItem');
  validateRefList(costQuantities, 'CostQuantities', 'addCostItem');
  for (const id of costValues ?? []) requireEntityType(editor, id, 'IfcCostValue', 'CostValues', 'addCostItem');
  for (const id of costQuantities ?? []) {
    requireEntitySubtype(editor, id, 'IfcPhysicalQuantity', 'CostQuantities', 'addCostItem');
  }
  return editor.addEntity('IfcCostItem', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name,
    params.Description ?? null,
    params.ObjectType ?? null,
    params.Identification ?? null,
    params.PredefinedType ? `.${params.PredefinedType}.` : null,
    refListAttr(costValues),
    refListAttr(costQuantities),
  ]).expressId;
}

/**
 * Emit an `IfcCostValue`. [0] Name, [1] Description, [2] AppliedValue,
 * [3] UnitBasis, [4] ApplicableDate, [5] FixedUntilDate, [6] Category,
 * [7] Condition, [8] ArithmeticOperator, [9] Components.
 *
 * `AppliedValue` and `AppliedValueRef` are the two branches of one SELECT —
 * at most one may be given (mirrors `emitCostValue`).
 */
export function addCostValueToStore(editor: StoreEditor, anchor: CostAnchor, params: CostValueParams): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, 'addCostValue');
  if (params.AppliedValue !== undefined && params.AppliedValueRef !== undefined) {
    throw new Error('addCostValue: AppliedValue and AppliedValueRef are the two branches of one SELECT — give at most one');
  }
  assertOneOf(params.ArithmeticOperator, ARITHMETIC_OPERATORS, 'ArithmeticOperator', 'addCostValue');
  let applied: IfcAttributeValue = null;
  if (params.AppliedValue !== undefined) {
    applied = typedAttrValue(params.AppliedValue, schema, 'addCostValue');
  } else if (params.AppliedValueRef !== undefined) {
    requireRef(params.AppliedValueRef, 'AppliedValueRef', 'addCostValue');
    requireEntityTypeOneOf(editor, params.AppliedValueRef, APPLIED_VALUE_REF_TYPES, 'AppliedValueRef', 'addCostValue');
    applied = `#${params.AppliedValueRef}`;
  }
  if (params.UnitBasis !== undefined) {
    requireRef(params.UnitBasis, 'UnitBasis', 'addCostValue');
    requireEntityType(editor, params.UnitBasis, 'IfcMeasureWithUnit', 'UnitBasis', 'addCostValue');
  }
  validateRefList(params.Components, 'Components', 'addCostValue');
  for (const id of params.Components ?? []) requireEntityTypeOneOf(editor, id, APPLIED_VALUE_ENTITY_TYPES, 'Components', 'addCostValue');
  return editor.addEntity('IfcCostValue', [
    params.Name ?? null,
    params.Description ?? null,
    applied,
    params.UnitBasis === undefined ? null : `#${params.UnitBasis}`,
    params.ApplicableDate ?? null,
    params.FixedUntilDate ?? null,
    params.Category ?? null,
    params.Condition ?? null,
    params.ArithmeticOperator ? `.${params.ArithmeticOperator}.` : null,
    refListAttr(params.Components),
  ]).expressId;
}

/**
 * Emit an `IfcPhysicalSimpleQuantity` (the same subtypes `emitPhysicalQuantity`
 * writes), for `IfcCostItem.CostQuantities`. [0] Name, [1] Description,
 * [2] Unit, [3] `<Kind>Value`, [4] Formula.
 */
export function addCostQuantityToStore(editor: StoreEditor, anchor: CostAnchor, params: CostQuantityParams): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, 'addCostQuantity');
  if (typeof params.Name !== 'string' || params.Name.length === 0) {
    throw new Error('addCostQuantity: Name is required');
  }
  assertOneOf(params.Kind, QUANTITY_KINDS, 'Kind', 'addCostQuantity');
  if (!Number.isFinite(params.Value)) throw new Error(`addCostQuantity: ${params.Kind} value must be a finite number`);
  if (params.Kind === 'IfcQuantityNumber' && schema !== 'IFC4X3') {
    throw new Error(`addCostQuantity: ${params.Kind} does not exist in ${schema}; requires Schema "IFC4X3"`);
  }
  if (params.Kind !== 'IfcQuantityNumber' && params.Value < 0) {
    throw new Error(`addCostQuantity: ${params.Kind} value must be non-negative, got ${params.Value}`);
  }
  if (params.Unit !== undefined) {
    requireRef(params.Unit, 'Unit', 'addCostQuantity');
    requireEntitySubtype(editor, params.Unit, 'IfcNamedUnit', 'Unit', 'addCostQuantity');
  }
  const isInteger = params.Kind === 'IfcQuantityCount' && schema === 'IFC4X3';
  if (isInteger && !Number.isInteger(params.Value)) {
    throw new Error(`addCostQuantity: ${params.Kind} value must be a finite integer in IFC4X3`);
  }
  return editor.addEntity(params.Kind, [
    params.Name,
    params.Description ?? null,
    params.Unit === undefined ? null : `#${params.Unit}`,
    isInteger ? params.Value : { real: params.Value },
    params.Formula ?? null,
  ]).expressId;
}

/** One relationship the caller already found referencing an id, so the builders below
 *  never need to scan the store themselves — see the module header. */
export interface ExistingRelatedList {
  relId: number;
  /** The relationship's RelatingObject, when the caller is supplying a nesting graph. */
  relatingId?: number;
  /** The relationship's current RelatedObjects (or Components), in file order. */
  relatedIds: readonly number[];
  /**
   * When a controller legally has MORE THAN ONE relationship of this kind
   * (e.g. two separate `IfcRelAssignsToControl` records for the same
   * schedule), every member across ALL of them — used only to decide which
   * requested ids are genuinely new, never as the list written back. Writing
   * this union into `relId`'s own slot would copy a secondary relationship's
   * members into the primary one, duplicating membership while leaving the
   * secondary relationship untouched. Defaults to `relatedIds` when absent
   * (the single-relationship case, where the two are the same set).
   */
  allMemberIds?: readonly number[];
}

/**
 * Nest `childIds` under `parentId` as `IfcRelNests.RelatedObjects` (slot 5),
 * `RelatingObject` = parent.
 *
 * A child already nested under one or more DIFFERENT `IfcRelNests` is
 * reparented: it is removed from EVERY one of those rels' `RelatedObjects`
 * first (a file may legally list a child under more than one nest —
 * `MULTIPLE_NESTING_PARENTS` is a diagnostic, not a refusal — so detaching
 * from only the first one found would leave it still nested under the rest),
 * tombstoning a rel if that empties it (`RelatedObjects` is `[1:?]`, so an
 * emptied list cannot be left as `()`), then added to (or its own new) the
 * target rel.
 */
export function nestCostItemsInStore(
  editor: StoreEditor,
  anchor: CostAnchor,
  parentId: number,
  childIds: number[],
  existingNestByChild: ReadonlyMap<number, readonly ExistingRelatedList[]>,
  existingTargetNest?: ExistingRelatedList,
): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, 'nestCostItems');
  validateRefList(childIds, 'childIds', 'nestCostItems');
  requireRef(parentId, 'parentId', 'nestCostItems');
  if (childIds.includes(parentId)) {
    throw new Error(`nestCostItems: parentId #${parentId} cannot also be one of childIds (an item cannot nest itself)`);
  }
  requireEntityType(editor, parentId, 'IfcCostItem', 'parentId', 'nestCostItems');
  // De-duplicated once: every use below (the reparent scan, the merge, the
  // freshly-created rel's own RelatedObjects) reads from this, not childIds
  // — a repeated id in the caller's list must not write a repeated #N into a
  // list IFC readers count members of.
  const uniqueChildIds = [...new Set(childIds)];
  for (const childId of uniqueChildIds) requireEntityType(editor, childId, 'IfcCostItem', 'childId', 'nestCostItems');
  // Walk from the proposed parent toward its existing ancestors. If one of
  // the requested children is already above it, adding parent -> child would
  // close a cycle. `relatingId` is optional for compatibility with callers
  // that only supply the relationship's member list; the high-level SDK
  // supplies it for every existing IfcRelNests row.
  const requested = new Set(uniqueChildIds);
  const visitedAncestors = new Set<number>();
  const ancestors = [parentId];
  while (ancestors.length > 0) {
    const current = ancestors.pop()!;
    if (visitedAncestors.has(current)) continue;
    visitedAncestors.add(current);
    for (const membership of existingNestByChild.get(current) ?? []) {
      if (membership.relatingId === undefined) continue;
      if (requested.has(membership.relatingId)) {
        throw new Error(
          `nestCostItems: parentId #${parentId} is already a descendant of childId #${membership.relatingId} `
          + 'in the existing nesting hierarchy — nesting it here would create a cycle.',
        );
      }
      ancestors.push(membership.relatingId);
    }
  }
  // Detach every child of THIS call from every old rel it is a member of, one
  // rewrite per (rel, not per (rel, child)): two children reparented out of
  // the same old IfcRelNests in one call must both leave it, and re-filtering
  // the ORIGINAL (unchanged) relatedIds on each iteration would make the
  // second child's rewrite silently undo the first child's removal.
  const detachedRelIds = new Set<number>();
  for (const childId of uniqueChildIds) {
    for (const existing of existingNestByChild.get(childId) ?? []) {
      if (existing.relId === existingTargetNest?.relId || detachedRelIds.has(existing.relId)) continue;
      detachedRelIds.add(existing.relId);
      const remaining = existing.relatedIds.filter(id => !uniqueChildIds.includes(id));
      if (remaining.length === 0) editor.removeEntity(existing.relId);
      else editor.setPositionalAttribute(existing.relId, 5, remaining.map(id => `#${id}`));
    }
  }
  if (existingTargetNest) {
    const merged = [...new Set([...existingTargetNest.relatedIds, ...uniqueChildIds])];
    editor.setPositionalAttribute(existingTargetNest.relId, 5, merged.map(id => `#${id}`));
    return existingTargetNest.relId;
  }
  return editor.addEntity('IfcRelNests', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    null,
    null,
    `#${parentId}`,
    uniqueChildIds.map(id => `#${id}`),
  ]).expressId;
}

/**
 * Shared `IfcRelAssignsToControl` writer behind
 * `assignCostItemsToScheduleInStore` / `assignObjectsToCostItemInStore`:
 * [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description,
 * [4] RelatedObjects, [5] RelatedObjectsType, [6] RelatingControl. Appends to
 * `existingAssignment` when the controlling entity already has one, rather
 * than creating a second relationship for the same control.
 */
function assignToControlInStore(
  editor: StoreEditor,
  anchor: CostAnchor,
  relatingControlId: number,
  relatedObjectIds: number[],
  existingAssignment: ExistingRelatedList | undefined,
  context: string,
  controlType: string,
  relatedType?: string,
): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, context);
  validateRefList(relatedObjectIds, 'relatedObjectIds', context);
  requireRef(relatingControlId, 'relatingControlId', context);
  requireEntityType(editor, relatingControlId, controlType, 'relatingControlId', context);
  // De-duplicated once so a repeated id in the caller's list can't write a
  // repeated #N into RelatedObjects — a caller-visible malformed member list.
  const uniqueRelated = [...new Set(relatedObjectIds)];
  for (const id of uniqueRelated) {
    if (relatedType === 'IfcObjectDefinition') {
      requireAssignableIfcObjectDefinition(editor, id, relatingControlId, context);
    } else if (relatedType) {
      requireEntityType(editor, id, relatedType, 'relatedObjectIds', context);
    } else if (!editor.hasEntity(id)) {
      throw new Error(`${context}: relatedObjectIds #${id} does not exist in this model`);
    }
  }
  if (existingAssignment) {
    // Filter against the union across every relationship for this control
    // (a member of a DIFFERENT one is not re-added), but merge only into
    // THIS rel's own list — never the union itself, which would copy a
    // secondary relationship's members into the primary one.
    const alreadyMember = new Set(existingAssignment.allMemberIds ?? existingAssignment.relatedIds);
    const toAdd = uniqueRelated.filter(id => !alreadyMember.has(id));
    if (toAdd.length === 0) return existingAssignment.relId;
    const merged = [...existingAssignment.relatedIds, ...toAdd];
    editor.setPositionalAttribute(existingAssignment.relId, 4, merged.map(id => `#${id}`));
    return existingAssignment.relId;
  }
  return editor.addEntity('IfcRelAssignsToControl', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    null,
    null,
    uniqueRelated.map(id => `#${id}`),
    null,
    `#${relatingControlId}`,
  ]).expressId;
}

/** Assign `itemIds` (IfcCostItem) to `scheduleId` (IfcCostSchedule) as its controlled objects. */
export function assignCostItemsToScheduleInStore(
  editor: StoreEditor, anchor: CostAnchor, scheduleId: number, itemIds: number[],
  existingAssignment?: ExistingRelatedList,
): number {
  return assignToControlInStore(
    editor, anchor, scheduleId, itemIds, existingAssignment, 'assignCostItemsToSchedule', 'IfcCostSchedule', 'IfcCostItem',
  );
}

/**
 * Assign IFC objects (products, tasks, resources, etc.) to a cost item.
 * The controlling item itself is not a legal related member.
 */
export function assignObjectsToCostItemInStore(
  editor: StoreEditor, anchor: CostAnchor, costItemId: number, objectIds: number[],
  existingAssignment?: ExistingRelatedList,
): number {
  return assignToControlInStore(editor, anchor, costItemId, objectIds, existingAssignment,
    'assignToCostItem', 'IfcCostItem', 'IfcObjectDefinition');
}

/**
 * Set (replace) `itemId`'s `IfcCostItem.CostValues` (slot 7). `valueIds` is
 * REQUIRED, not optional: an empty array is how a caller CLEARS the list,
 * written as `$` — never `()`, which `[1:?]` forbids.
 */
export function attachCostValuesToItemInStore(
  editor: StoreEditor,
  anchor: CostAnchor,
  itemId: number,
  valueIds: readonly number[],
): void {
  assertCostSchema(schemaOf(anchor), 'setCostItemValues');
  requireEntityType(editor, itemId, 'IfcCostItem', 'itemId', 'setCostItemValues');
  for (const id of valueIds) {
    requireRef(id, 'CostValues', 'setCostItemValues');
    requireEntityType(editor, id, 'IfcCostValue', 'CostValues', 'setCostItemValues');
  }
  // De-duplicated (SET semantics, first occurrence kept), like every other
  // list writer here (nestCostItemsInStore's childIds, assignToControlInStore's
  // relatedObjectIds, …) — a repeated id must not write a repeated #N into a
  // list the evaluator sums over (setCostItemValues([v, v]) would otherwise
  // double-count that value).
  const uniqueValueIds = [...new Set(valueIds)];
  editor.setPositionalAttribute(itemId, 7, uniqueValueIds.length === 0 ? null : uniqueValueIds.map(id => `#${id}`));
}
