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
 * - Multi-language translation (EN, DE, FR, IT)
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

export { parseIDS, IDSParseError, type ParseIDSOptions } from './parser/xml-parser.js';

// ============================================================================
// Writer
// ============================================================================

// The one IDS 1.0 writer (ADR-005): `@ifc-lite/rules`' `ruleSetToIds` and the
// viewer's reviewed IDS drafts serialise through it.
export { writeIdsXml, type IdsXmlFormat, type IdsXmlWriteOptions } from './writer/index.js';

// ============================================================================
// IDS 1.1 PREVIEW (IDS-124, ADR-011) — unstable, opt-in, follows upstream
// ============================================================================

// Candidate features of the unreleased IDS 1.1, each tied to its upstream
// issue. Off unless a caller passes `preview: { ids11: true }`.
export {
  IDS11_PREVIEW_FEATURES,
  IDS11PreviewRequiredError,
  findIds11Features,
  type IDS11FeatureInfo,
} from './preview/features.js';
export type {
  IDSPreviewFlags,
  IDS11PreviewFeature,
  IDS11FeatureUse,
  IDS11FacetUri,
  IDS11FacetInstructions,
  IDS11ToleranceRule,
} from './preview/types.js';

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

export { boundedPassRate, passRateBand, type PassRateBand } from './validation/pass-rate.js';

// IFC2X3 occurrence/type mapping table (IfcAirTerminal -> IfcFlowTerminal +
// IfcAirTerminalType): shared with `@ifc-lite/ids-authoring`'s gate so an
// authored IFC2X3 facet accepts the same aliases the audit and checker do.
export {
  rowForAlias as ifc2x3TypeMappingForAlias,
  type Ifc2x3TypeMappingRow,
} from './facets/ifc2x3-type-mapping.js';

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

// Matching and non-matching example strings for an XSD pattern, verified
// against `matchConstraint` (pattern explanations, synthetic test fixtures).
export {
  generatePatternExamples,
  type PatternExamples,
  type PatternExampleOptions,
} from './constraints/xsd-examples.js';

// IFC4 class names an IFC2X3 entity facet may use through buildingSMART's
// occurrence/type mapping table, so authoring tools (`@ifc-lite/ids-authoring`
// lint) do not report them as missing from IFC2X3.
export { IFC2X3_MAPPED_ALIASES } from './facets/ifc2x3-type-mapping.js';

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
