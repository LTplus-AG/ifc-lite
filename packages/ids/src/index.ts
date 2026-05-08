/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/ids - IDS (Information Delivery Specification) support
 *
 * Full support for buildingSMART IDS 1.0 with:
 * - IDS XML parsing
 * - All facet types (Entity, Attribute, Property, Classification, Material, PartOf)
 * - All constraint types (Simple, Pattern, Enumeration, Bounds)
 * - Multi-language translation (EN, DE, FR)
 * - Human-readable validation reports
 */

// ============================================================================
// Types
// ============================================================================

export type {
  // Document structure
  IDSDocument,
  IDSInfo,
  IDSSpecification,
  IDSApplicability,
  IDSRequirement,
  IFCVersion,
  RequirementOptionality,

  // Facets
  IDSFacet,
  FacetType,
  IDSEntityFacet,
  IDSAttributeFacet,
  IDSPropertyFacet,
  IDSClassificationFacet,
  IDSMaterialFacet,
  IDSPartOfFacet,
  PartOfRelation,

  // Constraints
  IDSConstraint,
  IDSSimpleValue,
  IDSPatternConstraint,
  IDSEnumerationConstraint,
  IDSBoundsConstraint,

  // Validation results
  IDSValidationReport,
  IDSModelInfo,
  IDSValidationSummary,
  IDSSpecificationResult,
  IDSCardinalityResult,
  IDSEntityResult,
  IDSRequirementResult,
  IDSFailureDetail,
  FailureType,

  // Data access
  IFCDataAccessor,
  PropertyValueResult,
  PropertySetInfo,
  ClassificationInfo,
  MaterialInfo,
  ParentInfo,

  // Options
  ValidatorOptions,
  ValidationProgress,

  // Translation
  SupportedLocale,
  TranslationService,
} from './types.js';

// ============================================================================
// Parser
// ============================================================================

export { parseIDS, IDSParseError } from './parser/xml-parser.js';

// ============================================================================
// Validation
// ============================================================================

export { validateIDS } from './validation/validator.js';

// ============================================================================
// Facets
// ============================================================================

export {
  checkFacet,
  filterByFacet,
  checkEntityFacet,
  filterByEntityFacet,
  checkAttributeFacet,
  checkPropertyFacet,
  checkClassificationFacet,
  checkMaterialFacet,
  checkPartOfFacet,
  type FacetCheckResult,
} from './facets/index.js';

// ============================================================================
// Constraints
// ============================================================================

export {
  matchConstraint,
  formatConstraint,
  getConstraintMismatchReason,
} from './constraints/index.js';

// ============================================================================
// Audit (IDS document correctness)
// ============================================================================

export { auditIDSDocument, auditIDSStructure } from './audit/index.js';
export type {
  IDSAuditCode,
  IDSAuditIssue,
  IDSAuditOptions,
  IDSAuditReport,
  IDSAuditSeverity,
} from './audit/types.js';

// ============================================================================
// Translation
// ============================================================================

export { createTranslationService } from './translation/index.js';

// Re-export locale data for customization
export { en, de, fr } from './translation/locales/index.js';
