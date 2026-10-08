/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-dataType / xs:restriction-base compatibility checks, split out of
 * `index.ts` to keep that module under this package's line-count
 * budget. Pure checks with no dependency on the rest of the schema
 * audit beyond the shared `IfcPropertyInfo` / `IDSAuditIssue` types.
 */

import type { IfcPropertyInfo } from '@ifc-lite/data';
import type { IDSConstraint } from '../../types.js';
import type { IDSAuditIssue } from '../types.js';
import { isValidLexicalForXsType } from '../coherence/index.js';

export function checkDataTypeMatch(
  prop: IfcPropertyInfo,
  declared: string,
  path: string,
  psetName: string,
  propName: string,
  issues: IDSAuditIssue[]
): void {
  // `IDSPROPERTYSINGLEVALUE` etc. — the IDS spec uses the IFC pset
  // template type name, not the IFC datatype. We allow both: if the
  // declared value matches either the property's IFC datatype (e.g.
  // `IfcLabel`) or the canonical IDS template form (`IFCPROPERTYSINGLEVALUE`
  // for kind=`single`, `IFCPROPERTYENUMERATEDVALUE` for kind=`enumeration`,
  // etc.), we don't warn.
  //
  // Enumerated properties (PEnum_*) carry no `dataType` in the pset
  // definitions — their values serialize as IfcLabel, so IFCLABEL is the
  // canonical IDS dataType for them. Mirrors upstream IdsLib's
  // `HasDataTypes` (EnumerationPropertyType → ["IFCLABEL"]).
  const declaredUpper = declared.toUpperCase();
  const expected =
    prop.dataType ?? (prop.kind === 'enumeration' ? 'IfcLabel' : undefined);
  if (expected && expected.toUpperCase() === declaredUpper) return;
  const idsTemplate = idsTemplateForKind(prop.kind);
  if (idsTemplate && declaredUpper === idsTemplate) return;
  // No backing datatype known for this property shape (e.g. table
  // values, which carry two datatypes we don't model) — skip rather
  // than guess, like upstream when `HasDataTypes` returns false.
  if (!expected) return;
  // Upstream IDS-Audit-tool treats this as an error (Report 303 family)
  // — declaring a different dataType than the standard pset specifies is
  // an authoring mistake, not a stylistic warning.
  issues.push({
    severity: 'error',
    code: 'W_IFC_DATATYPE_MISMATCH',
    message: `${psetName}.${propName} is typed ${expected} in the standard, not ${declared}`,
    path: `${path}.dataType`,
    facetType: 'property',
    detail: {
      expected,
      actual: declared,
      property: propName,
    },
  });
}

/**
 * Upstream IDS-Audit-tool's Report 303 — when a `<value>` carries an
 * `xs:restriction`, its `@base` must be compatible with the dataType's
 * backing XSD type. The parser preserves the raw `@base` attribute on
 * pattern/enumeration/bounds constraints, so we use that directly when
 * present and only fall back to inferring from the restriction shape
 * when the source XML didn't carry a base.
 *
 * Inferring from shape alone is ambiguous: `<xs:enumeration value="1"/>`
 * looks like a string enumeration unless we know the parent
 * `<xs:restriction base="xs:integer">`.
 */
export function checkRestrictionBase(
  c: IDSConstraint,
  backingType: string,
  dataType: string,
  path: string,
  issues: IDSAuditIssue[],
  facetType: 'property' | 'attribute' = 'property'
): void {
  // Only restrictions can mismatch — simpleValue is always treated as
  // string-compatible by the IDS XSD.
  if (c.type === 'simpleValue') return;
  const declaredBase =
    c.type === 'pattern' || c.type === 'enumeration' || c.type === 'bounds'
      ? c.base
      : undefined;
  let inferred: string | undefined;
  if (declaredBase) {
    inferred = declaredBase;
  } else {
    switch (c.type) {
      case 'pattern':
      case 'enumeration':
        inferred = 'xs:string';
        break;
      case 'bounds':
        if (
          typeof c.length === 'number' ||
          typeof c.minLength === 'number' ||
          typeof c.maxLength === 'number'
        ) {
          inferred = 'xs:string';
        } else {
          inferred = 'xs:double';
        }
        break;
    }
  }
  if (!inferred) return;
  if (!isXsTypeCompatible(inferred, backingType)) {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_BASE_MISMATCH',
      message: `xs:restriction base (${inferred}) is not compatible with dataType "${dataType}" (backing ${backingType})`,
      path,
      facetType,
      detail: { inferred, expected: backingType, dataType },
    });
  }
}

/**
 * A `<simpleValue>` compared against a typed value must be a literal of
 * that type's backing XSD type (upstream Report 305 family; IDS-005):
 * `FALSE` is no `xs:boolean` (booleans are lowercase), `42.0` and `42.`
 * are no `xs:integer`, `42,3` is no `xs:double`. Such a value can never
 * equal a real one, so the requirement could only ever fail.
 */
export function checkSimpleValueLexical(
  c: IDSConstraint,
  backingType: string,
  dataType: string,
  path: string,
  facetType: 'property' | 'attribute',
  issues: IDSAuditIssue[]
): void {
  if (c.type !== 'simpleValue' || c.value === '') return;
  if (isValidLexicalForXsType(c.value, backingType)) return;
  issues.push({
    severity: 'error',
    code: 'E_RESTRICTION_VALUE_MISMATCH',
    message: `value "${c.value}" is not a valid ${backingType} literal, so it can never equal a ${dataType} value`,
    path,
    facetType,
    detail: { value: c.value, base: backingType, dataType },
  });
}

/**
 * XSD type compatibility per upstream `IdsProperty.cs`: the restriction
 * `@base` must equal the IFC dataType's backing XSD type exactly. The
 * one wrinkle is the `xs:double` / `xs:decimal` / `xs:float` family —
 * upstream's `XsTypes.IsValid` accepts any of them as
 * floating-point — so those three are treated as equivalent.
 *
 * `xs:integer` is *not* promoted to floats: upstream rejects an
 * `xs:integer` restriction on an `IFCREAL`-backing property since
 * decimal values would be invalid against the integer pattern.
 */
function isXsTypeCompatible(inferred: string, expected: string): boolean {
  if (inferred === expected) return true;
  const floats = new Set(['xs:double', 'xs:decimal', 'xs:float']);
  if (floats.has(inferred) && floats.has(expected)) return true;
  return false;
}

function idsTemplateForKind(kind: IfcPropertyInfo['kind']): string | undefined {
  switch (kind) {
    case 'single':
      return 'IFCPROPERTYSINGLEVALUE';
    case 'enumeration':
      return 'IFCPROPERTYENUMERATEDVALUE';
    case 'list':
      return 'IFCPROPERTYLISTVALUE';
    case 'bounded':
      return 'IFCPROPERTYBOUNDEDVALUE';
    case 'reference':
      return 'IFCPROPERTYREFERENCEVALUE';
    default:
      return undefined;
  }
}

