/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute facet checker
 */

import type { IDSAttributeFacet, IFCDataAccessor } from '../types.js';
import type { FacetCheckResult } from './index.js';
import { matchConstraint, formatConstraint, type MatchOptions } from '../constraints/index.js';

/** Attribute name matching is case-insensitive (IFC schema-defined names) */
const ATTR_NAME_OPTS: MatchOptions = { caseInsensitive: true };

/** Standard IFC attributes that can be checked */
const STANDARD_ATTRIBUTES = [
  'Name',
  'Description',
  'ObjectType',
  'Tag',
  'GlobalId',
  'LongName',
] as const;

/**
 * Check if an entity matches an attribute facet
 */
export function checkAttributeFacet(
  facet: IDSAttributeFacet,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  const attrNameConstraint = facet.name;

  // Resolve which attribute name(s) to check
  let attrNamesToCheck: string[];

  if (attrNameConstraint.type === 'simpleValue') {
    attrNamesToCheck = [attrNameConstraint.value];
  } else {
    // For patterns/enumerations, prefer the entity's own schema-defined
    // attribute list (so e.g. `IfcMaterialLayerSet.LayerSetName` shows
    // up for a `.*Name.*` pattern). Fall back to the small standard
    // list when the accessor doesn't surface one.
    const allNames = accessor.getAttributeNames?.(expressId);
    const candidates = allNames && allNames.length > 0 ? allNames : STANDARD_ATTRIBUTES;
    attrNamesToCheck = candidates.filter((a) =>
      matchConstraint(attrNameConstraint, a, ATTR_NAME_OPTS)
    );

    if (attrNamesToCheck.length === 0) {
      return {
        passed: false,
        expectedValue: facet.value
          ? formatConstraint(facet.value)
          : `attribute matching ${formatConstraint(attrNameConstraint)} to exist`,
        failure: {
          type: 'ATTRIBUTE_MISSING',
          field: formatConstraint(attrNameConstraint),
          expected: formatConstraint(attrNameConstraint),
        },
      };
    }
  }

  // Check each matching attribute; return on first pass, track most specific failure
  let bestFailure: FacetCheckResult | undefined;

  for (const attrName of attrNamesToCheck) {
    const result = checkSingleAttribute(facet, attrName, expressId, accessor);
    if (result.passed) {
      return result;
    }

    // Prefer value/pattern mismatch over attribute-missing (more specific)
    if (
      !bestFailure ||
      (result.failure?.type !== 'ATTRIBUTE_MISSING' && bestFailure.failure?.type === 'ATTRIBUTE_MISSING')
    ) {
      bestFailure = result;
    }
  }

  // Return the most specific failure we found
  return bestFailure!;
}

/**
 * Check a single attribute by name against the facet's value constraint
 */
function checkSingleAttribute(
  facet: IDSAttributeFacet,
  attrName: string,
  expressId: number,
  accessor: IFCDataAccessor
): FacetCheckResult {
  const attrValue = getAttributeValue(attrName, expressId, accessor);

  // Distinguish "slot truly absent" (undefined/null — IFC `$`) from
  // "slot explicitly empty" (`''`). Per IDS spec the latter is a
  // value mismatch, not a missing attribute, so optional facets won't
  // give it a free pass.
  if (attrValue === undefined || attrValue === null) {
    return {
      passed: false,
      actualValue: undefined,
      expectedValue: facet.value
        ? formatConstraint(facet.value)
        : `attribute "${attrName}" to exist`,
      failure: {
        type: 'ATTRIBUTE_MISSING',
        field: attrName,
        expected: facet.value ? formatConstraint(facet.value) : 'any value',
      },
    };
  }
  if (attrValue === '') {
    return {
      passed: false,
      actualValue: '(empty)',
      expectedValue: facet.value
        ? formatConstraint(facet.value)
        : `attribute "${attrName}" must have a non-empty value`,
      failure: {
        type: 'ATTRIBUTE_VALUE_MISMATCH',
        field: attrName,
        actual: '(empty)',
        expected: facet.value ? formatConstraint(facet.value) : 'a non-empty value',
      },
    };
  }

  // If no value constraint, just check existence
  if (!facet.value) {
    return {
      passed: true,
      actualValue: String(attrValue),
      expectedValue: `attribute "${attrName}" to exist`,
    };
  }

  // Strict XSD-cast check: the IDS literal MUST cast successfully under
  // at least one of the attribute's schema-declared XSD types. This
  // rejects `42.0` against an `xs:integer`-only slot like
  // `IfcStairFlight.NumberOfRisers`, even though the numbers compare
  // equal. The accessor returns `undefined` when type info is missing,
  // in which case we skip the gate and fall back to permissive
  // comparison (back-compat for accessors that don't surface schema).
  if (facet.value.type === 'simpleValue') {
    const xsdTypes = accessor.getAttributeXsdTypes?.(expressId, attrName);
    if (xsdTypes && !literalCastsUnderAnyType(facet.value.value, xsdTypes)) {
      return {
        passed: false,
        actualValue: String(attrValue),
        expectedValue: formatConstraint(facet.value),
        failure: {
          type: 'ATTRIBUTE_VALUE_MISMATCH',
          field: attrName,
          actual: String(attrValue),
          expected: formatConstraint(facet.value),
        },
      };
    }
  }

  // Check value constraint
  if (!matchConstraint(facet.value, attrValue)) {
    return {
      passed: false,
      actualValue: String(attrValue),
      expectedValue: formatConstraint(facet.value),
      failure: {
        type:
          facet.value.type === 'pattern'
            ? 'ATTRIBUTE_PATTERN_MISMATCH'
            : 'ATTRIBUTE_VALUE_MISMATCH',
        field: attrName,
        actual: String(attrValue),
        expected: formatConstraint(facet.value),
      },
    };
  }

  return {
    passed: true,
    actualValue: String(attrValue),
    expectedValue: formatConstraint(facet.value),
  };
}

/**
 * Get an attribute value from an entity
 */
function getAttributeValue(
  attrName: string,
  expressId: number,
  accessor: IFCDataAccessor
): string | number | boolean | undefined {
  const normalizedName = attrName.toLowerCase();

  switch (normalizedName) {
    case 'name':
      return accessor.getEntityName(expressId);
    case 'description':
      return accessor.getDescription(expressId);
    case 'objecttype':
      return accessor.getObjectType(expressId);
    case 'globalid':
      return accessor.getGlobalId(expressId);
    default:
      // Try generic attribute access
      return accessor.getAttribute(expressId, attrName);
  }
}

/**
 * XSD strict-cast gate: returns true iff the IDS literal `value` casts
 * successfully under at least one of `xsdTypes`. Mirrors the
 * `int.TryParse` / `double.TryParse` rules upstream IDS-Audit-tool
 * applies before doing the value comparison.
 *
 * - `xs:integer` accepts `[+-]?\d+` only — `42.0` fails.
 * - `xs:double` accepts `[+-]?\d+(\.\d+)?([eE][+-]?\d+)?` — `42`, `42.0`, `1e3` all pass.
 * - `xs:boolean` accepts `true` / `false` (case-sensitive per IDS spec).
 * - `xs:date` accepts `YYYY-MM-DD` (optionally with timezone).
 * - `xs:dateTime` accepts ISO-8601 timestamps.
 * - `xs:duration` accepts ISO-8601 durations (`P1Y2M3DT4H5M6S`).
 * - `xs:string` accepts any text.
 *
 * Unknown types are accepted permissively so a future XSD type doesn't
 * silently break validation.
 */
function literalCastsUnderAnyType(
  value: string,
  xsdTypes: readonly string[]
): boolean {
  return xsdTypes.some((t) => literalCastsUnder(value, t));
}

function literalCastsUnder(value: string, xsdType: string): boolean {
  switch (xsdType) {
    case 'xs:integer':
      return /^[+-]?\d+$/.test(value);
    case 'xs:double':
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);
    case 'xs:boolean':
      return value === 'true' || value === 'false';
    case 'xs:date':
      return /^\d{4}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(value);
    case 'xs:dateTime':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value);
    case 'xs:duration':
      return /^-?P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value);
    case 'xs:string':
      return true;
    default:
      // Unknown XSD type — be permissive rather than reject.
      return true;
  }
}
