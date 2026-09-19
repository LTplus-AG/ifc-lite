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

/**
 * Refuse an id that does not resolve to `expectedType` — existing (source or
 * overlay-created, retype-aware, via `StoreEditor.getEntityType`) or not.
 * Every builder here that takes "an id of a specific class" (a parent to
 * nest under, an item to attach values to, a schedule to control from, …)
 * checks it, so a caller's typo or a stale id fails loudly here rather than
 * writing a structurally valid but semantically wrong STEP reference.
 */
function requireEntityType(editor: StoreEditor, id: number, expectedType: string, attribute: string, context: string): void {
  const actual = editor.getEntityType(id);
  if (actual === undefined) {
    throw new Error(`${context}: ${attribute} #${id} does not exist in this model`);
  }
  if (actual.toUpperCase() !== expectedType.toUpperCase()) {
    throw new Error(`${context}: ${attribute} #${id} must be an ${expectedType}, got ${actual}`);
  }
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
    if (relatedType) requireEntityType(editor, id, relatedType, 'relatedObjectIds', context);
    else if (!editor.hasEntity(id)) throw new Error(`${context}: relatedObjectIds #${id} does not exist in this model`);
  }
  if (existingAssignment) {
    const merged = [...new Set([...existingAssignment.relatedIds, ...uniqueRelated])];
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
 * Assign `objectIds` (products AND/OR tasks) to `costItemId` (IfcCostItem) as
 * the objects it controls. `objectIds` are NOT type-checked against one
 * class — that is the point of "products AND tasks are legal" — only their
 * existence is (via `StoreEditor.addEntity`'s own checks and this rel's own
 * export-time reference resolution).
 */
export function assignObjectsToCostItemInStore(
  editor: StoreEditor, anchor: CostAnchor, costItemId: number, objectIds: number[],
  existingAssignment?: ExistingRelatedList,
): number {
  return assignToControlInStore(editor, anchor, costItemId, objectIds, existingAssignment, 'assignToCostItem', 'IfcCostItem');
}

/**
 * Set (replace) `itemId`'s `IfcCostItem.CostValues` (slot 7). `valueIds` is
 * REQUIRED, not optional: an empty array is how a caller CLEARS the list,
 * written as `$` — never `()`, which `[1:?]` forbids.
 */
export function attachCostValuesToItemInStore(editor: StoreEditor, itemId: number, valueIds: readonly number[]): void {
  requireEntityType(editor, itemId, 'IfcCostItem', 'itemId', 'setCostItemValues');
  for (const id of valueIds) {
    requireRef(id, 'CostValues', 'setCostItemValues');
    requireEntityType(editor, id, 'IfcCostValue', 'CostValues', 'setCostItemValues');
  }
  editor.setPositionalAttribute(itemId, 7, valueIds.length === 0 ? null : valueIds.map(id => `#${id}`));
}

/** Every reference the caller found pointing at the entity being removed — see the module header. */
export interface CostRemovalReferrers {
  /** `IfcCostItem.CostValues` lists containing the target value, keyed by the item's expressId. */
  itemCostValues?: ReadonlyMap<number, readonly number[]>;
  /** `IfcCostValue.Components` lists containing the target value, keyed by the owning value's expressId. */
  valueComponents?: ReadonlyMap<number, readonly number[]>;
  /**
   * `IfcCostValue.AppliedValue`'s `Reference` branch (`AppliedValueRef`,
   * pointing at an `IfcMeasureWithUnit`) naming the target, keyed by the
   * owning value's expressId. A single required-when-present attribute, not
   * a list — same danger as `Components`, different shape.
   */
  valueAppliedValueRef?: ReadonlyMap<number, number>;
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
  /**
   * Every OTHER cost relationship type — `IfcRelAssignsToProduct`,
   * `IfcRelAssignsToProcess`, `IfcRelDeclares`, `IfcRelAssociatesAppliedValue`,
   * `IfcRelSchedulesCostItems`, `IfcAppliedValueRelationship`, and any future
   * subtype the cost reader enumerates — that references the target in ANY
   * of its reference attributes (`RelatedObjects`, `RelatedDefinitions`,
   * `Components`, or any `Relating*` scalar), by expressId. Unlike
   * `nestRelatedObjects`/`assignmentRelatedObjects`, the caller does not name
   * a positional slot for these — the exact layout varies by type — so this
   * is never partially rewritten: `detach: true` tombstones the WHOLE
   * relationship. Safe (never leaves a dangling reference to the deleted
   * entity) but more aggressive than a precise per-slot rewrite would be,
   * since any OTHER member of that same relationship goes with it.
   */
  otherRelationships?: readonly number[];
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
  for (const [valueId, ref] of referrers.valueAppliedValueRef ?? []) {
    if (ref === expressId) blockers.push(`IfcCostValue #${valueId}.AppliedValue (AppliedValueRef)`);
  }
  for (const relId of referrers.otherRelationships ?? []) {
    blockers.push(`relationship #${relId}`);
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
    for (const [valueId, ref] of referrers.valueAppliedValueRef ?? []) {
      if (ref !== expressId) continue;
      editor.setPositionalAttribute(valueId, 2, null);
    }
    // No known positional slot for these types — see the field's doc comment
    // on CostRemovalReferrers. Tombstoning the whole rel is the only rewrite
    // that is safe without one.
    for (const relId of referrers.otherRelationships ?? []) editor.removeEntity(relId);
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
