/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Restriction & cardinality coherence checks.
 *
 * Catches authoring mistakes that aren't strictly XSD violations but
 * make a specification ill-formed in practice — empty enumerations,
 * inverted bounds, regex patterns that don't compile, prohibited
 * cardinality on applicability blocks, etc.
 */

import type {
  IDSConstraint,
  IDSDocument,
  IDSFacet,
  IDSRequirement,
  IDSSpecification,
} from '../../types.js';
import type { IDSAuditIssue } from '../types.js';
import { compileXsdRegex } from './regex.js';

export function runCoherenceAudit(doc: IDSDocument): IDSAuditIssue[] {
  const issues: IDSAuditIssue[] = [];
  doc.specifications.forEach((spec, i) => {
    auditSpec(spec, `specifications[${i}]`, issues);
  });
  return issues;
}

function auditSpec(
  spec: IDSSpecification,
  path: string,
  issues: IDSAuditIssue[]
): void {
  // minOccurs / maxOccurs sanity. Spec parses them as numbers (or
  // 'unbounded'); both must be >= 0 and the order must hold.
  const min = spec.minOccurs;
  const max = spec.maxOccurs;
  if (min !== undefined && (!Number.isInteger(min) || min < 0)) {
    issues.push({
      severity: 'error',
      code: 'E_CARDINALITY_INVALID',
      message: `minOccurs must be a non-negative integer; got ${min}`,
      path: `${path}.minOccurs`,
      detail: { value: String(min) },
    });
  }
  if (max !== undefined && max !== 'unbounded') {
    if (!Number.isInteger(max) || max < 0) {
      issues.push({
        severity: 'error',
        code: 'E_CARDINALITY_INVALID',
        message: `maxOccurs must be a non-negative integer or "unbounded"; got ${max}`,
        path: `${path}.maxOccurs`,
        detail: { value: String(max) },
      });
    }
  }
  if (
    typeof min === 'number' &&
    typeof max === 'number' &&
    min > max
  ) {
    issues.push({
      severity: 'error',
      code: 'E_CARDINALITY_INVALID',
      message: `minOccurs (${min}) is greater than maxOccurs (${max})`,
      path: `${path}.minOccurs`,
      detail: { min: min, max: max },
    });
  }

  // Upstream IDS-Audit-tool flags `cardinality` on `<applicability>` —
  // it's meaningless there. (Report 202)
  if (spec.applicability.cardinality) {
    issues.push({
      severity: 'warning',
      code: 'W_CARDINALITY_PROHIBITED_APPLICABILITY',
      message: `cardinality="${spec.applicability.cardinality}" has no effect on <applicability>`,
      path: `${path}.applicability.cardinality`,
    });
  }

  spec.applicability.facets.forEach((facet, fi) => {
    auditFacetConstraints(
      facet,
      `${path}.applicability.facets[${fi}]`,
      issues
    );
  });

  spec.requirements.forEach((req, ri) => {
    auditFacetConstraints(req.facet, `${path}.requirements[${ri}]`, issues);
    auditRequirementCardinality(
      req,
      `${path}.requirements[${ri}]`,
      issues
    );
  });
}

/**
 * Cardinality coherence on a requirement facet (Report 202 upstream).
 *
 * Per upstream IDS-Audit-tool:
 *  - `cardinality="optional"` on a `<property>` requires `@dataType`.
 *  - `cardinality="prohibited"` on a `<property>` is incompatible with
 *    `@dataType` (the property must not exist at all).
 *  - `cardinality="optional"` on `<material>`, `<classification>` and
 *    `<partOf>` requires a value/system/entity to be specified — an
 *    `optional` facet without a constraint is meaningless.
 */
function auditRequirementCardinality(
  req: IDSRequirement,
  path: string,
  issues: IDSAuditIssue[]
): void {
  // The XSD `conditionalCardinality` / `simpleCardinality` enums are
  // case-sensitive lowercase: `required`, `optional`, `prohibited`. The
  // parser preserves the raw value when it didn't match exactly so we
  // can flag mistakes here (`Required`, `Invalid`, empty string, …)
  // rather than silently defaulting to `required`.
  if (req.cardinalityRaw !== undefined) {
    issues.push({
      severity: 'error',
      code: 'E_CARDINALITY_INVALID',
      message: `@cardinality="${req.cardinalityRaw}" is not a valid value; expected one of {required, optional, prohibited}`,
      path: `${path}.cardinality`,
      facetType: req.facet.type,
      detail: { value: req.cardinalityRaw },
    });
  }
  switch (req.facet.type) {
    case 'property': {
      const hasDataType = req.facet.dataType !== undefined;
      if (req.optionality === 'optional' && !hasDataType) {
        issues.push({
          severity: 'error',
          code: 'E_CARDINALITY_INVALID',
          message:
            'optional <property> requirement requires @dataType to be specified',
          path: `${path}.cardinality`,
          facetType: 'property',
        });
      }
      if (req.optionality === 'prohibited' && hasDataType) {
        issues.push({
          severity: 'error',
          code: 'E_CARDINALITY_INVALID',
          message:
            'prohibited <property> requirement is incompatible with @dataType',
          path: `${path}.cardinality`,
          facetType: 'property',
        });
      }
      break;
    }
    case 'material': {
      if (req.optionality === 'optional') {
        const hasValue =
          req.facet.value !== undefined && !isEmptyConstraint(req.facet.value);
        if (!hasValue) {
          issues.push({
            severity: 'error',
            code: 'E_CARDINALITY_INVALID',
            message:
              'optional <material> requirement must specify a non-empty <value> constraint',
            path: `${path}.cardinality`,
            facetType: 'material',
          });
        }
      }
      break;
    }
    case 'classification': {
      if (req.optionality === 'optional') {
        const hasSystem =
          req.facet.system !== undefined &&
          !isEmptyConstraint(req.facet.system);
        const hasValue =
          req.facet.value !== undefined && !isEmptyConstraint(req.facet.value);
        if (!hasSystem && !hasValue) {
          issues.push({
            severity: 'error',
            code: 'E_CARDINALITY_INVALID',
            message:
              'optional <classification> requirement must specify <system> or <value>',
            path: `${path}.cardinality`,
            facetType: 'classification',
          });
        }
      }
      break;
    }
    case 'attribute':
    case 'entity':
    case 'partOf':
      // Attribute/entity/partOf carry their own intrinsic content;
      // cardinality on them is just required/optional/prohibited.
      break;
  }
}

function isEmptyConstraint(c: import('../../types.js').IDSConstraint): boolean {
  switch (c.type) {
    case 'simpleValue':
      return c.value === '' || c.value == null;
    case 'enumeration':
      return c.values.length === 0;
    case 'pattern':
      return c.pattern === '';
    case 'bounds':
      return (
        c.minInclusive === undefined &&
        c.maxInclusive === undefined &&
        c.minExclusive === undefined &&
        c.maxExclusive === undefined &&
        c.length === undefined &&
        c.minLength === undefined &&
        c.maxLength === undefined
      );
  }
}

function auditFacetConstraints(
  facet: IDSFacet,
  path: string,
  issues: IDSAuditIssue[]
): void {
  switch (facet.type) {
    case 'entity':
      check(facet.name, `${path}.name`, issues, facet.type);
      if (facet.predefinedType) {
        check(facet.predefinedType, `${path}.predefinedType`, issues, facet.type);
      }
      break;
    case 'attribute':
      check(facet.name, `${path}.name`, issues, facet.type);
      if (facet.value) check(facet.value, `${path}.value`, issues, facet.type);
      break;
    case 'property':
      check(facet.propertySet, `${path}.propertySet`, issues, facet.type);
      check(facet.baseName, `${path}.baseName`, issues, facet.type);
      if (facet.dataType) check(facet.dataType, `${path}.dataType`, issues, facet.type);
      if (facet.value) check(facet.value, `${path}.value`, issues, facet.type);
      break;
    case 'classification':
      if (facet.system) check(facet.system, `${path}.system`, issues, facet.type);
      if (facet.value) check(facet.value, `${path}.value`, issues, facet.type);
      break;
    case 'material':
      if (facet.value) check(facet.value, `${path}.value`, issues, facet.type);
      break;
    case 'partOf':
      if (facet.entity) {
        auditFacetConstraints(facet.entity, `${path}.entity`, issues);
      }
      break;
  }
}

function check(
  c: IDSConstraint,
  path: string,
  issues: IDSAuditIssue[],
  facetType: IDSFacet['type']
): void {
  switch (c.type) {
    case 'enumeration':
      if (c.values.length === 0) {
        issues.push({
          severity: 'error',
          code: 'E_RESTRICTION_EMPTY',
          message: 'xs:enumeration must have at least one value',
          path,
          facetType,
        });
      } else if (c.values.some((v) => v === '' || v == null)) {
        issues.push({
          severity: 'warning',
          code: 'E_RESTRICTION_EMPTY',
          message: 'xs:enumeration has an empty entry',
          path,
          facetType,
        });
      }
      // When the restriction base is a typed primitive
      // (`xs:double`/`xs:integer`/`xs:boolean`/…), every enumeration
      // value must match the base's lexical space — upstream's
      // `Report 305 BadConstraintValue`. Otherwise an `xs:double`
      // restriction can carry strings like `"12,0"` or `"a"` that
      // would never compare equal to a real numeric value.
      if (c.base) {
        for (const v of c.values) {
          if (v == null || v === '') continue;
          if (!isValidLexicalForXsType(v, c.base)) {
            issues.push({
              severity: 'error',
              code: 'E_RESTRICTION_VALUE_MISMATCH',
              message: `xs:enumeration value "${v}" is not valid for xs:restriction @base="${c.base}"`,
              path,
              facetType,
              detail: { value: v, base: c.base },
            });
          }
        }
      }
      break;
    case 'bounds':
      checkBounds(c, path, issues, facetType);
      break;
    case 'pattern':
      checkPattern(c.pattern, path, issues, facetType);
      break;
    case 'simpleValue':
      // No coherence check beyond the XSD's required-non-empty check,
      // which we already do in the XSD audit.
      break;
  }
}

function checkBounds(
  c: Extract<IDSConstraint, { type: 'bounds' }>,
  path: string,
  issues: IDSAuditIssue[],
  facetType: IDSFacet['type']
): void {
  const lo = c.minInclusive ?? c.minExclusive;
  const hi = c.maxInclusive ?? c.maxExclusive;
  if (
    typeof lo === 'number' &&
    typeof hi === 'number' &&
    lo > hi
  ) {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_RANGE',
      message: `xs:restriction bounds inverted: lower (${lo}) > upper (${hi})`,
      path,
      facetType,
      detail: { min: lo, max: hi },
    });
  }
  if (
    typeof c.minLength === 'number' &&
    typeof c.maxLength === 'number' &&
    c.minLength > c.maxLength
  ) {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_RANGE',
      message: `xs:restriction lengths inverted: minLength (${c.minLength}) > maxLength (${c.maxLength})`,
      path,
      facetType,
      detail: { min: c.minLength, max: c.maxLength },
    });
  }
  if (
    typeof c.length === 'number' &&
    (typeof c.minLength === 'number' || typeof c.maxLength === 'number')
  ) {
    issues.push({
      severity: 'warning',
      code: 'E_RESTRICTION_RANGE',
      message: 'xs:length is mutually exclusive with xs:minLength/xs:maxLength',
      path,
      facetType,
    });
  }
  const empty =
    c.minInclusive === undefined &&
    c.minExclusive === undefined &&
    c.maxInclusive === undefined &&
    c.maxExclusive === undefined &&
    c.length === undefined &&
    c.minLength === undefined &&
    c.maxLength === undefined;
  if (empty) {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_EMPTY',
      message: 'xs:restriction has no min/max bounds or length facets',
      path,
      facetType,
    });
  }
}

/**
 * Validate `pattern` against XSD regex semantics by translating XSD-only
 * escape codes to JS regex equivalents (cf. upstream `XmlRegex.cs`).
 *
 * Translation handles `\i`/`\c`/`\d`/`\w` and their negations via
 * Unicode property escapes (compiled with the `u` flag). Char-class
 * subtraction (`[a-z-[aeiou]]`) is XSD-only and surfaces as
 * `W_REGEX_UNVERIFIED`. Any remaining syntactic errors are real
 * authoring mistakes and surface as `E_RESTRICTION_EMPTY` (upstream
 * Report 109).
 */
function checkPattern(
  pattern: string,
  path: string,
  issues: IDSAuditIssue[],
  facetType: IDSFacet['type']
): void {
  const result = compileXsdRegex(pattern);
  if (result.ok) return;
  if (result.severity === 'error') {
    issues.push({
      severity: 'error',
      code: pattern === '' ? 'E_RESTRICTION_EMPTY' : 'E_RESTRICTION_EMPTY',
      message:
        pattern === ''
          ? 'xs:pattern @value is empty'
          : `xs:pattern is not a valid regular expression: ${result.reason}`,
      path,
      facetType,
      detail: pattern === '' ? undefined : { pattern },
    });
    return;
  }
  issues.push({
    severity: 'warning',
    code: 'W_REGEX_UNVERIFIED',
    message: `xs:pattern uses XSD-specific syntax not verifiable in JS: ${result.reason}`,
    path,
    facetType,
    detail: { pattern },
  });
}

/**
 * Validate that `value` matches the lexical space of the supplied XSD
 * primitive base. Mirrors upstream `XsTypes.IsValid` — same regexes,
 * just expressed in JS. Used by the enumeration coherence check to
 * flag entries like `<xs:enumeration value="12,0"/>` under a
 * `<xs:restriction base="xs:double">`.
 */
const XS_VALUE_REGEX: Record<string, RegExp> = {
  // Lifted from upstream `XmlRegex.cs` static fields.
  'xs:integer': /^[+-]?(\d+)$/,
  'xs:double': /^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/,
  'xs:float': /^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/,
  'xs:decimal': /^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/,
  'xs:boolean': /^(true|false|0|1)$/,
  'xs:date': /^\d{4}-\d{2}-\d{2}(Z|([+-]\d{2}:\d{2}))?$/,
  'xs:dateTime':
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|([+-]\d{2}:\d{2}))?$/,
  'xs:time': /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|([+-]\d{2}:\d{2}))?$/,
  'xs:duration': /^[-+]?P(\d+Y)?(\d+M)?(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?$/,
};

function isValidLexicalForXsType(value: string, base: string): boolean {
  const rx = XS_VALUE_REGEX[base];
  if (!rx) return true; // base we don't recognise → don't fabricate errors
  // For doubles/floats/decimals, an empty lexeme is technically allowed
  // by the regex but isn't a meaningful number — reject.
  if (
    (base === 'xs:double' ||
      base === 'xs:float' ||
      base === 'xs:decimal') &&
    !/[0-9]/.test(value)
  ) {
    return false;
  }
  return rx.test(value);
}
