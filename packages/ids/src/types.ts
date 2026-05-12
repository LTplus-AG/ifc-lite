/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS (Information Delivery Specification) types
 * Based on buildingSMART IDS 1.0 specification
 */

// ============================================================================
// IDS Document Structure
// ============================================================================

/** IDS Document - root container for the specification */
export interface IDSDocument {
  /** Document metadata */
  info: IDSInfo;
  /** List of specifications */
  specifications: IDSSpecification[];
  /**
   * Raw `xsi:schemaLocation` attribute on the root element, if present.
   * The audit module checks that this points at an IDS XSD URL —
   * upstream IDS-Audit-tool flags references to other XSDs (Report 107).
   */
  schemaLocation?: string;
}

/** IDS Document metadata */
export interface IDSInfo {
  /** Document title */
  title: string;
  /** Copyright notice */
  copyright?: string;
  /** Version string */
  version?: string;
  /** Author name */
  author?: string;
  /** Creation/modification date */
  date?: string;
  /** Purpose description */
  purpose?: string;
  /** Milestone (e.g., "Design", "Construction", "Handover") */
  milestone?: string;
  /** Description */
  description?: string;
}

/** Single specification within an IDS document */
export interface IDSSpecification {
  /** Unique identifier for this specification */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Instructions for compliance */
  instructions?: string;
  /** IFC schema versions this applies to */
  ifcVersions: IFCVersion[];
  /**
   * The raw `@ifcVersion` attribute string, before tokenisation and
   * normalisation. The audit module uses this to flag tokens that were
   * silently dropped because they didn't map to a recognised version.
   */
  ifcVersionRaw?: string;
  /** Identifier (optional external reference) */
  identifier?: string;
  /** Applicability - which entities this specification applies to */
  applicability: IDSApplicability;
  /** Requirements - what applicable entities must satisfy */
  requirements: IDSRequirement[];
  /** Minimum occurrences (default: 0 = no minimum) */
  minOccurs?: number;
  /** Maximum occurrences ("unbounded" or number, default: unbounded) */
  maxOccurs?: number | 'unbounded';
}

export type IFCVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3_ADD2' | 'IFC4X3';

/** Applicability definition - all facets must match (AND logic) */
export interface IDSApplicability {
  /** All facets must match for entity to be applicable */
  facets: IDSFacet[];
  /**
   * Raw `@cardinality` attribute string from the XML. The IDS 1.0 spec
   * does not allow `cardinality` on `<applicability>` (it is meaningless
   * there); upstream IDS-Audit-tool flags it as an authoring mistake.
   * Preserved here so the auditor can do the same check.
   */
  cardinality?: string;
}

/** Requirement definition */
export interface IDSRequirement {
  /** Unique identifier */
  id: string;
  /** The facet that defines what must be satisfied */
  facet: IDSFacet;
  /** Optionality of this requirement */
  optionality: RequirementOptionality;
  /**
   * The raw `@cardinality` attribute string from the XML, when present
   * but not equal to one of the canonical XSD enum values
   * (`required` / `optional` / `prohibited`). Preserved so the auditor
   * can flag values like `"Required"` or `"Invalid"` that the parser
   * silently mapped to the default. `undefined` when the attribute was
   * absent or already canonical.
   */
  cardinalityRaw?: string;
  /** Human-readable description */
  description?: string;
  /** Instructions for achieving compliance */
  instructions?: string;
}

export type RequirementOptionality = 'required' | 'optional' | 'prohibited';

// ============================================================================
// Facet Types
// ============================================================================

/** Union of all facet types */
export type IDSFacet =
  | IDSEntityFacet
  | IDSAttributeFacet
  | IDSPropertyFacet
  | IDSClassificationFacet
  | IDSMaterialFacet
  | IDSPartOfFacet;

export type FacetType = IDSFacet['type'];

/** Entity facet - match by IFC entity type */
export interface IDSEntityFacet {
  type: 'entity';
  /** Entity type name constraint (e.g., "IFCWALL") */
  name: IDSConstraint;
  /** Optional predefined type constraint */
  predefinedType?: IDSConstraint;
}

/** Attribute facet - match by IFC attribute value */
export interface IDSAttributeFacet {
  type: 'attribute';
  /** Attribute name constraint (e.g., "Name", "Description") */
  name: IDSConstraint;
  /** Optional value constraint */
  value?: IDSConstraint;
}

/** Property facet - match by property set and property value */
export interface IDSPropertyFacet {
  type: 'property';
  /** Property set name constraint */
  propertySet: IDSConstraint;
  /** Property name constraint */
  baseName: IDSConstraint;
  /** Optional data type constraint (e.g., "IFCLABEL", "IFCREAL") */
  dataType?: IDSConstraint;
  /** Optional value constraint */
  value?: IDSConstraint;
}

/** Classification facet - match by classification reference */
export interface IDSClassificationFacet {
  type: 'classification';
  /** Optional classification system name constraint */
  system?: IDSConstraint;
  /** Optional classification value/code constraint */
  value?: IDSConstraint;
}

/** Material facet - match by material assignment */
export interface IDSMaterialFacet {
  type: 'material';
  /** Optional material value/name constraint */
  value?: IDSConstraint;
}

/** PartOf facet - match by spatial/compositional relationship */
export interface IDSPartOfFacet {
  type: 'partOf';
  /** Relationship type (normalised; defaults to `IfcRelContainedInSpatialStructure` when unrecognised). */
  relation: PartOfRelation;
  /**
   * The relation string as it appeared in the XML, before normalisation.
   * Set when the original value didn't map to a recognised
   * {@link PartOfRelation}. The auditor uses this to flag invalid
   * relation names.
   */
  rawRelation?: string;
  /** Optional entity constraint for the related parent */
  entity?: IDSEntityFacet;
}

export type PartOfRelation =
  | 'IfcRelAggregates'
  | 'IfcRelAssignsToGroup'
  | 'IfcRelContainedInSpatialStructure'
  | 'IfcRelNests'
  | 'IfcRelVoidsElement'
  | 'IfcRelFillsElement';

// ============================================================================
// Constraint Types
// ============================================================================

/** Union of all constraint types */
export type IDSConstraint =
  | IDSSimpleValue
  | IDSPatternConstraint
  | IDSEnumerationConstraint
  | IDSBoundsConstraint;

/** Simple value - exact match */
export interface IDSSimpleValue {
  type: 'simpleValue';
  /** The exact value to match */
  value: string;
}

/** Pattern constraint - regex match */
export interface IDSPatternConstraint {
  type: 'pattern';
  /** XSD regex pattern */
  pattern: string;
  /**
   * The originating `xs:restriction @base` (e.g. `xs:string`, `xs:integer`).
   * Set when the constraint came from an `<xs:restriction>` element; the
   * auditor uses it to determine compatibility with an IFC dataType
   * without inferring the base from the constraint shape.
   */
  base?: string;
}

/** Enumeration constraint - one of a list of values */
export interface IDSEnumerationConstraint {
  type: 'enumeration';
  /** List of allowed values */
  values: string[];
  /**
   * The originating `xs:restriction @base` (e.g. `xs:string`,
   * `xs:integer`). Set when the constraint came from an
   * `<xs:restriction>`; numeric/boolean enumerations carry their base
   * here so the auditor doesn't false-positive a string-base mismatch.
   */
  base?: string;
}

/** Bounds constraint - numeric range or string length */
export interface IDSBoundsConstraint {
  type: 'bounds';
  /** Minimum inclusive value */
  minInclusive?: number;
  /** Maximum inclusive value */
  maxInclusive?: number;
  /** Minimum exclusive value */
  minExclusive?: number;
  /** Maximum exclusive value */
  maxExclusive?: number;
  /** xs:length — exact string length */
  length?: number;
  /** xs:minLength — minimum string length */
  minLength?: number;
  /** xs:maxLength — maximum string length */
  maxLength?: number;
  /**
   * The originating `xs:restriction @base` (e.g. `xs:double`,
   * `xs:integer`). Set when the constraint came from an
   * `<xs:restriction>` so the auditor can compare against the IFC
   * dataType's backing type directly.
   */
  base?: string;
}

// ============================================================================
// Validation Result Types
// ============================================================================

/** Complete validation report */
export interface IDSValidationReport {
  /** The IDS document that was validated */
  document: IDSDocument;
  /** Model information */
  modelInfo: IDSModelInfo;
  /** When validation was performed */
  timestamp: Date;
  /** Summary statistics */
  summary: IDSValidationSummary;
  /** Results per specification */
  specificationResults: IDSSpecificationResult[];
}

/** Information about the validated model */
export interface IDSModelInfo {
  /** Model identifier/filename */
  modelId: string;
  /** IFC schema version */
  schemaVersion: string;
  /** Total entity count */
  entityCount: number;
}

/** Summary statistics for the entire validation */
export interface IDSValidationSummary {
  /** Total specifications checked */
  totalSpecifications: number;
  /** Specifications that passed */
  passedSpecifications: number;
  /** Specifications that failed */
  failedSpecifications: number;
  /** Total entities checked across all specifications */
  totalEntitiesChecked: number;
  /** Entities that passed all requirements */
  totalEntitiesPassed: number;
  /** Entities that failed one or more requirements */
  totalEntitiesFailed: number;
  /** Overall pass rate (0-100) */
  overallPassRate: number;
}

/** Result for a single specification */
export interface IDSSpecificationResult {
  /** Reference to the specification */
  specification: IDSSpecification;
  /** Overall pass/fail status */
  status: 'pass' | 'fail' | 'not_applicable';
  /** Number of entities that matched applicability */
  applicableCount: number;
  /** Number of applicable entities that passed */
  passedCount: number;
  /** Number of applicable entities that failed */
  failedCount: number;
  /** Pass rate (0-100) */
  passRate: number;
  /** Per-entity results */
  entityResults: IDSEntityResult[];
  /** Cardinality result (if minOccurs/maxOccurs specified) */
  cardinalityResult?: IDSCardinalityResult;
}

/** Cardinality check result */
export interface IDSCardinalityResult {
  /** Whether cardinality constraint was satisfied */
  passed: boolean;
  /** Actual count of applicable entities */
  actualCount: number;
  /** Expected minimum */
  minExpected?: number;
  /** Expected maximum */
  maxExpected?: number | 'unbounded';
  /** Human-readable message */
  message: string;
}

/** Result for a single entity */
export interface IDSEntityResult {
  /** Express ID of the entity */
  expressId: number;
  /** Model ID (for multi-model support) */
  modelId: string;
  /** Entity type (e.g., "IfcWall") */
  entityType: string;
  /** Entity name (if available) */
  entityName?: string;
  /** IFC GlobalId (if available) */
  globalId?: string;
  /** Overall pass/fail status */
  passed: boolean;
  /** Results for each requirement */
  requirementResults: IDSRequirementResult[];
}

/** Result for a single requirement check */
export interface IDSRequirementResult {
  /** Reference to the requirement */
  requirement: IDSRequirement;
  /** Pass/fail status */
  status: 'pass' | 'fail' | 'not_applicable';
  /** The facet type that was checked */
  facetType: FacetType;
  /** Human-readable description of what was checked (translated) */
  checkedDescription: string;
  /** Human-readable failure reason (translated, if failed) */
  failureReason?: string;
  /** Actual value found */
  actualValue?: string;
  /** Expected value/constraint description */
  expectedValue?: string;
  /** Detailed failure information */
  failure?: IDSFailureDetail;
}

/** Detailed failure information */
export interface IDSFailureDetail {
  /** Failure type */
  type: FailureType;
  /** Field that failed (e.g., "Name", "Pset_WallCommon.FireRating") */
  field?: string;
  /** Actual value found */
  actual?: string;
  /** Expected value or constraint description */
  expected?: string;
  /** Additional context */
  context?: Record<string, string>;
}

/** Types of validation failures */
export type FailureType =
  // Entity failures
  | 'ENTITY_TYPE_MISMATCH'
  | 'PREDEFINED_TYPE_MISMATCH'
  | 'PREDEFINED_TYPE_MISSING'
  // Attribute failures
  | 'ATTRIBUTE_MISSING'
  | 'ATTRIBUTE_VALUE_MISMATCH'
  | 'ATTRIBUTE_PATTERN_MISMATCH'
  // Property failures
  | 'PSET_MISSING'
  | 'PROPERTY_MISSING'
  | 'PROPERTY_VALUE_MISMATCH'
  | 'PROPERTY_DATATYPE_MISMATCH'
  | 'PROPERTY_OUT_OF_BOUNDS'
  // Classification failures
  | 'CLASSIFICATION_MISSING'
  | 'CLASSIFICATION_SYSTEM_MISMATCH'
  | 'CLASSIFICATION_VALUE_MISMATCH'
  // Material failures
  | 'MATERIAL_MISSING'
  | 'MATERIAL_VALUE_MISMATCH'
  // PartOf failures
  | 'PARTOF_RELATION_MISSING'
  | 'PARTOF_ENTITY_MISMATCH'
  | 'PARTOF_PREDEFINED_TYPE_MISMATCH'
  | 'PARTOF_PREDEFINED_TYPE_MISSING'
  // Prohibited failures
  | 'PROHIBITED_ATTRIBUTE_EXISTS'
  | 'PROHIBITED_PROPERTY_EXISTS'
  | 'PROHIBITED_CLASSIFICATION_EXISTS'
  | 'PROHIBITED_MATERIAL_EXISTS';

// ============================================================================
// IFC Data Access Interface
// ============================================================================

/** Interface for accessing IFC data during validation */
export interface IFCDataAccessor {
  /** Get entity type name by express ID */
  getEntityType(expressId: number): string | undefined;
  /** Get entity name by express ID */
  getEntityName(expressId: number): string | undefined;
  /** Get entity GlobalId by express ID */
  getGlobalId(expressId: number): string | undefined;
  /** Get entity description by express ID */
  getDescription(expressId: number): string | undefined;
  /**
   * Get entity object type (predefined type) by express ID.
   *
   * Per IDS spec, when the IFC `PredefinedType` is `USERDEFINED` the
   * predefined-type comparison shifts to the user-defined name in the
   * adjacent `ObjectType` / `ElementType` slot. Implementations MAY
   * substitute that name here, but MUST also surface the raw enum value
   * via `getPredefinedTypeRaw` so the validator can disambiguate
   * literal `USERDEFINED` matches from user-name matches.
   */
  getObjectType(expressId: number): string | undefined;
  /**
   * Get the raw `PredefinedType` enum token (e.g. `USERDEFINED`,
   * `NOTDEFINED`, `BEAM`) without substitution to the user-defined
   * name. Returns `undefined` when the entity has no predefined type.
   */
  getPredefinedTypeRaw?(expressId: number): string | undefined;
  /**
   * Get the names of every attribute defined on the entity (its IFC
   * schema-defined attribute names, including inherited ones). Used by
   * the attribute-facet checker when the IDS uses a pattern or
   * enumeration on `<name>` so the check can iterate every matching
   * candidate, not just the small list of standard attribute names.
   */
  getAttributeNames?(expressId: number): string[];
  /**
   * Get the XSD primitive types (`xs:integer`, `xs:double`, `xs:string`,
   * `xs:boolean`, `xs:date`, `xs:dateTime`, `xs:duration`) that the IFC
   * schema declares for the named attribute on the entity. The IDS
   * validator uses this to enforce strict-cast semantics — an
   * `xs:integer`-only slot rejects literals like `42.0`, `xs:double`
   * accepts both `42` and `42.0`, etc. Returns `undefined` when the
   * type is unknown so callers fall back to permissive comparison.
   */
  getAttributeXsdTypes?(expressId: number, attrName: string): readonly string[] | undefined;
  /** Get all entity IDs of a specific type */
  getEntitiesByType(typeName: string): number[];
  /** Get all entity IDs */
  getAllEntityIds(): number[];
  /** Get property value */
  getPropertyValue(
    expressId: number,
    propertySetName: string,
    propertyName: string
  ): PropertyValueResult | undefined;
  /** Get all property sets for an entity */
  getPropertySets(expressId: number): PropertySetInfo[];
  /** Get classifications for an entity */
  getClassifications(expressId: number): ClassificationInfo[];
  /** Get materials for an entity */
  getMaterials(expressId: number): MaterialInfo[];
  /** Get parent via relationship */
  getParent(
    expressId: number,
    relationType: PartOfRelation
  ): ParentInfo | undefined;
  /**
   * Walk every ancestor reachable via `relationType` (the IDS spec
   * treats partOf as transitive — a wall in a storey in a building
   * IS partOf the building). Optional: when not provided, the
   * partOf facet falls back to single-step `getParent` traversal.
   */
  getAncestors?(
    expressId: number,
    relationType: PartOfRelation
  ): ParentInfo[];
  /** Get attribute value by name */
  getAttribute(expressId: number, attributeName: string): string | number | boolean | undefined;
}

/** Property value result */
export interface PropertyValueResult {
  /** The value */
  value: string | number | boolean | null;
  /** The data type (e.g., "IFCLABEL", "IFCREAL") */
  dataType: string;
  /** The property set name */
  propertySetName: string;
  /** The property name */
  propertyName: string;
}

/** Property set information */
export interface PropertySetInfo {
  /** Property set name */
  name: string;
  /** Properties in this set */
  properties: Array<{
    name: string;
    value: string | number | boolean | null;
    dataType: string;
    /**
     * Optional list of individual values for multi-valued IFC properties
     * (`IfcPropertyEnumeratedValue`, `IfcPropertyListValue`). When set,
     * the IDS validator iterates each candidate and passes the constraint
     * check if any one matches — mirroring upstream ifctester semantics.
     */
    values?: Array<string | number | boolean>;
  }>;
}

/** Classification information */
export interface ClassificationInfo {
  /** Classification system name */
  system: string;
  /** Classification value/code */
  value: string;
  /** Optional classification name */
  name?: string;
}

/** Material information */
export interface MaterialInfo {
  /** Material name */
  name: string;
  /** Material category (if available) */
  category?: string;
}

/** Parent entity information */
export interface ParentInfo {
  /** Parent express ID */
  expressId: number;
  /** Parent entity type */
  entityType: string;
  /** Parent predefined type (if available) */
  predefinedType?: string;
}

// ============================================================================
// Validator Options
// ============================================================================

/** Options for the validation process */
export interface ValidatorOptions {
  /** Translation service for human-readable output */
  translator?: TranslationService;
  /** Maximum entities to validate (for preview/sampling) */
  maxEntities?: number;
  /** Progress callback */
  onProgress?: (progress: ValidationProgress) => void;
  /** Whether to include passing entities in results (default: true) */
  includePassingEntities?: boolean;
}

/** Validation progress information */
export interface ValidationProgress {
  /** Current phase */
  phase: 'filtering' | 'validating' | 'complete';
  /** Current specification index */
  specificationIndex: number;
  /** Total specifications */
  totalSpecifications: number;
  /** Entities processed in current specification */
  entitiesProcessed: number;
  /** Total entities to process in current specification */
  totalEntities: number;
  /** Overall percentage (0-100) */
  percentage: number;
}

// ============================================================================
// Translation Service Interface
// ============================================================================

/** Supported locales for translation */
export type SupportedLocale = 'en' | 'de' | 'fr';

/** Translation service interface */
export interface TranslationService {
  /** Current locale */
  readonly locale: SupportedLocale;

  /** Translate a key with optional parameters */
  t(key: string, params?: Record<string, string | number>): string;

  /** Describe a facet in human-readable form */
  describeFacet(
    facet: IDSFacet,
    context: 'applicability' | 'requirement'
  ): string;

  /** Describe a constraint value */
  describeConstraint(constraint: IDSConstraint): string;

  /** Describe a failure reason */
  describeFailure(result: IDSRequirementResult): string;

  /** Describe a requirement */
  describeRequirement(requirement: IDSRequirement): string;

  /** Get status text */
  getStatusText(status: 'pass' | 'fail' | 'not_applicable'): string;

  /** Get optionality text */
  getOptionalityText(optionality: RequirementOptionality): string;

  /** Get relationship description */
  getRelationDescription(relation: PartOfRelation): string;
}
