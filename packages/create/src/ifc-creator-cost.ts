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

import { esc, optStr, optEnum, refList } from './ifc-creator-math.js';
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

/** The schemas cost entities can be authored in (IFC2X3 is refused up front). */
export type CostSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/**
 * Serialize a finite number as an exact STEP REAL.
 *
 * The shared `num()` expands exponent notation through `toFixed(10)`, which
 * is fine for geometry but turns 1e-11 into 0 and leaves 1e21 in JS exponent
 * form. A cost amount has no tolerance for either, and ISO 10303-21 REAL
 * allows an exponent (`1.E-11`), so the shortest round-trip digits from
 * `toString()` are kept and only rewritten into STEP's spelling.
 */
export function stepReal(v: number): string {
  const s = v.toString();
  const e = s.search(/e/i);
  if (e < 0) return s.includes('.') ? s : `${s}.`;
  const mantissa = s.slice(0, e);
  const exponent = s.slice(e + 1).replace(/^\+/, '');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.`}E${exponent}`;
}

/**
 * Runtime allow-lists for every closed vocabulary a cost method writes. The
 * TypeScript unions only bind typed callers; the sandbox hands these methods
 * untyped script input, and an unchecked string becomes `IFCBOGUSMEASURE(1.)`
 * or `.BOGUS.` — well-formed STEP naming nothing in the schema.
 */
const MEASURE_TYPES = new Set<string>([
  'IfcMonetaryMeasure', 'IfcAreaMeasure', 'IfcVolumeMeasure', 'IfcLengthMeasure',
  'IfcMassMeasure', 'IfcTimeMeasure', 'IfcCountMeasure', 'IfcNumericMeasure',
  'IfcRatioMeasure', 'IfcReal', 'IfcInteger',
]);
const QUANTITY_KINDS = new Set<string>([
  'IfcQuantityLength', 'IfcQuantityArea', 'IfcQuantityVolume', 'IfcQuantityWeight',
  'IfcQuantityTime', 'IfcQuantityCount', 'IfcQuantityNumber',
]);
const ARITHMETIC_OPERATORS = new Set<string>(['ADD', 'DIVIDE', 'MULTIPLY', 'SUBTRACT']);
const COST_SCHEDULE_TYPES = new Set<string>([
  'BUDGET', 'COSTPLAN', 'ESTIMATE', 'TENDER', 'PRICEDBILLOFQUANTITIES',
  'UNPRICEDBILLOFQUANTITIES', 'SCHEDULEOFRATES', 'USERDEFINED', 'NOTDEFINED',
]);
const COST_ITEM_TYPES = new Set<string>(['USERDEFINED', 'NOTDEFINED']);

/** Refuse a value outside its closed vocabulary; `undefined` (absent) passes. */
function assertOneOf(value: unknown, allowed: ReadonlySet<string>, what: string, context: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${context}: ${what} '${String(value)}' is not one of ${[...allowed].join(', ')}`);
  }
}

/** EXPRESS INTEGER-valued measures: IfcInteger always, IfcCountMeasure from IFC4X3 on. */
function isIntegerMeasure(type: string, schema: CostSchema): boolean {
  return type === 'IfcInteger' || (type === 'IfcCountMeasure' && schema === 'IFC4X3');
}

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
export function typedValue(value: CostTypedValue, schema: CostSchema, context: string): string {
  if (value === undefined || value === null) throw new Error(`${context}: a typed value is required`);
  assertOneOf(value.Type, MEASURE_TYPES, 'Type', context);
  if (!Number.isFinite(value.Value)) {
    throw new Error(`${context}: ${value.Type} value must be a finite number`);
  }
  // Rounding would silently change the caller's number: an INTEGER measure
  // given a fraction is a caller error, not something to fix up.
  if (isIntegerMeasure(value.Type, schema)) {
    if (!Number.isInteger(value.Value)) {
      throw new Error(`${context}: ${value.Type} value must be an integer in ${schema}, got ${value.Value}`);
    }
    return `${value.Type.toUpperCase()}(${value.Value.toString()})`;
  }
  return `${value.Type.toUpperCase()}(${stepReal(value.Value)})`;
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

const SI_PREFIXES = new Set([
  'ATTO', 'CENTI', 'DECA', 'DECI', 'EXA', 'FEMTO', 'GIGA', 'HECTO',
  'KILO', 'MEGA', 'MICRO', 'MILLI', 'NANO', 'PETA', 'PICO', 'TERA',
]);

/** The one IfcSIUnitName each authorable UnitType is dimensionally consistent with. */
const SI_NAME_FOR_UNIT_TYPE: Record<string, string> = {
  LENGTHUNIT: 'METRE',
  AREAUNIT: 'SQUARE_METRE',
  VOLUMEUNIT: 'CUBIC_METRE',
  MASSUNIT: 'GRAM',
  TIMEUNIT: 'SECOND',
};

/**
 * Emit an IfcSIUnit. [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name.
 *
 * All three are ENUMERATION literals and `Name` is mandatory, so an unknown or
 * empty string is refused rather than written as `.WHATEVER.` or `$` (the
 * sandbox passes these straight through from untyped script input).
 */
export function emitSIUnit(params: SIUnitParams, emit: EmitEntity): number {
  const expected = SI_NAME_FOR_UNIT_TYPE[params.UnitType];
  if (expected === undefined) {
    throw new Error(
      `addIfcSIUnit: UnitType must be one of ${Object.keys(SI_NAME_FOR_UNIT_TYPE).join(', ')}, got '${params.UnitType}'`);
  }
  if (params.Name !== expected) {
    throw new Error(`addIfcSIUnit: a ${params.UnitType} must be named '${expected}', got '${params.Name}'`);
  }
  if (params.Prefix !== undefined && !SI_PREFIXES.has(params.Prefix)) {
    throw new Error(`addIfcSIUnit: Prefix '${params.Prefix}' is not an IfcSIPrefix`);
  }
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
  schema: CostSchema,
  emit: EmitEntity,
): number {
  const unitRef = requireRef(unitId, 'UnitComponent', 'addIfcMeasureWithUnit');
  return emit('IFCMEASUREWITHUNIT', `${typedValue(value, schema, 'addIfcMeasureWithUnit')},${unitRef}`);
}

/**
 * Emit an IfcPhysicalSimpleQuantity.
 *
 * The value attribute is a DEFINED TYPE (`IfcQuantityArea.AreaValue` is an
 * `IfcAreaMeasure`), not a SELECT, so it is written as a bare number — the
 * opposite of `IfcCostValue.AppliedValue`. Naming a branch here would be as
 * wrong as omitting one there.
 *
 * The rules are schema-dependent: IfcCountMeasure is NUMBER in IFC4 but
 * INTEGER in IFC4X3, IfcQuantityNumber only exists from IFC4X3, and every kind
 * except IfcQuantityNumber carries a `WR: <Value> >= 0` rule.
 *
 * [0] Name, [1] Description, [2] Unit, [3] <Kind>Value, [4] Formula.
 */
export function emitPhysicalQuantity(
  params: CostQuantityParams,
  schema: CostSchema,
  emit: EmitEntity,
): number {
  assertOneOf(params.Kind, QUANTITY_KINDS, 'Kind', 'addIfcPhysicalQuantity');
  const context = `addIfcPhysicalQuantity: ${params.Kind} '${params.Name}'`;
  if (params.Kind === 'IfcQuantityNumber' && schema !== 'IFC4X3') {
    throw new Error(`${context} does not exist in ${schema}; IfcQuantityNumber requires Schema "IFC4X3"`);
  }
  if (!Number.isFinite(params.Value)) {
    throw new Error(`${context} value must be a finite number`);
  }
  if (params.Kind === 'IfcQuantityCount' && schema === 'IFC4X3' && !Number.isInteger(params.Value)) {
    throw new Error(`${context} value must be a finite integer in IFC4X3 (IfcCountMeasure is INTEGER)`);
  }
  if (params.Kind !== 'IfcQuantityNumber' && params.Value < 0) {
    throw new Error(`${context} value must be non-negative, got ${params.Value}`);
  }
  const unitRef = params.Unit === undefined
    ? '$'
    : requireRef(params.Unit, 'Unit', 'addIfcPhysicalQuantity');
  // An IFC4X3 count is INTEGER, so it takes no trailing `.` (that spells a REAL).
  const value = params.Kind === 'IfcQuantityCount' && schema === 'IFC4X3'
    ? params.Value.toString()
    : stepReal(params.Value);
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
export function emitCostValue(params: CostValueParams, schema: CostSchema, emit: EmitEntity): number {
  assertOneOf(params.ArithmeticOperator, ARITHMETIC_OPERATORS, 'ArithmeticOperator', 'addIfcCostValue');
  if (params.AppliedValue !== undefined && params.AppliedValueRef !== undefined) {
    throw new Error(
      'addIfcCostValue: AppliedValue and AppliedValueRef are the two branches of one SELECT — give at most one');
  }
  let applied = '$';
  if (params.AppliedValue !== undefined) {
    applied = typedValue(params.AppliedValue, schema, 'addIfcCostValue');
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
  assertOneOf(params.PredefinedType, COST_ITEM_TYPES, 'PredefinedType', 'addIfcCostItem');
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
  assertOneOf(params.PredefinedType, COST_SCHEDULE_TYPES, 'PredefinedType', 'addIfcCostSchedule');
  return emit('IFCCOSTSCHEDULE',
    `'${globalId}',${ownerRef},'${esc(params.Name)}',${optStr(params.Description)},`
    + `${optStr(params.ObjectType)},${optStr(params.Identification)},`
    + `${optEnum(params.PredefinedType)},${optStr(params.Status)},`
    + `${optStr(params.SubmittedOn)},${optStr(params.UpdateDate)}`);
}
