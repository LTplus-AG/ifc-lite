/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XSD strict-cast helpers shared by the attribute and property facets.
 *
 * Mirrors the `int.TryParse` / `double.TryParse` / `DateTime.TryParse`
 * rules upstream `IDS-Audit-tool` applies before doing the value
 * comparison. An IDS literal must cast successfully under at least one
 * of the slot's declared XSD types — `xs:integer` rejects `42.0`,
 * `xs:double` accepts either, etc.
 */

import { isWhollyNumeric } from '@ifc-lite/encoding';

const INTEGER_RE = /^[+-]?\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DURATION_RE =
  /^-?P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;

/**
 * Returns true iff the IDS literal `value` casts successfully under at
 * least one of `xsdTypes`. Empty / undefined `xsdTypes` returns `true`
 * (no constraint). Unknown XSD types are accepted permissively so a
 * future schema addition doesn't silently break validation.
 */
export function literalCastsUnderAnyType(
  value: string,
  xsdTypes: readonly string[] | undefined
): boolean {
  if (!xsdTypes || xsdTypes.length === 0) return true;
  return xsdTypes.some((t) => literalCastsUnder(value, t));
}

export function literalCastsUnder(value: string, xsdType: string): boolean {
  switch (xsdType) {
    case 'xs:integer':
      return INTEGER_RE.test(value);
    case 'xs:double':
      // Same language the local `DOUBLE_RE` decided, via the shared
      // linear scan. That regex was
      // `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` — the #3113 shape,
      // quadratic on a failing match — and an IDS literal is as
      // untrusted as the file it came out of.
      return isWhollyNumeric(value);
    case 'xs:boolean':
      return value === 'true' || value === 'false';
    case 'xs:date':
      return DATE_RE.test(value);
    case 'xs:dateTime':
      return DATETIME_RE.test(value);
    case 'xs:duration':
      return DURATION_RE.test(value);
    case 'xs:string':
      return true;
    default:
      // Unknown XSD type — be permissive rather than reject.
      return true;
  }
}

/**
 * Map an IFC measure name (`IFCINTEGER`, `IFCREAL`, `IFCBOOLEAN`,
 * `IFCDATE`, `IFCLENGTHMEASURE`, …) to the XSD primitive types it
 * casts to. Used by the property facet to apply the same strict-cast
 * gate to property literals — properties carry their measure name
 * (not an XSD type) so we map first.
 *
 * Returns an empty array for measures we don't have a mapping for —
 * `literalCastsUnderAnyType` then no-ops.
 */
/**
 * XSD base local-names (the part after `xs:`) whose value space is
 * numeric. Used to decide whether a numeric runtime value is
 * type-compatible with a restriction's declared `@base` before its
 * lexical form is pattern-matched.
 */
const NUMERIC_BASE_LOCALS = new Set([
  'decimal',
  'double',
  'float',
  'integer',
  'long',
  'int',
  'short',
  'byte',
  'nonnegativeinteger',
  'positiveinteger',
  'nonpositiveinteger',
  'negativeinteger',
  'unsignedlong',
  'unsignedint',
  'unsignedshort',
  'unsignedbyte',
]);

/** Strip any namespace prefix (`xs:`, `xsd:`) and lower-case the base. */
function baseLocalName(base: string | undefined): string {
  if (!base) return '';
  const colon = base.lastIndexOf(':');
  return (colon >= 0 ? base.slice(colon + 1) : base).toLowerCase();
}

/** True iff the restriction `@base` declares a numeric value space. */
export function isNumericXsdBase(base: string | undefined): boolean {
  return NUMERIC_BASE_LOCALS.has(baseLocalName(base));
}

/** True iff the restriction `@base` declares the boolean value space. */
export function isBooleanXsdBase(base: string | undefined): boolean {
  return baseLocalName(base) === 'boolean';
}

/**
 * Measures whose EXPRESS base contradicts the `*MEASURE` / `*RATIO`
 * suffix heuristic below, or that the heuristic does not reach at all.
 * Derived from `TYPE <name> = <base>;` in
 * `packages/codegen/schemas/IFC4_ADD2_TC1.exp` and `IFC4X3.exp`, over
 * the closure of the `IfcValue` SELECT (the value space an IFC property
 * can actually carry); `xsd-cast-express.test.ts` re-derives that diff
 * and fails if this table drifts from the schemas.
 *
 * - `IfcDescriptiveMeasure` is `STRING`, not a number, despite the name.
 * - `IfcIntegerCountRateMeasure` is `INTEGER`, not `REAL`.
 * - `IfcParameterValue` (`REAL`) and `IfcPositiveInteger` (`INTEGER`)
 *   end in neither suffix, so they previously got no cast gate at all.
 * - `IfcTime` and `IfcUriReference` are `STRING`. `xs:string` accepts
 *   every literal, so naming them changes no verdict; they are listed
 *   so the re-derivation covers the whole reachable value space rather
 *   than carrying a second exception list of its own.
 */
const MEASURE_XSD_OVERRIDES: ReadonlyMap<string, readonly string[]> = new Map([
  ['IFCDESCRIPTIVEMEASURE', ['xs:string']],
  ['IFCINTEGERCOUNTRATEMEASURE', ['xs:integer']],
  ['IFCPARAMETERVALUE', ['xs:double']],
  ['IFCPOSITIVEINTEGER', ['xs:integer']],
  ['IFCTIME', ['xs:string']],
  ['IFCURIREFERENCE', ['xs:string']],
]);

export function ifcMeasureToXsdTypes(measure: string | undefined): readonly string[] {
  if (!measure) return [];
  const m = measure.toUpperCase();
  const override = MEASURE_XSD_OVERRIDES.get(m);
  if (override) return override;
  if (m === 'IFCINTEGER' || m === 'IFCCOUNTMEASURE') return ['xs:integer'];
  if (m === 'IFCBOOLEAN') return ['xs:boolean'];
  if (m === 'IFCLOGICAL') return ['xs:boolean', 'xs:string'];
  if (m === 'IFCDATE') return ['xs:date'];
  if (m === 'IFCDATETIME') return ['xs:dateTime'];
  if (m === 'IFCDURATION' || m === 'IFCTIMESTAMP') return ['xs:duration'];
  // All numeric measures (REAL, *MEASURE, *RATIO) accept doubles.
  if (m === 'IFCREAL' || m.endsWith('MEASURE') || m.endsWith('RATIO')) {
    return ['xs:double'];
  }
  // Any text-flavoured type defaults to permissive string.
  if (
    m === 'IFCLABEL' ||
    m === 'IFCTEXT' ||
    m === 'IFCIDENTIFIER' ||
    m === 'IFCSTRING'
  ) {
    return ['xs:string'];
  }
  return [];
}
