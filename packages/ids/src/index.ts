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

  // Validation results — generalised report (issue #5138)
  ValidationSource,
  SpecificationSummary,
  RequirementSummary,
  CheckKind,
  FailureReasonCode,
  SetResult,
  RequirementResult,
  EntityResult,
  SpecificationResult,
  ValidationReport,
  ValidationModelInfo,

  // Validation results — IDS-specific narrowings
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
// Material bridge
// ============================================================================

// Flattens the parser's hierarchical material graph into flat `{name,
// category}` candidates, duplicating each Category under its own entry.
// Shared with the viewer's selector-adapted `material` filter rule so
// "does material=X match this element" has exactly one implementation
// instead of the IDS material facet and the viewer growing separate,
// driftable answers to the same question.
export { flattenMaterials } from './bridge/materials.js';

// ============================================================================
// Validation
// ============================================================================

export { validateIDS, calculateSummary } from './validation/validator.js';

// Runtime narrowing for the generalised report (#5138) — see report-guards.ts.
export { isIDSValidationReport } from './report-guards.js';

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

// The one XSD-regex -> JS-regex translator, shared with `@ifc-lite/rules`'
// IDS import (#5225) so an imported pattern means what the checker reads.
export { translateXsdRegex, type TranslateResult } from './constraints/xsd-regex.js';

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
