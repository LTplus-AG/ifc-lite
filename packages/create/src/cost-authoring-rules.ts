/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-free validation shared by both cost-entity emitters (#4857 PR A):
 * the STEP-TEXT emitter `ifc-creator-cost.ts` (`IfcCreator`, building a file
 * from scratch) and the in-store builder `in-store/cost.ts`
 * (`bim.store.addCost*`, authoring into an already-loaded model). Neither
 * caller's serialization concern lives here — `ifc-creator-cost.ts` writes a
 * raw STEP argument string, `in-store/cost.ts` writes a `StoreEditor`
 * attribute array — only WHETHER an authored value is legal, decided once, so
 * the same typo or out-of-range value is rejected identically from either
 * entry point rather than by two allow-lists that can drift.
 */

/** The schemas cost entities can be authored in (IFC2X3 is refused up front). */
export type CostSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/** A typed IFC value: the SELECT branch name plus its numeric value. */
export interface CostTypedValueInput {
  Type: string;
  Value: number;
}

/**
 * Runtime allow-lists for every closed vocabulary a cost method writes. The
 * TypeScript unions at the call sites only bind typed callers; the sandbox
 * hands these methods untyped script input, and an unchecked string becomes
 * `IFCBOGUSMEASURE(1.)` or `.BOGUS.` — well-formed STEP naming nothing in the
 * schema.
 */
export const MEASURE_TYPES: ReadonlySet<string> = new Set<string>([
  'IfcMonetaryMeasure', 'IfcAreaMeasure', 'IfcVolumeMeasure', 'IfcLengthMeasure',
  'IfcMassMeasure', 'IfcTimeMeasure', 'IfcCountMeasure', 'IfcNumericMeasure',
  'IfcRatioMeasure', 'IfcReal', 'IfcInteger',
]);
export const QUANTITY_KINDS: ReadonlySet<string> = new Set<string>([
  'IfcQuantityLength', 'IfcQuantityArea', 'IfcQuantityVolume', 'IfcQuantityWeight',
  'IfcQuantityTime', 'IfcQuantityCount', 'IfcQuantityNumber',
]);
export const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set<string>(['ADD', 'DIVIDE', 'MODULO', 'MULTIPLY', 'SUBTRACT']);
export const COST_SCHEDULE_TYPES: ReadonlySet<string> = new Set<string>([
  'BUDGET', 'COSTPLAN', 'ESTIMATE', 'TENDER', 'PRICEDBILLOFQUANTITIES',
  'UNPRICEDBILLOFQUANTITIES', 'SCHEDULEOFRATES', 'USERDEFINED', 'NOTDEFINED',
]);
export const COST_ITEM_TYPES: ReadonlySet<string> = new Set<string>(['USERDEFINED', 'NOTDEFINED']);

/** Validate a loaded model's schema at the untyped runtime boundary. */
export function requireCostSchema(schema: unknown): CostSchema {
  if (schema !== 'IFC2X3' && schema !== 'IFC4' && schema !== 'IFC4X3') {
    throw new Error('CostAnchor.schema is required and must match the loaded model schema');
  }
  return schema;
}

/** Refuse a value outside its closed vocabulary; `undefined` (absent) passes. */
export function assertOneOf(value: unknown, allowed: ReadonlySet<string>, what: string, context: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${context}: ${what} '${String(value)}' is not one of ${[...allowed].join(', ')}`);
  }
}

/** Validate IfcArithmeticOperatorEnum, whose MODULO member exists only in IFC4X3. */
export function validateArithmeticOperator(value: unknown, schema: CostSchema, context: string): void {
  assertOneOf(value, ARITHMETIC_OPERATORS, 'ArithmeticOperator', context);
  if (value === 'MODULO' && schema !== 'IFC4X3') {
    throw new Error(`${context}: ArithmeticOperator 'MODULO' is only valid in IFC4X3`);
  }
}

/** EXPRESS INTEGER-valued measures: IfcInteger always, IfcCountMeasure from IFC4X3 on. */
export function isIntegerMeasure(type: string, schema: CostSchema): boolean {
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
      + 'attribute layout. Create or load the model as IFC4 or IFC4X3.');
  }
}

/**
 * Validate a typed IFC value (`IfcCostValue.AppliedValue`,
 * `IfcMeasureWithUnit.ValueComponent` — both `IfcValue`/SELECT-typed
 * attributes). Does not serialize: the caller picks the STEP form (a named
 * SELECT branch as raw text, or a `{ typed: { type, value } }` overlay
 * marker) once this passes.
 */
export function validateTypedValue(value: CostTypedValueInput | undefined, schema: CostSchema, context: string): void {
  if (value === undefined || value === null) throw new Error(`${context}: a typed value is required`);
  if (value.Type === undefined) throw new Error(`${context}: Type is required on a typed value`);
  assertOneOf(value.Type, MEASURE_TYPES, 'Type', context);
  if (!Number.isFinite(value.Value)) {
    throw new Error(`${context}: ${value.Type} value must be a finite number`);
  }
  // Rounding would silently change the caller's number: an INTEGER measure
  // given a fraction is a caller error, not something to fix up.
  if (isIntegerMeasure(value.Type, schema) && !Number.isInteger(value.Value)) {
    throw new Error(`${context}: ${value.Type} value must be an integer in ${schema}, got ${value.Value}`);
  }
}

/**
 * Validate an optional LIST-of-reference attribute.
 *
 * `undefined` is absent. An empty array is NOT absent: the EXPRESS
 * declaration is `[1:?]`, so `()` would be a malformed list that the reader
 * reports as INVALID_LIST. Refusing here keeps the two states distinct end to
 * end, for both emitters.
 */
export function validateRefList(ids: number[] | undefined, attribute: string, context: string): void {
  if (ids === undefined) return;
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
}

/** Require a positive integer express id for a single-reference attribute. */
export function requireRef(id: number, attribute: string, context: string): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${context}: ${attribute} must be an express id, got '${id}'`);
  }
}
