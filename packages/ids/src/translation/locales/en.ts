/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * English translations for IDS validation
 */

export const en = {
  // ============================================================================
  // Status
  // ============================================================================
  status: {
    pass: 'PASS',
    fail: 'FAIL',
    not_applicable: 'NOT APPLICABLE',
  },

  // ============================================================================
  // Optionality / Cardinality
  // ============================================================================
  optionality: {
    required: 'Required',
    optional: 'Optional',
    prohibited: 'Prohibited',
  },

  cardinality: {
    satisfied: 'Cardinality satisfied',
    atLeast: 'Expected at least {min}, found {count}',
    atMost: 'Expected at most {max}, found {count}',
    between: 'Expected between {min} and {max}, found {count}',
    exactly: 'Expected exactly {count}',
  },

  // ============================================================================
  // Relationships
  // ============================================================================
  relations: {
    IfcRelAggregates: 'part of',
    IfcRelAssignsToGroup: 'grouped in',
    IfcRelContainedInSpatialStructure: 'contained in',
    IfcRelNests: 'nested in',
    IfcRelVoidsElement: 'voiding',
    IfcRelFillsElement: 'filling',
  },

  // ============================================================================
  // Constraint Descriptions
  // ============================================================================
  constraints: {
    simpleValue: '"{value}"',
    pattern: 'matching pattern "{pattern}"',
    enumeration: {
      single: '"{value}"',
      multiple: 'one of [{values}]',
    },
    bounds: {
      between: 'between {min} and {max}',
      atLeast: 'at least {min}',
      atMost: 'at most {max}',
      greaterThan: 'greater than {min}',
      lessThan: 'less than {max}',
    },
  },

  // ============================================================================
  // Applicability Descriptions
  // ============================================================================
  applicability: {
    entity: {
      simple: 'Elements of type {entityType}',
      withPredefined: '{entityType} elements with predefined type {predefinedType}',
      pattern: 'Elements with type matching {pattern}',
    },
    attribute: {
      exists: 'Elements where attribute "{name}" exists',
      equals: 'Elements where "{name}" equals {value}',
      pattern: 'Elements where "{name}" matches {pattern}',
    },
    property: {
      exists: 'Elements with property "{property}" in "{pset}"',
      equals: 'Elements where "{pset}.{property}" equals {value}',
      pattern: 'Elements where "{pset}.{property}" matches {pattern}',
      bounded: 'Elements where "{pset}.{property}" is {bounds}',
    },
    classification: {
      any: 'Elements with any classification',
      system: 'Elements classified in "{system}"',
      value: 'Elements with classification "{value}"',
      systemAndValue: 'Elements classified as "{value}" in "{system}"',
    },
    material: {
      any: 'Elements with any material assigned',
      value: 'Elements with material "{value}"',
      pattern: 'Elements with material matching {pattern}',
    },
    partOf: {
      simple: 'Elements that are {relation} another element',
      withEntity: 'Elements that are {relation} a {entity}',
      withEntityAndType: 'Elements that are {relation} a {entity} with type {predefinedType}',
    },
  },

  // ============================================================================
  // Requirement Descriptions
  // ============================================================================
  requirements: {
    entity: {
      mustBe: 'Must be of type {entityType}',
      mustHavePredefined: 'Must have predefined type {predefinedType}',
      mustBeWithPredefined: 'Must be {entityType} with predefined type {predefinedType}',
    },
    attribute: {
      mustExist: 'Attribute "{name}" must exist',
      mustEqual: 'Attribute "{name}" must equal {value}',
      mustMatch: 'Attribute "{name}" must match {pattern}',
      mustNotExist: 'Attribute "{name}" must not exist',
      mustNotEqual: 'Attribute "{name}" must not equal {value}',
    },
    property: {
      mustExist: 'Property "{pset}.{property}" must exist',
      mustEqual: 'Property "{pset}.{property}" must equal {value}',
      mustMatch: 'Property "{pset}.{property}" must match {pattern}',
      mustBeBounded: 'Property "{pset}.{property}" must be {bounds}',
      mustHaveType: 'Property "{pset}.{property}" must be of type {dataType}',
      mustNotExist: 'Property "{pset}.{property}" must not exist',
    },
    classification: {
      mustHave: 'Must have a classification',
      mustBeInSystem: 'Must be classified in "{system}"',
      mustHaveValue: 'Must have classification "{value}"',
      mustBeInSystemWithValue: 'Must be classified as "{value}" in "{system}"',
      mustNotHave: 'Must not have any classification',
      mustNotBeInSystem: 'Must not be classified in "{system}"',
    },
    material: {
      mustHave: 'Must have a material assigned',
      mustBe: 'Must have material "{value}"',
      mustMatch: 'Must have material matching {pattern}',
      mustNotHave: 'Must not have any material assigned',
    },
    partOf: {
      mustBe: 'Must be {relation} a {entity}',
      mustBeSimple: 'Must be {relation} another element',
      mustNotBe: 'Must not be {relation} any element',
    },
  },

  // ============================================================================
  // Failure Reasons
  // ============================================================================
  failures: {
    // Entity failures
    entityTypeMismatch: 'Entity type is "{actual}", expected {expected}',
    predefinedTypeMismatch: 'Predefined type is "{actual}", expected {expected}',
    predefinedTypeMissing: 'Predefined type is not set, expected {expected}',

    // Attribute failures
    attributeMissing: 'Attribute "{name}" does not exist',
    attributeEmpty: 'Attribute "{name}" is empty',
    attributeValueMismatch: 'Attribute "{name}" is "{actual}", expected {expected}',
    attributePatternMismatch: 'Attribute "{name}" value "{actual}" does not match pattern {expected}',
    attributeProhibited: 'Prohibited attribute "{name}" exists with value "{actual}"',

    // Property failures
    psetMissing: 'Property set "{pset}" not found',
    psetMissingAvailable: 'Property set "{pset}" not found. Available: {available}',
    propertyMissing: 'Property "{property}" not found in "{pset}"',
    propertyMissingAvailable: 'Property "{property}" not found in "{pset}". Available: {available}',
    propertyEmpty: 'Property "{pset}.{property}" has no value',
    propertyValueMismatch: 'Property "{pset}.{property}" is "{actual}", expected {expected}',
    propertyPatternMismatch: 'Property "{pset}.{property}" value "{actual}" does not match {expected}',
    propertyDatatypeMismatch: 'Property "{pset}.{property}" data type is "{actual}", expected {expected}',
    propertyOutOfBounds: 'Property "{pset}.{property}" value {actual} is out of range {expected}',
    propertyProhibited: 'Prohibited property "{pset}.{property}" exists with value "{actual}"',

    // Classification failures
    classificationMissing: 'No classification assigned',
    classificationSystemMismatch: 'Classification system "{actual}" does not match expected "{expected}"',
    classificationSystemMissingAvailable: 'Classification system "{expected}" not found. Available: {available}',
    classificationValueMismatch: 'Classification code "{actual}" does not match expected {expected}',
    classificationValueMissingAvailable: 'Classification code {expected} not found. Available: {available}',
    classificationProhibited: 'Prohibited classification "{actual}" exists in system "{system}"',

    // Material failures
    materialMissing: 'No material assigned',
    materialValueMismatch: 'Material "{actual}" does not match expected {expected}',
    materialValueMissingAvailable: 'Material {expected} not found. Available: {available}',
    materialProhibited: 'Prohibited material "{actual}" is assigned',

    // PartOf failures
    partOfMissing: 'Element is not {relation} any {entity}',
    partOfMissingSimple: 'Element is not {relation} any element',
    partOfEntityMismatch: 'Parent element is {actual}, expected {expected}',
    partOfPredefinedMismatch: 'Parent predefined type is "{actual}", expected {expected}',
    partOfProhibited: 'Element is {relation} {actual}, which is prohibited',

    // Generic
    prohibited: 'Prohibited {field} found: "{actual}"',
    unknown: 'Validation failed: {reason}',
  },

  // ============================================================================
  // Summary
  // ============================================================================
  summary: {
    title: 'IDS Validation Report',
    specifications: '{passed}/{total} specifications passed',
    entities: '{passed}/{total} entities compliant ({percent}%)',
    overallPass: 'Model meets all requirements',
    overallFail: 'Model has {count} failing specifications',
    noApplicable: 'No applicable entities found',
  },

  // ============================================================================
  // UI Labels
  // ============================================================================
  ui: {
    specification: 'Specification',
    specifications: 'Specifications',
    requirement: 'Requirement',
    requirements: 'Requirements',
    applicability: 'Applies to',
    entity: 'Entity',
    entities: 'Entities',
    passed: 'Passed',
    failed: 'Failed',
    passRate: 'Pass rate',
    actualValue: 'Actual',
    expectedValue: 'Expected',
    failureReason: 'Reason',
    showAll: 'Show all',
    showFailed: 'Show failed only',
    isolateFailed: 'Isolate failed',
    isolatePassed: 'Isolate passed',
    exportJson: 'Export JSON',
    exportBcf: 'Export BCF',
    loadIds: 'Load IDS file',
    runValidation: 'Run validation',
    clearResults: 'Clear results',
  },
};

export type TranslationKey = keyof typeof en;
