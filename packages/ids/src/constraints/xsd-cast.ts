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

const INTEGER_RE = /^[+-]?\d+$/;
const DOUBLE_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
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
      return DOUBLE_RE.test(value);
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
export function ifcMeasureToXsdTypes(measure: string | undefined): readonly string[] {
  if (!measure) return [];
  const m = measure.toUpperCase();
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
