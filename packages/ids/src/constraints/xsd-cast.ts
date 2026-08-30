/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XSD strict-cast helpers shared by the attribute and property facets.
 *
 * Mirrors what upstream `IDS-Audit-tool` accepts before doing the value
 * comparison.
 *
 * NOT `TryParse`, which this said until #3336: upstream decides these with
 * GENERATED REGEXES (`ids-lib.codegen/XmlSchema_XsTypesGenerator.cs`), and its
 * xs:double pattern is neither .NET nor XSD. It takes `+INF` (an XSD 1.1
 * spelling) while rejecting bare `INF` (the 1.0 one), and rejects `Infinity`
 * (the .NET one). Parity with upstream is the contract, so that is what these
 * arms implement. An IDS literal must cast successfully under at least one
 * of the slot's declared XSD types — `xs:integer` rejects `42.0`,
 * `xs:double` accepts either, etc.
 */

import { isWhollyNumeric } from '@ifc-lite/encoding';

/**
 * The specials upstream's xs:double pattern accepts, spelled exactly as it
 * spells them:
 *
 *     ^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$
 *
 * Bare `INF` is absent because that pattern has `\+INF`, not `\+?INF`; and
 * `Infinity` because it appears in neither upstream nor XSD.
 */
export const XSD_NUMERIC_SPECIALS = new Set(['NaN', '+INF', '-INF']);

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
      // The finite part goes through the shared linear scan, not a regex: the
      // natural pattern `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` is the
      // #3113 shape, quadratic on a failing match, and an IDS literal is as
      // untrusted as the file it came out of.
      //
      // Deliberate deviation from upstream (#3336). Every part of upstream's
      // pattern is optional, so it accepts a family of digitless and
      // mantissa-less forms that are not numbers: "", "+", ".", "-", "+.",
      // "-.", and the exponent-only class "e5" / "+e5" / ".e5". Those fall out
      // of how the regex is written rather than being a contract, and an empty
      // string is not a double, so the finite scan keeps rejecting them.
      //
      // NOT an exhaustive list -- the family is larger than the rows pinned in
      // xsd-cast-specials.test.ts, which are representatives.
      return isWhollyNumeric(value) || XSD_NUMERIC_SPECIALS.has(value);
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

/**
 * `IfcTimeStamp`'s XSD types are the one answer here that depends on the
 * schema version, so the mapper takes it rather than returning a union that
 * is wrong somewhere. See the `IFCTIMESTAMP` branch below.
 *
 * Callers that genuinely have no version pass `undefined` and get the union
 * across versions — permissive, which for a cast GATE means it defers rather
 * than rejecting a value some schema allows.
 */
export function ifcMeasureToXsdTypes(
  measure: string | undefined,
  schemaVersion?: string | undefined
): readonly string[] {
  if (!measure) return [];
  const m = measure.toUpperCase();
  const override = MEASURE_XSD_OVERRIDES.get(m);
  if (override) return override;
  if (m === 'IFCINTEGER' || m === 'IFCCOUNTMEASURE') return ['xs:integer'];
  if (m === 'IFCBOOLEAN') return ['xs:boolean'];
  if (m === 'IFCLOGICAL') return ['xs:boolean', 'xs:string'];
  if (m === 'IFCDATE') return ['xs:date'];
  if (m === 'IFCDATETIME') return ['xs:dateTime'];
  if (m === 'IFCDURATION') return ['xs:duration'];
  // `TYPE IfcTimeStamp = INTEGER;` — a UNIX epoch second, not an ISO-8601
  // duration. It was bundled onto the `IFCDURATION` row above on the strength
  // of the name, which made this gate reject every value a timestamp property
  // can legally hold. The generated `xsdTypesByEntity` table — the SAME
  // question, answered from upstream `SchemaInfo.Attributes.g.cs`, and what
  // the attribute facet gates on — answers PER SCHEMA VERSION, and it splits:
  // `IfcOwnerHistory.CreationDate` carries `["xs:integer"]` under IFC2X3 and
  // `["xs:dateTime","xs:integer"]` under IFC4 and IFC4X3.
  //
  // So there is no single correct answer to give, and taking the union ACROSS
  // versions would recreate the disagreement in the other direction: under
  // IFC2X3 an ISO-8601 date-time literal would pass this gate and be rejected
  // by the attribute facet, on the same file. Swapping a total false-REJECT
  // for a narrower false-ACCEPT is not a fix for "the two gates must agree",
  // so answer per version instead and let the caller supply it.
  //
  // With no version the union is returned: a caller that cannot say which
  // schema it is reading gets the permissive answer, which for a gate means
  // deferring rather than rejecting a value some schema allows.
  if (m === 'IFCTIMESTAMP') {
    if (schemaVersion === undefined) return ['xs:integer', 'xs:dateTime'];
    return schemaVersion.toUpperCase() === 'IFC2X3'
      ? ['xs:integer']
      : ['xs:integer', 'xs:dateTime'];
  }
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
