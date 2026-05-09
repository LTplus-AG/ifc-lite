/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Validator - Main validation engine
 */

import type {
  IDSDocument,
  IDSSpecification,
  IDSRequirement,
  IDSFacet,
  IDSValidationReport,
  IDSSpecificationResult,
  IDSEntityResult,
  IDSRequirementResult,
  IDSValidationSummary,
  IDSModelInfo,
  IDSCardinalityResult,
  IFCDataAccessor,
  ValidatorOptions,
  ValidationProgress,
  TranslationService,
} from '../types.js';
import { checkFacet, filterByFacet, type FacetCheckResult } from '../facets/index.js';
import { formatConstraint } from '../constraints/index.js';

/**
 * Validate an IFC model against an IDS document
 */
export async function validateIDS(
  document: IDSDocument,
  accessor: IFCDataAccessor,
  modelInfo: IDSModelInfo,
  options: ValidatorOptions = {}
): Promise<IDSValidationReport> {
  const { translator, onProgress, includePassingEntities = true } = options;

  const specificationResults: IDSSpecificationResult[] = [];
  const totalSpecs = document.specifications.length;

  for (let i = 0; i < totalSpecs; i++) {
    const spec = document.specifications[i];

    // Report progress
    if (onProgress) {
      onProgress({
        phase: 'filtering',
        specificationIndex: i,
        totalSpecifications: totalSpecs,
        entitiesProcessed: 0,
        totalEntities: 0,
        percentage: Math.floor((i / totalSpecs) * 100),
      });
    }

    const result = await validateSpecification(
      spec,
      accessor,
      modelInfo,
      options,
      (progress) => {
        if (onProgress) {
          onProgress({
            ...progress,
            specificationIndex: i,
            totalSpecifications: totalSpecs,
            percentage: Math.floor(
              ((i + progress.entitiesProcessed / Math.max(progress.totalEntities, 1)) /
                totalSpecs) *
                100
            ),
          });
        }
      }
    );

    specificationResults.push(result);
  }

  // Report completion
  if (onProgress) {
    onProgress({
      phase: 'complete',
      specificationIndex: totalSpecs,
      totalSpecifications: totalSpecs,
      entitiesProcessed: 0,
      totalEntities: 0,
      percentage: 100,
    });
  }

  const summary = calculateSummary(specificationResults);

  return {
    document,
    modelInfo,
    timestamp: new Date(),
    summary,
    specificationResults,
  };
}

/**
 * Validate a single specification against the model
 */
async function validateSpecification(
  spec: IDSSpecification,
  accessor: IFCDataAccessor,
  modelInfo: IDSModelInfo,
  options: ValidatorOptions,
  onProgress?: (progress: Omit<ValidationProgress, 'specificationIndex' | 'totalSpecifications' | 'percentage'>) => void
): Promise<IDSSpecificationResult> {
  const { translator, maxEntities, includePassingEntities = true } = options;
  const modelId = modelInfo.modelId;

  // Phase 1: Find applicable entities
  const applicableIds = findApplicableEntities(spec, accessor);

  // Apply max entities limit if specified
  const idsToCheck = maxEntities
    ? applicableIds.slice(0, maxEntities)
    : applicableIds;

  // Phase 2: Check requirements for each applicable entity
  const entityResults: IDSEntityResult[] = [];
  const totalEntities = idsToCheck.length;

  for (let i = 0; i < totalEntities; i++) {
    const expressId = idsToCheck[i];

    // Report progress periodically
    if (onProgress && i % 100 === 0) {
      onProgress({
        phase: 'validating',
        entitiesProcessed: i,
        totalEntities,
      });
    }

    const entityResult = validateEntityRequirements(
      spec,
      expressId,
      modelId,
      accessor,
      translator
    );

    // Include result based on options
    if (includePassingEntities || !entityResult.passed) {
      entityResults.push(entityResult);
    }
  }

  // Calculate pass/fail counts
  let passedCount = 0;
  let failedCount = 0;

  for (const result of entityResults) {
    if (result.passed) {
      passedCount++;
    } else {
      failedCount++;
    }
  }

  // If we filtered out passing entities, adjust the passed count
  if (!includePassingEntities) {
    passedCount = totalEntities - failedCount;
  }

  // Check cardinality
  const cardinalityResult = checkCardinality(spec, applicableIds.length);

  // Determine overall status
  let status: 'pass' | 'fail' | 'not_applicable' = 'pass';
  if (applicableIds.length === 0) {
    // No applicable entities - check if that's allowed by cardinality
    if (cardinalityResult?.passed === false) {
      status = 'fail';
    } else if (cardinalityResult?.passed === true) {
      // Cardinality explicitly satisfied (e.g., prohibited spec with 0 matches)
      status = 'pass';
    } else {
      status = 'not_applicable';
    }
  } else if (failedCount > 0 || cardinalityResult?.passed === false) {
    status = 'fail';
  }

  const passRate =
    totalEntities > 0 ? Math.floor((passedCount / totalEntities) * 100) : 100;

  return {
    specification: spec,
    status,
    applicableCount: applicableIds.length,
    passedCount,
    failedCount,
    passRate,
    entityResults,
    cardinalityResult,
  };
}

/**
 * Find entities that match the applicability criteria
 */
function findApplicableEntities(
  spec: IDSSpecification,
  accessor: IFCDataAccessor
): number[] {
  const applicabilityFacets = spec.applicability.facets;

  if (applicabilityFacets.length === 0) {
    // No applicability - applies to all entities
    return accessor.getAllEntityIds();
  }

  // Use first entity facet for broadphase filtering
  let candidateIds: number[] | undefined;
  for (const facet of applicabilityFacets) {
    const filtered = filterByFacet(facet, accessor);
    if (filtered !== undefined) {
      candidateIds = filtered;
      break;
    }
  }

  // If no broadphase filter, check all entities
  if (candidateIds === undefined) {
    candidateIds = accessor.getAllEntityIds();
  }

  // Filter candidates by all applicability facets
  const applicableIds: number[] = [];

  for (const expressId of candidateIds) {
    let matches = true;

    for (const facet of applicabilityFacets) {
      const result = checkFacet(facet, expressId, accessor);
      if (!result.passed) {
        matches = false;
        break;
      }
    }

    if (matches) {
      applicableIds.push(expressId);
    }
  }

  return applicableIds;
}

/**
 * Validate requirements for a single entity
 */
function validateEntityRequirements(
  spec: IDSSpecification,
  expressId: number,
  modelId: string,
  accessor: IFCDataAccessor,
  translator?: TranslationService
): IDSEntityResult {
  const requirementResults: IDSRequirementResult[] = [];
  let allPassed = true;

  for (const requirement of spec.requirements) {
    const result = checkRequirement(requirement, expressId, accessor, translator);
    requirementResults.push(result);

    if (result.status === 'fail') {
      allPassed = false;
    }
  }

  return {
    expressId,
    modelId,
    entityType: accessor.getEntityType(expressId) || 'Unknown',
    entityName: accessor.getEntityName(expressId),
    globalId: accessor.getGlobalId(expressId),
    passed: allPassed,
    requirementResults,
  };
}

/**
 * Check a single requirement against an entity
 */
function checkRequirement(
  requirement: IDSRequirement,
  expressId: number,
  accessor: IFCDataAccessor,
  translator?: TranslationService
): IDSRequirementResult {
  const facetResult = checkFacet(requirement.facet, expressId, accessor);

  // Apply optionality
  let status: 'pass' | 'fail' | 'not_applicable';
  let failureReason: string | undefined;

  switch (requirement.optionality) {
    case 'required':
      status = facetResult.passed ? 'pass' : 'fail';
      if (!facetResult.passed) {
        failureReason = translator
          ? translator.describeFailure({
              requirement,
              status: 'fail',
              facetType: requirement.facet.type,
              checkedDescription: '',
              actualValue: facetResult.actualValue,
              expectedValue: facetResult.expectedValue,
              failure: facetResult.failure,
            })
          : formatFailureReason(facetResult);
      }
      break;

    case 'optional':
      // Per IDS spec: `optional` means "if present, must satisfy".
      // - Pass when the facet matches.
      // - Pass when the facet is wholly absent (the missing-attribute /
      //   missing-property failure types).
      // - **Fail** when the facet is present but its value/datatype is
      //   wrong — `optional` does not give a free pass to bad data.
      if (facetResult.passed) {
        status = 'pass';
      } else {
        const missingFailures = new Set([
          'ATTRIBUTE_MISSING',
          'PROPERTY_MISSING',
          'PSET_MISSING',
          'CLASSIFICATION_MISSING',
          'MATERIAL_MISSING',
          'PARTOF_RELATION_MISSING',
        ]);
        if (
          facetResult.failure?.type &&
          missingFailures.has(facetResult.failure.type)
        ) {
          status = 'pass';
        } else {
          status = 'fail';
          failureReason = translator
            ? translator.describeFailure({
                requirement,
                status: 'fail',
                facetType: requirement.facet.type,
                checkedDescription: '',
                actualValue: facetResult.actualValue,
                expectedValue: facetResult.expectedValue,
                failure: facetResult.failure,
              })
            : formatFailureReason(facetResult);
        }
      }
      break;

    case 'prohibited':
      status = facetResult.passed ? 'fail' : 'pass'; // Inverse logic
      if (status === 'fail') {
        failureReason = translator
          ? translator.t('failures.prohibited', {
              field: facetResult.actualValue || 'value',
            })
          : `Prohibited: found ${facetResult.actualValue}`;
      }
      break;

    default:
      status = facetResult.passed ? 'pass' : 'fail';
  }

  // Generate checked description
  const checkedDescription = translator
    ? translator.describeRequirement(requirement)
    : formatRequirementDescription(requirement);

  return {
    requirement,
    status,
    facetType: requirement.facet.type,
    checkedDescription,
    failureReason,
    actualValue: facetResult.actualValue,
    expectedValue: facetResult.expectedValue,
    failure: facetResult.failure,
  };
}

/**
 * Check cardinality constraints
 */
function checkCardinality(
  spec: IDSSpecification,
  applicableCount: number
): IDSCardinalityResult | undefined {
  if (spec.minOccurs === undefined && spec.maxOccurs === undefined) {
    return undefined;
  }

  // Per IDS 1.0 spec, an applicability without an explicit `minOccurs`
  // is REQUIRED — at least one applicable entity must match. Authors
  // opt out by setting `minOccurs="0"` (optional) or `prohibited`.
  // Without this default `<applicability maxOccurs="unbounded">` would
  // silently allow zero matches, hiding broken / mistargeted specs.
  const minExpected = spec.minOccurs ?? 1;
  const maxExpected = spec.maxOccurs;

  let passed = true;
  const messages: string[] = [];

  if (applicableCount < minExpected) {
    passed = false;
    messages.push(`Expected at least ${minExpected}, found ${applicableCount}`);
  }

  if (maxExpected !== 'unbounded' && maxExpected !== undefined) {
    if (applicableCount > maxExpected) {
      passed = false;
      messages.push(`Expected at most ${maxExpected}, found ${applicableCount}`);
    }
  }

  return {
    passed,
    actualCount: applicableCount,
    minExpected: spec.minOccurs,
    maxExpected: spec.maxOccurs,
    message: messages.length > 0 ? messages.join('; ') : 'Cardinality satisfied',
  };
}

/**
 * Calculate validation summary
 */
function calculateSummary(
  specificationResults: IDSSpecificationResult[]
): IDSValidationSummary {
  let totalSpecifications = specificationResults.length;
  let passedSpecifications = 0;
  let failedSpecifications = 0;
  let totalEntitiesChecked = 0;
  let totalEntitiesPassed = 0;
  let totalEntitiesFailed = 0;

  for (const result of specificationResults) {
    if (result.status === 'pass') {
      passedSpecifications++;
    } else if (result.status === 'fail') {
      failedSpecifications++;
    }

    totalEntitiesChecked += result.applicableCount;
    totalEntitiesPassed += result.passedCount;
    totalEntitiesFailed += result.failedCount;
  }

  const overallPassRate =
    totalEntitiesChecked > 0
      ? Math.floor((totalEntitiesPassed / totalEntitiesChecked) * 100)
      : 100;

  return {
    totalSpecifications,
    passedSpecifications,
    failedSpecifications,
    totalEntitiesChecked,
    totalEntitiesPassed,
    totalEntitiesFailed,
    overallPassRate,
  };
}

/**
 * Format a failure reason without translation
 */
function formatFailureReason(result: FacetCheckResult): string {
  if (!result.failure) {
    return `Expected ${result.expectedValue}, got ${result.actualValue}`;
  }

  const { type, field, actual, expected } = result.failure;

  switch (type) {
    case 'ENTITY_TYPE_MISMATCH':
      return `Entity type "${actual}" does not match expected ${expected}`;
    case 'PREDEFINED_TYPE_MISMATCH':
      return `Predefined type "${actual}" does not match expected ${expected}`;
    case 'PREDEFINED_TYPE_MISSING':
      return `Predefined type is missing, expected ${expected}`;
    case 'ATTRIBUTE_MISSING':
      return `Attribute "${field}" is missing`;
    case 'ATTRIBUTE_VALUE_MISMATCH':
      return `Attribute "${field}" value "${actual}" does not match expected ${expected}`;
    case 'ATTRIBUTE_PATTERN_MISMATCH':
      return `Attribute "${field}" value "${actual}" does not match pattern ${expected}`;
    case 'PSET_MISSING':
      return `Property set "${field || expected}" not found`;
    case 'PROPERTY_MISSING':
      return `Property "${field}" not found`;
    case 'PROPERTY_VALUE_MISMATCH':
      return `Property "${field}" value "${actual}" does not match expected ${expected}`;
    case 'PROPERTY_DATATYPE_MISMATCH':
      return `Property "${field}" type "${actual}" does not match expected ${expected}`;
    case 'PROPERTY_OUT_OF_BOUNDS':
      return `Property "${field}" value ${actual} is out of bounds ${expected}`;
    case 'CLASSIFICATION_MISSING':
      return 'No classification found';
    case 'CLASSIFICATION_SYSTEM_MISMATCH':
      return `Classification system "${actual}" does not match expected ${expected}`;
    case 'CLASSIFICATION_VALUE_MISMATCH':
      return `Classification value "${actual}" does not match expected ${expected}`;
    case 'MATERIAL_MISSING':
      return 'No material assigned';
    case 'MATERIAL_VALUE_MISMATCH':
      return `Material "${actual}" does not match expected ${expected}`;
    case 'PARTOF_RELATION_MISSING':
      return `Not ${field} any entity`;
    case 'PARTOF_ENTITY_MISMATCH':
      return `Parent entity "${actual}" does not match expected ${expected}`;
    case 'PARTOF_PREDEFINED_TYPE_MISSING':
      return `Parent entity predefined type is missing, expected ${expected}`;
    case 'PARTOF_PREDEFINED_TYPE_MISMATCH':
      return `Parent entity predefined type "${actual}" does not match expected ${expected}`;
    default:
      return `Validation failed: ${type}`;
  }
}

/**
 * Format a requirement description without translation
 */
function formatRequirementDescription(requirement: IDSRequirement): string {
  const facet = requirement.facet;
  const optionality = requirement.optionality;

  let desc: string;

  switch (facet.type) {
    case 'entity':
      desc = `Must be ${formatConstraint(facet.name)}`;
      if (facet.predefinedType) {
        desc += ` with predefinedType ${formatConstraint(facet.predefinedType)}`;
      }
      break;

    case 'attribute':
      if (facet.value) {
        desc = `Attribute "${formatConstraint(facet.name)}" must equal ${formatConstraint(facet.value)}`;
      } else {
        desc = `Attribute "${formatConstraint(facet.name)}" must exist`;
      }
      break;

    case 'property':
      if (facet.value) {
        desc = `Property "${formatConstraint(facet.propertySet)}.${formatConstraint(facet.baseName)}" must equal ${formatConstraint(facet.value)}`;
      } else {
        desc = `Property "${formatConstraint(facet.propertySet)}.${formatConstraint(facet.baseName)}" must exist`;
      }
      break;

    case 'classification':
      if (facet.system && facet.value) {
        desc = `Must have classification ${formatConstraint(facet.value)} in ${formatConstraint(facet.system)}`;
      } else if (facet.system) {
        desc = `Must be classified in ${formatConstraint(facet.system)}`;
      } else if (facet.value) {
        desc = `Must have classification ${formatConstraint(facet.value)}`;
      } else {
        desc = 'Must have a classification';
      }
      break;

    case 'material':
      if (facet.value) {
        desc = `Must have material ${formatConstraint(facet.value)}`;
      } else {
        desc = 'Must have a material assigned';
      }
      break;

    case 'partOf': {
      const relName = facet.relation.replace('IfcRel', '').toLowerCase();
      if (facet.entity) {
        desc = `Must be ${relName} ${formatConstraint(facet.entity.name)}`;
      } else {
        desc = `Must be ${relName} some entity`;
      }
      break;
    }

    default:
      desc = 'Unknown requirement';
  }

  if (optionality === 'prohibited') {
    desc = desc.replace('Must', 'Must NOT').replace('must', 'must NOT');
  } else if (optionality === 'optional') {
    desc = desc.replace('Must', 'Should').replace('must', 'should');
  }

  return desc;
}
