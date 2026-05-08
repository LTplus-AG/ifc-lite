/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XSD-level checks for an IDS document.
 *
 * Rather than ship a full XSD interpreter (or pull `libxml2-wasm` into a
 * TypeScript package), we hard-code the rules from `ids.xsd` 1.0 — the
 * schema is small, finite and slow-moving. Each check below corresponds to
 * a constraint that's expressible in the XSD; the references in comments
 * point at the relevant element/attribute definition.
 */

import type {
  FacetType,
  IDSConstraint,
  IDSDocument,
  IDSFacet,
  IDSSpecification,
  IFCVersion,
} from '../../types.js';
import type { IDSAuditIssue } from '../types.js';

const ALLOWED_IFC_VERSIONS: ReadonlyArray<IFCVersion> = [
  'IFC2X3',
  'IFC4',
  'IFC4X3_ADD2',
  'IFC4X3',
];

const RECOGNISED_IFC_VERSION_TOKENS = new Set([
  'IFC2X3',
  'IFC4',
  'IFC4X3',
  'IFC4X3_ADD2',
]);

function isRecognisedIfcVersionToken(t: string): boolean {
  return RECOGNISED_IFC_VERSION_TOKENS.has(
    t.toUpperCase().replace(/[^A-Z0-9_]/g, '')
  );
}

// Facets that may appear inside an `<applicability>` block.
const APPLICABILITY_FACETS = new Set<FacetType>([
  'entity',
  'attribute',
  'classification',
  'material',
  'partOf',
  'property',
]);

export function runXsdAudit(doc: IDSDocument): IDSAuditIssue[] {
  const issues: IDSAuditIssue[] = [];
  if (!doc.info.title || doc.info.title.trim() === '' || doc.info.title === 'Untitled IDS') {
    // The XSD makes <title> mandatory and non-empty. The parser falls back
    // to "Untitled IDS" when missing — we treat that synthetic value as
    // "title was missing in source".
    issues.push({
      severity: 'error',
      code: 'E_XSD_REQUIRED_ATTR',
      message: 'IDS document is missing a non-empty <info><title> element',
      path: 'info.title',
    });
  }
  doc.specifications.forEach((spec, i) => auditSpecification(spec, i, issues));
  return issues;
}

function auditSpecification(
  spec: IDSSpecification,
  i: number,
  issues: IDSAuditIssue[]
): void {
  const path = `specifications[${i}]`;
  if (!spec.name || spec.name.trim() === '' || /^Specification \d+$/.test(spec.name)) {
    issues.push({
      severity: 'error',
      code: 'E_XSD_REQUIRED_ATTR',
      message: 'specification is missing a non-empty @name attribute',
      path: `${path}.name`,
    });
  }
  if (!spec.ifcVersions || spec.ifcVersions.length === 0) {
    issues.push({
      severity: 'error',
      code: 'E_XSD_REQUIRED_ATTR',
      message: 'specification is missing the @ifcVersion attribute',
      path: `${path}.ifcVersion`,
    });
  } else {
    for (const v of spec.ifcVersions) {
      if (!ALLOWED_IFC_VERSIONS.includes(v)) {
        issues.push({
          severity: 'error',
          code: 'E_XSD_ENUM',
          message: `@ifcVersion "${v}" is not in {IFC2X3, IFC4, IFC4X3_ADD2}`,
          path: `${path}.ifcVersion`,
          detail: { value: v },
        });
      }
    }
  }
  // The parser silently drops tokens it can't normalise. Re-inspect the
  // raw attribute string so authoring mistakes like
  // `ifcVersion="IFC2X3 INVALIDIFCVERSION"` get flagged.
  if (spec.ifcVersionRaw) {
    const tokens = spec.ifcVersionRaw.split(/\s+/).filter((t) => t.length > 0);
    for (const t of tokens) {
      if (!isRecognisedIfcVersionToken(t)) {
        issues.push({
          severity: 'error',
          code: 'E_XSD_ENUM',
          message: `@ifcVersion token "${t}" is not in {IFC2X3, IFC4, IFC4X3_ADD2}`,
          path: `${path}.ifcVersion`,
          detail: { value: t },
        });
      }
    }
  }
  if (spec.applicability.facets.length === 0) {
    issues.push({
      severity: 'error',
      code: 'E_XSD_STRUCTURE',
      message: 'specification has an empty <applicability> — at least one facet is required',
      path: `${path}.applicability`,
    });
  }
  spec.applicability.facets.forEach((facet, fi) => {
    auditFacet(facet, `${path}.applicability.facets[${fi}]`, issues);
  });
  if (spec.requirements.length === 0) {
    // The XSD allows zero requirements but conventional authoring tools
    // surface this as a warning — a spec with no requirements does nothing.
    issues.push({
      severity: 'warning',
      code: 'E_XSD_STRUCTURE',
      message: 'specification has no <requirements>; matched entities will not be checked',
      path: `${path}.requirements`,
    });
  }
  spec.requirements.forEach((req, ri) => {
    auditFacet(req.facet, `${path}.requirements[${ri}]`, issues);
  });
}

function auditFacet(
  facet: IDSFacet,
  path: string,
  issues: IDSAuditIssue[]
): void {
  if (!APPLICABILITY_FACETS.has(facet.type)) {
    issues.push({
      severity: 'error',
      code: 'E_XSD_STRUCTURE',
      message: `unknown facet type "${facet.type}"`,
      path,
      facetType: facet.type,
    });
    return;
  }

  switch (facet.type) {
    case 'entity':
      checkConstraintRequired(facet.name, `${path}.name`, 'entity.name', issues, facet.type);
      break;
    case 'attribute':
      checkConstraintRequired(facet.name, `${path}.name`, 'attribute.name', issues, facet.type);
      break;
    case 'property':
      checkConstraintRequired(
        facet.propertySet,
        `${path}.propertySet`,
        'property.propertySet',
        issues,
        facet.type
      );
      checkConstraintRequired(
        facet.baseName,
        `${path}.baseName`,
        'property.baseName',
        issues,
        facet.type
      );
      break;
    case 'partOf':
      // Relation/entity validity is per-version and lives in the IFC
      // schema audit pass — leave it alone here.
      break;
    case 'classification':
    case 'material':
      // Both facets allow all-optional fields per the XSD; no required
      // attributes to check here.
      break;
  }
}

function checkConstraintRequired(
  c: IDSConstraint | undefined,
  path: string,
  field: string,
  issues: IDSAuditIssue[],
  facetType: FacetType
): void {
  if (!c) {
    issues.push({
      severity: 'error',
      code: 'E_XSD_REQUIRED_ATTR',
      message: `${field} is required`,
      path,
      facetType,
    });
    return;
  }
  if (c.type === 'simpleValue' && (!c.value || c.value.trim() === '')) {
    issues.push({
      severity: 'error',
      code: 'E_XSD_REQUIRED_ATTR',
      message: `${field} must have a non-empty value`,
      path,
      facetType,
    });
  }
}
