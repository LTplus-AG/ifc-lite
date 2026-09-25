/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure utility functions and constants used by IfcCreator.
 * These have zero coupling to class state — they take inputs and return outputs.
 */

import { firstProjAxis, formatStepReal } from '@ifc-lite/data';
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
 * Serialize a number as an ISO 10303-21 REAL literal (always with a decimal
 * point in the mantissa).
 *
 * JavaScript's own exponent form (`1e-7`, `1e+21`) has no decimal point, so
 * it is not a legal `real_literal`. Small magnitudes are written as fixed
 * decimal (`toFixed(10)`, which caps precision at ten places, a deliberate
 * trade kept as is). `toFixed` itself switches to exponent form once
 * |v| >= 1e21 (ECMA-262), so those values go through `@ifc-lite/data`'s
 * `formatStepReal`, which writes the STEP exponent form with a mantissa
 * point (`1.E+21`) — the same rule `@ifc-lite/export` uses (#5195).
 *
 * NaN and Infinity have no STEP REAL spelling at all, so they throw rather
 * than reach the file as a `NaN.`/`Infinity.` token.
 */
export function num(v: number): string {
  if (!Number.isFinite(v)) {
    throw new Error(`num: ${v} is not a finite number and cannot be written as a STEP REAL`);
  }
  if (Math.abs(v) >= 1e21) return formatStepReal(v);
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

/**
 * Complete an `IfcAxis2Placement3D` `Axis`/`RefDirection` pair (#5469).
 *
 * The schema rule `IfcAxis2Placement3D.AxisAndRefDirProvision` requires the two
 * to be both present or both absent, so a placement that only rotates about Z
 * (a `RefDirection` with no `Axis`) is invalid as written. Returns `undefined`
 * when neither is given (the `$,$` form stays), otherwise both, with the
 * missing one set to the value the schema implies for it when absent, so the
 * placement's geometry is unchanged:
 *   - no `Axis`: `(0,0,1)`, the `IfcAxis2Placement3D.P` default;
 *   - no `RefDirection`: `firstProjAxis(Axis)`, the fill ifc-lite's renderer
 *     reads a `$` there as (world X projected onto the plane normal to
 *     `Axis`, per `IfcFirstProjAxis`; `(0,-1,0)` for an Axis of exactly -X,
 *     where the schema's projection vanishes). Writing that value keeps what
 *     is drawn identical to the `$` it replaces (#5922).
 */
export function completePlacementAxes(
  axis: Point3D | undefined,
  refDirection: Point3D | undefined,
): { Axis: Point3D; RefDirection: Point3D } | undefined {
  if (axis && refDirection) return { Axis: axis, RefDirection: refDirection };
  if (refDirection) return { Axis: [0, 0, 1], RefDirection: refDirection };
  if (!axis) return undefined;
  // `vecNorm` throws on a zero-length Axis: a builder must not write one.
  return { Axis: axis, RefDirection: firstProjAxis(vecNorm(axis)) };
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
 * Measures whose value is a count, written as an integer literal when the value
 * is whole. IfcCountMeasure is NUMBER in IFC4 and INTEGER from IFC4X3 on; an
 * integer literal is valid for both, whereas `12.` is not an INTEGER.
 */
const INTEGER_VALUED_MEASURES: ReadonlySet<string> = new Set(['IfcCountMeasure']);

/** Declared types a number has always been written as IFCREAL under, unchanged. */
const NON_NUMERIC_TYPES: ReadonlySet<string> = new Set(['IfcLabel', 'IfcText', 'IfcIdentifier', 'IfcBoolean', 'IfcLogical']);

/**
 * The type name is interpolated into STEP as `TYPENAME(value)`, and untyped
 * callers (the sandbox, JSON input) can pass any string. Anything that is not a
 * bare IFC identifier would corrupt the line, so it is refused rather than
 * written.
 */
function assertStepTypeName(typeName: string): void {
  if (!/^Ifc[A-Za-z]+$/.test(typeName)) {
    throw new Error(`Invalid property value type "${typeName}": expected an IFC type name such as IfcPositiveLengthMeasure`);
  }
}

/**
 * Serialize an IfcPropertySingleValue NominalValue as a named SELECT branch.
 *
 * Moved here from `IfcCreator` (it never touched class state) so that file
 * stays inside its recorded module-size budget.
 */
export function serializePropertyValue(prop: PropertyDef): string {
  const val = prop.NominalValue;
  // An empty `Type` (a JSON payload that defaults an unset field to '') means
  // "not declared", exactly like an absent one.
  const declared = prop.Type || undefined;
  if (typeof val === 'string') {
    const typeName = declared ?? 'IfcLabel';
    assertStepTypeName(typeName);
    return `${typeName.toUpperCase()}('${esc(val)}')`;
  }
  if (typeof val === 'number') {
    const typeName = declared ?? (Number.isInteger(val) ? 'IfcInteger' : 'IfcReal');
    // A declared measure type is written AS that type. This used to emit every
    // number as IFCINTEGER or IFCREAL whatever `Type` said, so a
    // `ThermalTransmittance` declared an IfcThermalTransmittanceMeasure came out
    // an IFCREAL and failed any IDS data-type check against Pset_WallCommon.
    if (typeName !== 'IfcInteger' && !NON_NUMERIC_TYPES.has(typeName)) {
      assertStepTypeName(typeName);
      return INTEGER_VALUED_MEASURES.has(typeName) && Number.isInteger(val)
        ? `${typeName.toUpperCase()}(${val})`
        : `${typeName.toUpperCase()}(${num(val)})`;
    }
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
