/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared STEP builder behind every 5D / cost entity `IfcCreator` authors —
 * IfcCostSchedule, IfcCostItem, IfcCostValue, the units and measures they
 * reference, and the IfcPhysicalSimpleQuantity a cost item is derived from.
 *
 * Split out of `ifc-creator.ts` so that file stays under its recorded
 * module-size budget (see `scripts/module-size-allowlist.txt`), the same way
 * `ifc-creator-scheduling.ts` is. The dependency on the creator is narrowed to
 * the one `EmitEntity` callback: it allocates the next express id, writes the
 * `#N=TYPE(attrs);` line, and returns the id — so nothing here reaches into
 * the creator's private state, and every cost entity in a file goes through
 * exactly one set of emitters whether the caller reached it directly or
 * through another cost method.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT
 *
 * 1. TYPED SELECT VALUES. `IfcCostValue.AppliedValue` (IfcAppliedValueSelect)
 *    and `IfcMeasureWithUnit.ValueComponent` (IfcValue) are SELECTs. STEP
 *    names the branch — `IFCMONETARYMEASURE(1234.56)` — and a bare `1234.56`
 *    in the same slot is still well-formed STEP that means something else.
 *    `typedValue()` is the only way a number reaches either attribute.
 *
 * 2. UNIT BASIS. `IfcCostValue.UnitBasis` is the quantity a rate is quoted
 *    per, so it divides. Writing it as anything but the caller's own
 *    IfcMeasureWithUnit moves the amount by orders of magnitude, not by a
 *    rounding step.
 *
 * 3. CURRENCY IS NEVER INVENTED. There is no default. A file whose author did
 *    not state a currency is written without an IfcMonetaryUnit, and reads
 *    back with no currency — which is a different (and honest) answer from a
 *    guessed one.
 *
 * 4. ABSENT IS NOT EMPTY. An optional LIST attribute the caller omitted is
 *    written `$`. An empty array is a caller error (EXPRESS declares these
 *    lists `[1:?]`) and is refused loudly rather than degraded to `$`.
 */

import { esc, num, optStr, optEnum, refList } from './ifc-creator-math.js';
import type {
  CostItemParams,
  CostQuantityParams,
  CostScheduleParams,
  CostTypedValue,
  CostValueParams,
  SIUnitParams,
} from './types-cost.js';

/** Allocate an express id, emit `#id=TYPE(attrs);`, and return the id. */
export type EmitEntity = (type: string, attrs: string) => number;

/**
 * Refuse IFC2X3 cost authoring by name, loudly.
 *
 * IFC2X3 lays IfcCostSchedule / IfcCostItem / IfcCostValue out differently
 * (IfcCostSchedule carries an `ID` and IfcDateAndTime references where IFC4
 * carries `Identification` and IfcDateTime strings; IfcCostValue has
 * `CostType` where IFC4 has `Category`, and no `Components` at all). Writing
 * the IFC4 layout into an IFC2X3 file would produce records that parse and are
 * wrong. A no-op — or a method that returned an id having written nothing —
 * would look like success at the call site, so this throws instead.
 */
export function assertCostSchema(schema: string, method: string): void {
  if (schema === 'IFC2X3') {
    throw new Error(
      `${method} is not supported for IFC2X3: the IFC2X3 cost entities have a different `
      + 'attribute layout. Create the IfcCreator with Schema "IFC4" or "IFC4X3".');
  }
}

/**
 * Serialize a typed IFC value as a named SELECT branch.
 *
 * The branch comes from the caller, never from the shape of the number: 12 is
 * a valid IfcMonetaryMeasure, IfcAreaMeasure, IfcCountMeasure and IfcInteger,
 * and picking one by inspecting the value would silently retype the file.
 */
export function typedValue(value: CostTypedValue, context: string): string {
  if (!Number.isFinite(value.Value)) {
    throw new Error(`${context}: ${value.Type} value must be a finite number`);
  }
  if (value.Type === 'IfcInteger') return `IFCINTEGER(${Math.round(value.Value)})`;
  return `${value.Type.toUpperCase()}(${num(value.Value)})`;
}

/**
 * Serialize an optional LIST-of-reference attribute.
 *
 * `undefined` is absent and becomes `$`. An empty array is NOT absent: the
 * EXPRESS declaration is `[1:?]`, so `()` would be a malformed list that the
 * reader reports as INVALID_LIST. Refusing here keeps the two states distinct
 * end to end.
 */
function optRefList(ids: number[] | undefined, attribute: string, context: string): string {
  if (ids === undefined) return '$';
  if (ids.length === 0) {
    throw new Error(
      `${context}: ${attribute} must name at least one entity. Omit the field entirely `
      + 'to write it as absent — an empty list is a malformed IFC list, not "no value".');
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${context}: ${attribute} contains '${id}', which is not an express id`);
    }
  }
  return refList(ids);
}

/** Require a positive integer express id for a single-reference attribute. */
function requireRef(id: number, attribute: string, context: string): string {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${context}: ${attribute} must be an express id, got '${id}'`);
  }
  return `#${id}`;
}

/**
 * Emit an IfcMonetaryUnit.
 *
 * The currency is written exactly as given. There is no default and no
 * normalisation: an unstated currency must stay unstated, so callers that have
 * none simply do not call this.
 */
export function emitMonetaryUnit(currency: string, emit: EmitEntity): number {
  if (typeof currency !== 'string' || currency.trim().length === 0) {
    throw new Error('addIfcMonetaryUnit: Currency must be a non-empty string (there is no default currency)');
  }
  // IFC4 IfcMonetaryUnit: [0] Currency (IfcLabel).
  return emit('IFCMONETARYUNIT', `'${esc(currency)}'`);
}

/** Emit an IfcSIUnit. [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name. */
export function emitSIUnit(params: SIUnitParams, emit: EmitEntity): number {
  return emit('IFCSIUNIT',
    `*,${optEnum(params.UnitType)},${optEnum(params.Prefix)},${optEnum(params.Name)}`);
}

/**
 * Emit an IfcMeasureWithUnit — the value/unit pair behind a cost rate's
 * UnitBasis and behind an AppliedValue expressed as an entity rather than a
 * literal. [0] ValueComponent (IfcValue SELECT), [1] UnitComponent.
 */
export function emitMeasureWithUnit(
  value: CostTypedValue,
  unitId: number,
  emit: EmitEntity,
): number {
  const unitRef = requireRef(unitId, 'UnitComponent', 'addIfcMeasureWithUnit');
  return emit('IFCMEASUREWITHUNIT', `${typedValue(value, 'addIfcMeasureWithUnit')},${unitRef}`);
}

/**
 * Emit an IfcPhysicalSimpleQuantity.
 *
 * The value attribute is a DEFINED TYPE (`IfcQuantityArea.AreaValue` is an
 * `IfcAreaMeasure`), not a SELECT, so it is written as a bare number — the
 * opposite of `IfcCostValue.AppliedValue`. Naming a branch here would be as
 * wrong as omitting one there.
 *
 * [0] Name, [1] Description, [2] Unit, [3] <Kind>Value, [4] Formula.
 */
export function emitPhysicalQuantity(params: CostQuantityParams, emit: EmitEntity): number {
  if (!Number.isFinite(params.Value)) {
    throw new Error(`addIfcPhysicalQuantity: ${params.Kind} '${params.Name}' value must be a finite number`);
  }
  const unitRef = params.Unit === undefined
    ? '$'
    : requireRef(params.Unit, 'Unit', 'addIfcPhysicalQuantity');
  const value = params.Kind === 'IfcQuantityCount'
    ? num(Math.round(params.Value))
    : num(params.Value);
  return emit(params.Kind.toUpperCase(),
    `'${esc(params.Name)}',${optStr(params.Description)},${unitRef},${value},${optStr(params.Formula)}`);
}

/**
 * Emit an IfcCostValue.
 *
 * `AppliedValue` (a literal typed measure) and `AppliedValueRef` (an
 * IfcMeasureWithUnit) are the two branches of one SELECT, so at most one may
 * be given. Neither is synthesised from `Components`, and `Components` is
 * never synthesised from either: which form the source used is part of what
 * the file says.
 *
 * [0] Name, [1] Description, [2] AppliedValue, [3] UnitBasis,
 * [4] ApplicableDate, [5] FixedUntilDate, [6] Category, [7] Condition,
 * [8] ArithmeticOperator, [9] Components.
 */
export function emitCostValue(params: CostValueParams, emit: EmitEntity): number {
  if (params.AppliedValue !== undefined && params.AppliedValueRef !== undefined) {
    throw new Error(
      'addIfcCostValue: AppliedValue and AppliedValueRef are the two branches of one SELECT — give at most one');
  }
  let applied = '$';
  if (params.AppliedValue !== undefined) {
    applied = typedValue(params.AppliedValue, 'addIfcCostValue');
  } else if (params.AppliedValueRef !== undefined) {
    applied = requireRef(params.AppliedValueRef, 'AppliedValueRef', 'addIfcCostValue');
  }
  const unitBasis = params.UnitBasis === undefined
    ? '$'
    : requireRef(params.UnitBasis, 'UnitBasis', 'addIfcCostValue');
  return emit('IFCCOSTVALUE',
    `${optStr(params.Name)},${optStr(params.Description)},${applied},${unitBasis},`
    + `${optStr(params.ApplicableDate)},${optStr(params.FixedUntilDate)},`
    + `${optStr(params.Category)},${optStr(params.Condition)},`
    + `${optEnum(params.ArithmeticOperator)},`
    + `${optRefList(params.Components, 'Components', 'addIfcCostValue')}`);
}

/**
 * Emit an IfcCostItem.
 *
 * [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description, [4] ObjectType,
 * [5] Identification, [6] PredefinedType, [7] CostValues, [8] CostQuantities.
 */
export function emitCostItem(
  params: CostItemParams,
  globalId: string,
  ownerRef: string,
  emit: EmitEntity,
): number {
  return emit('IFCCOSTITEM',
    `'${globalId}',${ownerRef},'${esc(params.Name)}',${optStr(params.Description)},`
    + `${optStr(params.ObjectType)},${optStr(params.Identification)},`
    + `${optEnum(params.PredefinedType)},`
    + `${optRefList(params.CostValues, 'CostValues', 'addIfcCostItem')},`
    + `${optRefList(params.CostQuantities, 'CostQuantities', 'addIfcCostItem')}`);
}

/**
 * Emit an IfcRelAssignsToProduct — binds objects (here, IfcCostItems) to the
 * product they price.
 *
 * DIRECTION IS NOT SYMMETRIC. The PRODUCT is `RelatingProduct` (index 6) and
 * the cost items are `RelatedObjects` (index 4). Swapping them yields a
 * relationship that is still well-formed STEP and says the opposite thing —
 * which is why the cost read model type-checks both ends and flags
 * `InvalidReferences` rather than trusting the shape.
 *
 * [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description,
 * [4] RelatedObjects, [5] RelatedObjectsType, [6] RelatingProduct.
 */
export function emitRelAssignsToProduct(
  relatingProductId: number,
  relatedObjectIds: number[],
  newGlobalId: () => string,
  ownerRef: string,
  emit: EmitEntity,
): number {
  const refs = optRefList(relatedObjectIds, 'relatedObjectIds', 'addIfcRelAssignsToProduct');
  const productRef = requireRef(relatingProductId, 'relatingProductId', 'addIfcRelAssignsToProduct');
  return emit('IFCRELASSIGNSTOPRODUCT',
    `'${newGlobalId()}',${ownerRef},$,$,${refs},$,${productRef}`);
}

/**
 * Emit an IfcCostSchedule.
 *
 * [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description, [4] ObjectType,
 * [5] Identification, [6] PredefinedType, [7] Status, [8] SubmittedOn,
 * [9] UpdateDate. SubmittedOn / UpdateDate are IfcDateTime STRINGS in IFC4 —
 * the IFC2X3 IfcDateAndTime entity references live at different indices, which
 * is one of the reasons `assertCostSchema` refuses that schema outright.
 */
export function emitCostSchedule(
  params: CostScheduleParams,
  globalId: string,
  ownerRef: string,
  emit: EmitEntity,
): number {
  return emit('IFCCOSTSCHEDULE',
    `'${globalId}',${ownerRef},'${esc(params.Name)}',${optStr(params.Description)},`
    + `${optStr(params.ObjectType)},${optStr(params.Identification)},`
    + `${optEnum(params.PredefinedType)},${optStr(params.Status)},`
    + `${optStr(params.SubmittedOn)},${optStr(params.UpdateDate)}`);
}
