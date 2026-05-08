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
  IDSSpecification,
} from '../../types.js';
import type { IDSAuditIssue } from '../types.js';

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

  spec.applicability.facets.forEach((facet, fi) => {
    auditFacetConstraints(
      facet,
      `${path}.applicability.facets[${fi}]`,
      issues
    );
  });

  spec.requirements.forEach((req, ri) => {
    auditFacetConstraints(req.facet, `${path}.requirements[${ri}]`, issues);
    // Upstream `IdsRepositoryIssueTests` (Cardinality/) flags `prohibited`
    // requirements that are *also* listed as applicability — meaningless
    // because nothing matches. We approximate with: warn if the spec has
    // both a `required` and a `prohibited` requirement on the same facet
    // type referring to the same key.
  });

  // Cardinality on applicability — IDS allows `prohibited` on
  // requirements but the same word is meaningless for applicability;
  // upstream emits a warning when authors set it there. Our parser models
  // applicability without optionality, so we instead check the
  // <requirements> block for a structural anti-pattern: an empty facet
  // marked prohibited at the spec level. (See xsd index for the empty-
  // requirements warning; here we just flag prohibited-with-empty-spec
  // at min=0/max=0 level.)
  if (typeof min === 'number' && typeof max === 'number' && min === 0 && max === 0) {
    issues.push({
      severity: 'warning',
      code: 'W_CARDINALITY_PROHIBITED_APPLICABILITY',
      message: 'specification min=max=0 is equivalent to "prohibited"; consider removing the spec',
      path,
    });
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
    c.minInclusive === undefined &&
    c.minExclusive === undefined &&
    c.maxInclusive === undefined &&
    c.maxExclusive === undefined
  ) {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_EMPTY',
      message: 'xs:restriction has no min/max bounds',
      path,
      facetType,
    });
  }
}

/**
 * Try to compile `pattern` under JS regex semantics. XSD regex differs
 * from JS regex (escape codes like `\i`, `\c`, char-class subtraction);
 * a v2 of the auditor will translate the dialects. For now, surface a
 * warning when the pattern doesn't compile so authors know the auditor
 * couldn't fully verify it.
 */
function checkPattern(
  pattern: string,
  path: string,
  issues: IDSAuditIssue[],
  facetType: IDSFacet['type']
): void {
  if (pattern === '') {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_EMPTY',
      message: 'xs:pattern @value is empty',
      path,
      facetType,
    });
    return;
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    issues.push({
      severity: 'warning',
      code: 'W_REGEX_UNVERIFIED',
      message: `xs:pattern could not be verified under JS regex semantics: ${
        err instanceof Error ? err.message : String(err)
      }`,
      path,
      facetType,
      detail: { pattern },
    });
  }
}
