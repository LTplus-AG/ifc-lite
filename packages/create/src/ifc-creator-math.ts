/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure utility functions and constants used by IfcCreator.
 * These have zero coupling to class state — they take inputs and return outputs.
 */

import type { Point3D, PropertyDef, QuantityDef } from './types.js';

// ============================================================================
// Internal helpers
// ============================================================================

/** Escape a string for STEP format */
export function esc(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/** Format a STEP line: #ID=TYPE(args); */
export function stepLine(id: number, type: string, args: string): string {
  return `#${id}=${type}(${args});`;
}

/**
 * The magnitude at which `Number.prototype.toFixed` itself switches to
 * exponential notation (ECMA-262 `Number.prototype.toFixed`, step 10).
 * `num()` below relies on `toFixed` to strip exponent notation, so a
 * value at or beyond this magnitude cannot be serialized by that
 * strategy and must be refused rather than emitted as an invalid token.
 */
export const MAX_STEP_REAL_MAGNITUDE = 1e21;

/** Serialize a number in STEP format (always with decimal point, no exponent notation) */
export function num(v: number): string {
  // Exponent notation (e.g. 1e-7) is not valid STEP — use fixed decimal.
  // ISO 10303-21 real_literal requires a decimal point in the mantissa,
  // so neither NaN/Infinity nor exponential notation is a legal token.
  if (!Number.isFinite(v)) {
    throw new Error(`num: ${v} is not a finite number and cannot be written as a STEP REAL`);
  }
  if (Math.abs(v) >= MAX_STEP_REAL_MAGNITUDE) {
    // toFixed(10) itself returns exponential notation once |v| >= 1e21
    // (ECMA-262), so the fixed-decimal fallback below cannot represent
    // this value as valid STEP. Fail closed instead of emitting the
    // exponential token the guard exists to prevent.
    throw new Error(
      `num: ${v} has magnitude >= ${MAX_STEP_REAL_MAGNITUDE} and cannot be written as a STEP REAL without exponent notation`
    );
  }
  const s = v.toString();
  if (s.includes('e') || s.includes('E')) return v.toFixed(10).replace(/0+$/, '0');
  return s.includes('.') ? s : s + '.';
}

/** Vector length */
export function vecLen(v: Point3D): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/**
 * IFC types that do NOT follow the IfcElement attribute layout (no Tag/PredefinedType).
 * addElement/addAxisElement skip Tag+PredefinedType for these types.
 */
export const NON_ELEMENT_TYPES = new Set([
  'IFCBUILDING', 'IFCSITE', 'IFCBUILDINGSTOREY', 'IFCPROJECT',
  'IFCSPACE', 'IFCZONE', 'IFCSYSTEM', 'IFCGROUP',
]);

/** Normalize vector — throws on zero-length (indicates geometry bug like Start === End) */
export function vecNorm(v: Point3D): Point3D {
  const len = vecLen(v);
  if (len === 0) throw new Error('Cannot normalize zero-length vector (check that Start and End are not identical)');
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Assert that every named dimension is a positive finite number.
 *
 * A bare `value <= 0` check is `false` for both `NaN` and `Infinity`, so
 * those values silently pass validation and are emitted into the STEP
 * file as the literal strings `"NaN"` / `"Infinity"` — not valid STEP
 * REAL tokens. Reject them the same way a non-positive value is
 * rejected, with the same message shape callers already throw
 * (`<context>: <name> must be a positive finite number`).
 */
export function assertPositiveFinite(values: Record<string, number>, context: string): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${context}: ${name} must be a positive finite number`);
    }
    if (value >= MAX_STEP_REAL_MAGNITUDE) {
      throw new Error(
        `${context}: ${name} (${value}) has magnitude >= ${MAX_STEP_REAL_MAGNITUDE} and cannot be written as a STEP REAL`
      );
    }
  }
}

/**
 * Assert that every named 3D point has finite coordinates.
 *
 * Guards `Start`/`End`/`Position`-style inputs before they feed a
 * derived length (e.g. `beamLen = sqrt(dx*dx + dy*dy + dz*dz)`). A
 * `NaN` or `Infinity` component makes the derived length `NaN`, and
 * `NaN <= 0` is `false`, so a bare "must be distinct points" check
 * downstream never fires — the point must be validated at the source.
 */
export function assertFinitePoint3(points: Record<string, Point3D>, context: string): void {
  for (const [name, point] of Object.entries(points)) {
    if (!point.every(Number.isFinite)) {
      throw new Error(`${context}: ${name} must have finite coordinates`);
    }
    if (!point.every((c) => Math.abs(c) < MAX_STEP_REAL_MAGNITUDE)) {
      throw new Error(
        `${context}: ${name} (${point.join(', ')}) has a coordinate with magnitude >= ${MAX_STEP_REAL_MAGNITUDE} and cannot be written as a STEP REAL`
      );
    }
  }
}

/** Cross product */
export function vecCross(a: Point3D, b: Point3D): Point3D {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// ============================================================================
// STEP attribute helpers (optional strings / enums / booleans / reals)
// ============================================================================
// Live here rather than in `ifc-creator.ts` so the entity-emitting modules
// split out of it (`ifc-creator-calendar.ts`) can share one copy instead of
// each carrying its own `$`-vs-value convention.

/** Emit an optional STEP string: `'value'` when present, `$` otherwise. */
export function optStr(v: string | undefined | null): string {
  return v === undefined || v === null || v === '' ? '$' : `'${esc(v)}'`;
}

/** Emit an optional STEP enum: `.VALUE.` when present, `$` otherwise. */
export function optEnum(v: string | undefined | null): string {
  return v === undefined || v === null || v === '' ? '$' : `.${v}.`;
}

/** Emit an optional STEP boolean: `.T.`/`.F.`/`$`. */
export function optBool(v: boolean | undefined | null): string {
  return v === undefined || v === null ? '$' : v ? '.T.' : '.F.';
}

/** Emit an optional STEP real number; `$` when absent. */
export function optReal(v: number | undefined | null): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '$' : num(v);
}

/** Emit an optional STEP integer; `$` when absent. */
export function optInt(v: number | undefined | null): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '$' : String(Math.trunc(v));
}

/** Emit a STEP entity-reference list `(#1,#2)`, or `$` when empty. */
export function refList(ids: number[]): string {
  return ids.length === 0 ? '$' : `(${ids.map(i => `#${i}`).join(',')})`;
}

/** Emit a STEP integer list `(1,2)`, or `$` when absent/empty. */
export function intList(values: number[] | undefined): string {
  return values === undefined || values.length === 0
    ? '$'
    : `(${values.map(v => String(Math.trunc(v))).join(',')})`;
}

/**
 * Serialize an IfcPropertySingleValue NominalValue as a named SELECT branch.
 *
 * Moved here from `IfcCreator` (it never touched class state) so that file
 * stays inside its recorded module-size budget.
 */
export function serializePropertyValue(prop: PropertyDef): string {
  const val = prop.NominalValue;
  if (typeof val === 'string') {
    const typeName = prop.Type ?? 'IfcLabel';
    return `${typeName.toUpperCase()}('${esc(val)}')`;
  }
  if (typeof val === 'number') {
    const typeName = prop.Type ?? (Number.isInteger(val) ? 'IfcInteger' : 'IfcReal');
    return typeName === 'IfcInteger' ? `IFCINTEGER(${Math.round(val)})` : `IFCREAL(${num(val)})`;
  }
  if (typeof val === 'boolean') {
    // `Type: 'IfcLogical'` (tri-state) must not be downgraded to IFCBOOLEAN.
    const typeName = prop.Type === 'IfcLogical' ? 'IFCLOGICAL' : 'IFCBOOLEAN';
    return `${typeName}(${val ? '.T.' : '.F.'})`;
  }
  return '$';
}

/**
 * Serialize the `Unit, <Kind>Value` pair of an IfcPhysicalSimpleQuantity.
 *
 * Moved here from `IfcCreator` for the same reason as
 * {@link serializePropertyValue}.
 */
export function quantityValueField(qty: QuantityDef): string {
  switch (qty.Kind) {
    case 'IfcQuantityLength':
    case 'IfcQuantityArea':
    case 'IfcQuantityVolume':
    case 'IfcQuantityWeight':
      return `$,${num(qty.Value)}`;
    case 'IfcQuantityCount':
      return `$,${Math.round(qty.Value)}`;
    default:
      return `$,${num(qty.Value)}`;
  }
}
