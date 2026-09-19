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
 * entity, which only a graph READ can answer — `@ifc-lite/create` cannot
 * depend on `@ifc-lite/parser`'s cost reader without a package cycle, so the
 * caller (the SDK's `bim.store` backend, which already reads the cost graph
 * for `bim.cost`) resolves referrers first and hands them in. This mirrors
 * `spatial-zone.ts`'s "operates entirely through the editor" contract: the
 * editor is still the only mutable thing these functions touch.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor, IfcAttributeValue } from '@ifc-lite/mutations';
import { ownerHistoryRef } from './_emit-helpers.js';
import {
  ARITHMETIC_OPERATORS, COST_ITEM_TYPES, COST_SCHEDULE_TYPES,
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
  assertCostSchema(schema, 'addCostItem');
  if (typeof params.Name !== 'string' || params.Name.length === 0) {
    throw new Error('addCostItem: Name is required');
  }
  assertOneOf(params.PredefinedType, COST_ITEM_TYPES, 'PredefinedType', 'addCostItem');
  validateRefList(params.CostValues, 'CostValues', 'addCostItem');
  validateRefList(params.CostQuantities, 'CostQuantities', 'addCostItem');
  return editor.addEntity('IfcCostItem', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name,
    params.Description ?? null,
    params.ObjectType ?? null,
    params.Identification ?? null,
    params.PredefinedType ? `.${params.PredefinedType}.` : null,
    refListAttr(params.CostValues),
    refListAttr(params.CostQuantities),
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
    applied = `#${params.AppliedValueRef}`;
  }
  if (params.UnitBasis !== undefined) requireRef(params.UnitBasis, 'UnitBasis', 'addCostValue');
  validateRefList(params.Components, 'Components', 'addCostValue');
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
  if (!Number.isFinite(params.Value)) throw new Error(`addCostQuantity: ${params.Kind} value must be a finite number`);
  if (params.Kind === 'IfcQuantityNumber' && schema !== 'IFC4X3') {
    throw new Error(`addCostQuantity: ${params.Kind} does not exist in ${schema}; requires Schema "IFC4X3"`);
  }
  if (params.Kind !== 'IfcQuantityNumber' && params.Value < 0) {
    throw new Error(`addCostQuantity: ${params.Kind} value must be non-negative, got ${params.Value}`);
  }
  if (params.Unit !== undefined) requireRef(params.Unit, 'Unit', 'addCostQuantity');
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
  /** The relationship's current RelatedObjects (or Components), in file order. */
  relatedIds: readonly number[];
}

/**
 * Nest `childIds` under `parentId` as `IfcRelNests.RelatedObjects` (slot 5),
 * `RelatingObject` = parent.
 *
 * A child already nested under a DIFFERENT `IfcRelNests` is reparented: it is
 * removed from that rel's `RelatedObjects` first (tombstoning the rel if that
 * empties it — `RelatedObjects` is `[1:?]`, so an emptied list cannot be left
 * as `()`), then added to (or its own new) the target rel.
 */
export function nestCostItemsInStore(
  editor: StoreEditor,
  anchor: CostAnchor,
  parentId: number,
  childIds: number[],
  existingNestByChild: ReadonlyMap<number, ExistingRelatedList>,
  existingTargetNest?: ExistingRelatedList,
): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, 'nestCostItems');
  validateRefList(childIds, 'childIds', 'nestCostItems');
  requireRef(parentId, 'parentId', 'nestCostItems');
  // Detach every child of THIS call from its old rel in one rewrite per rel,
  // not one rewrite per child: two children reparented out of the same old
  // IfcRelNests in one call must both leave it, and re-filtering the
  // ORIGINAL (unchanged) relatedIds on each iteration would make the second
  // child's rewrite silently undo the first child's removal.
  const detachedRelIds = new Set<number>();
  for (const childId of childIds) {
    const existing = existingNestByChild.get(childId);
    if (!existing || existing.relId === existingTargetNest?.relId || detachedRelIds.has(existing.relId)) continue;
    detachedRelIds.add(existing.relId);
    const remaining = existing.relatedIds.filter(id => !childIds.includes(id));
    if (remaining.length === 0) editor.removeEntity(existing.relId);
    else editor.setPositionalAttribute(existing.relId, 5, remaining.map(id => `#${id}`));
  }
  if (existingTargetNest) {
    const merged = [...new Set([...existingTargetNest.relatedIds, ...childIds])];
    editor.setPositionalAttribute(existingTargetNest.relId, 5, merged.map(id => `#${id}`));
    return existingTargetNest.relId;
  }
  return editor.addEntity('IfcRelNests', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    null,
    null,
    `#${parentId}`,
    childIds.map(id => `#${id}`),
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
): number {
  const schema = schemaOf(anchor);
  assertCostSchema(schema, context);
  validateRefList(relatedObjectIds, 'relatedObjectIds', context);
  requireRef(relatingControlId, 'relatingControlId', context);
  if (existingAssignment) {
    const merged = [...new Set([...existingAssignment.relatedIds, ...relatedObjectIds])];
    editor.setPositionalAttribute(existingAssignment.relId, 4, merged.map(id => `#${id}`));
    return existingAssignment.relId;
  }
  return editor.addEntity('IfcRelAssignsToControl', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    null,
    null,
    relatedObjectIds.map(id => `#${id}`),
    null,
    `#${relatingControlId}`,
  ]).expressId;
}

/** Assign `itemIds` (IfcCostItem) to `scheduleId` (IfcCostSchedule) as its controlled objects. */
export function assignCostItemsToScheduleInStore(
  editor: StoreEditor, anchor: CostAnchor, scheduleId: number, itemIds: number[],
  existingAssignment?: ExistingRelatedList,
): number {
  return assignToControlInStore(editor, anchor, scheduleId, itemIds, existingAssignment, 'assignCostItemsToSchedule');
}

/** Assign `objectIds` (products AND/OR tasks) to `costItemId` (IfcCostItem) as the objects it controls. */
export function assignObjectsToCostItemInStore(
  editor: StoreEditor, anchor: CostAnchor, costItemId: number, objectIds: number[],
  existingAssignment?: ExistingRelatedList,
): number {
  return assignToControlInStore(editor, anchor, costItemId, objectIds, existingAssignment, 'assignToCostItem');
}

/**
 * Set (replace) `itemId`'s `IfcCostItem.CostValues` (slot 7). `valueIds` is
 * REQUIRED, not optional: an empty array is how a caller CLEARS the list,
 * written as `$` — never `()`, which `[1:?]` forbids.
 */
export function attachCostValuesToItemInStore(editor: StoreEditor, itemId: number, valueIds: readonly number[]): void {
  for (const id of valueIds) requireRef(id, 'CostValues', 'setCostItemValues');
  editor.setPositionalAttribute(itemId, 7, valueIds.length === 0 ? null : valueIds.map(id => `#${id}`));
}

/** Every reference the caller found pointing at the entity being removed — see the module header. */
export interface CostRemovalReferrers {
  /** `IfcCostItem.CostValues` lists containing the target value, keyed by the item's expressId. */
  itemCostValues?: ReadonlyMap<number, readonly number[]>;
  /** `IfcCostValue.Components` lists containing the target value, keyed by the owning value's expressId. */
  valueComponents?: ReadonlyMap<number, readonly number[]>;
  /** `IfcRelNests.RelatedObjects` lists containing the target, keyed by the rel's expressId. */
  nestRelatedObjects?: ReadonlyMap<number, readonly number[]>;
  /** `IfcRelAssignsToControl.RelatedObjects` lists containing the target, keyed by the rel's expressId. */
  assignmentRelatedObjects?: ReadonlyMap<number, readonly number[]>;
  /**
   * `IfcRelNests` ids where the target IS `RelatingObject` — the target is a
   * NESTING PARENT. `RelatingObject` is a required (non-optional) attribute,
   * so the rel cannot be "detached" the way a `RelatedObjects` member can:
   * removing its parent leaves it referring to a tombstoned id, so the whole
   * rel is removed too.
   */
  nestsAsParent?: readonly number[];
  /**
   * `IfcRelAssignsToControl` ids where the target IS `RelatingControl` — the
   * target CONTROLS these objects (a schedule controlling items, or an item
   * controlling assigned products/tasks). Same reasoning as `nestsAsParent`:
   * `RelatingControl` is required, so the rel is removed, not rewritten.
   */
  assignmentsAsControl?: readonly number[];
}

/**
 * Safe-delete an `IfcCostSchedule` / `IfcCostItem` / `IfcCostValue`.
 *
 * A value still listed in another item's `CostValues` or another value's
 * `Components` is REFUSED — naming every referrer — unless
 * `options.detach` is set, in which case those lists are rewritten first
 * (never left as `()`; tombstoned as `$` when that empties them). Every
 * `IfcRelNests` / `IfcRelAssignsToControl` naming the target is detached the
 * same way (rel tombstoned when its own list would empty). `cascadeValueIds`
 * — values referenced ONLY by the entity being removed — are removed too.
 */
export function removeCostEntityInStore(
  editor: StoreEditor,
  anchor: CostAnchor,
  expressId: number,
  referrers: CostRemovalReferrers,
  options: { detach?: boolean; cascadeValueIds?: readonly number[] } = {},
): void {
  assertCostSchema(schemaOf(anchor), 'removeCostEntity');
  const blockers: string[] = [];
  for (const [itemId, values] of referrers.itemCostValues ?? []) {
    if (values.includes(expressId)) blockers.push(`IfcCostItem #${itemId}.CostValues`);
  }
  for (const [valueId, components] of referrers.valueComponents ?? []) {
    if (components.includes(expressId)) blockers.push(`IfcCostValue #${valueId}.Components`);
  }
  if (blockers.length > 0 && !options.detach) {
    throw new Error(
      `removeCostEntity: #${expressId} is still referenced by ${blockers.join(', ')}. `
      + 'Pass { detach: true } to rewrite those lists first.');
  }
  if (blockers.length > 0) {
    for (const [itemId, values] of referrers.itemCostValues ?? []) {
      if (!values.includes(expressId)) continue;
      const remaining = values.filter(id => id !== expressId);
      editor.setPositionalAttribute(itemId, 7, remaining.length === 0 ? null : remaining.map(id => `#${id}`));
    }
    for (const [valueId, components] of referrers.valueComponents ?? []) {
      if (!components.includes(expressId)) continue;
      const remaining = components.filter(id => id !== expressId);
      editor.setPositionalAttribute(valueId, 9, remaining.length === 0 ? null : remaining.map(id => `#${id}`));
    }
  }
  for (const [relId, related] of referrers.nestRelatedObjects ?? []) {
    if (!related.includes(expressId)) continue;
    const remaining = related.filter(id => id !== expressId);
    if (remaining.length === 0) editor.removeEntity(relId);
    else editor.setPositionalAttribute(relId, 5, remaining.map(id => `#${id}`));
  }
  for (const [relId, related] of referrers.assignmentRelatedObjects ?? []) {
    if (!related.includes(expressId)) continue;
    const remaining = related.filter(id => id !== expressId);
    if (remaining.length === 0) editor.removeEntity(relId);
    else editor.setPositionalAttribute(relId, 4, remaining.map(id => `#${id}`));
  }
  // The target is the RELATING (required) endpoint of these rels — a
  // schedule losing the items it controls, or an item losing its nested
  // children / controlled objects. Nothing to rewrite the list down to:
  // the rel's own anchor is gone, so the rel goes with it.
  for (const relId of referrers.nestsAsParent ?? []) editor.removeEntity(relId);
  for (const relId of referrers.assignmentsAsControl ?? []) editor.removeEntity(relId);
  for (const cascadeId of options.cascadeValueIds ?? []) {
    editor.removeEntity(cascadeId);
  }
  editor.removeEntity(expressId);
}
