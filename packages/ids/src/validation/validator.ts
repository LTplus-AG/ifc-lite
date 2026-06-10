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
  PartOfRelation,
} from '../types.js';
import { checkFacet, filterByFacet, type FacetCheckResult } from '../facets/index.js';
import { formatConstraint } from '../constraints/index.js';

/** Memoize a single-argument accessor lookup keyed by express ID. */
function memoById<T>(fn: (expressId: number) => T): (expressId: number) => T {
  const cache = new Map<number, T>();
  return (expressId: number): T => {
    if (cache.has(expressId)) return cache.get(expressId) as T;
    const value = fn(expressId);
    cache.set(expressId, value);
    return value;
  };
}

/** Memoize a two-argument accessor lookup keyed by express ID + name. */
function memoByIdAndKey<T>(
  fn: (expressId: number, key: string) => T
): (expressId: number, key: string) => T {
  const cache = new Map<string, T>();
  return (expressId: number, key: string): T => {
    const cacheKey = `${expressId}\u0000${key}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) as T;
    const value = fn(expressId, key);
    cache.set(cacheKey, value);
    return value;
  };
}

/**
 * Wrap an accessor so every per-entity lookup is computed at most once
 * for the lifetime of one validation run.
 *
 * The validator re-checks the same entities once per specification, and
 * real-world IDS documents carry hundreds of specifications over the
 * same entity population. Most accessor implementations re-extract
 * property sets from the raw source buffer on every call, which made
 * validation O(specifications × entities × source-parses) — tens of
 * minutes of CPU for documents that validate in seconds once cached.
 */
export function createCachedAccessor(accessor: IFCDataAccessor): IFCDataAccessor {
  let allEntityIds: number[] | undefined;
  const entitiesByType = new Map<string, number[]>();

  const cached: IFCDataAccessor = {
    getEntityType: memoById((id) => accessor.getEntityType(id)),
    getEntityName: memoById((id) => accessor.getEntityName(id)),
    getGlobalId: memoById((id) => accessor.getGlobalId(id)),
    getDescription: memoById((id) => accessor.getDescription(id)),
    getObjectType: memoById((id) => accessor.getObjectType(id)),
    getPropertySets: memoById((id) => accessor.getPropertySets(id)),
    getClassifications: memoById((id) => accessor.getClassifications(id)),
    getMaterials: memoById((id) => accessor.getMaterials(id)),
    getAttribute: memoByIdAndKey((id, name) => accessor.getAttribute(id, name)),
    getParent: memoByIdAndKey((id, rel) =>
      accessor.getParent(id, rel as PartOfRelation)
    ) as IFCDataAccessor['getParent'],
    getPropertyValue: (id, psetName, propName) =>
      accessor.getPropertyValue(id, psetName, propName),
    getEntitiesByType(typeName: string): number[] {
      let ids = entitiesByType.get(typeName);
      if (!ids) {
        ids = accessor.getEntitiesByType(typeName);
        entitiesByType.set(typeName, ids);
      }
      return ids;
    },
    getAllEntityIds(): number[] {
      if (!allEntityIds) allEntityIds = accessor.getAllEntityIds();
      return allEntityIds;
    },
  };

  // Optional methods: only surface them when the underlying accessor
  // does — facet checkers feature-detect these.
  if (accessor.getPredefinedTypeRaw) {
    cached.getPredefinedTypeRaw = memoById((id) =>
      accessor.getPredefinedTypeRaw!(id)
    );
  }
  if (accessor.getAttributeNames) {
    cached.getAttributeNames = memoById((id) => accessor.getAttributeNames!(id));
  }
  if (accessor.getAttributeXsdTypes) {
    cached.getAttributeXsdTypes = memoByIdAndKey((id, attr) =>
      accessor.getAttributeXsdTypes!(id, attr)
    ) as IFCDataAccessor['getAttributeXsdTypes'];
  }
  if (accessor.getAncestors) {
    cached.getAncestors = memoByIdAndKey((id, rel) =>
      accessor.getAncestors!(id, rel as PartOfRelation)
    ) as IFCDataAccessor['getAncestors'];
  }

  return cached;
}

/**
 * Per-run cache for requirement descriptions. A requirement's checked
 * description is entity-independent, yet it used to be re-formatted for
 * every entity result — for enumeration constraints that meant building
 * the same multi-KB string thousands of times.
 */
type DescriptionCache = Map<IDSRequirement, string>;

const nowMs = (): number =>
  typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();

/**
 * Yield control back to the event loop (browser + Node).
 *
 * Deliberately NOT `scheduler.yield()`: its continuation runs at
 * elevated priority, ahead of the host's already-queued normal tasks —
 * including React's render work — so a CPU-bound loop yielding through
 * it still starves the UI (canvas rAF kept painting while the progress
 * panel never committed). A MessageChannel hop is a normal-priority
 * task: everything queued before it, renders included, runs first.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      // Close both ports — an open MessagePort holds a libuv handle in
      // Node and would keep the process alive after completion.
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Time-budgeted yielder. Validation is pure CPU work whose awaits all
 * resolve through microtasks, so without real event-loop yields a
 * browser host cannot paint a single frame for the whole run — the
 * progress UI stays frozen no matter how often onProgress fires.
 */
function createYielder(budgetMs: number): () => Promise<void> | undefined {
  let lastYield = nowMs();
  return () => {
    if (nowMs() - lastYield < budgetMs) return undefined;
    return yieldToEventLoop().then(() => {
      lastYield = nowMs();
    });
  };
}

type MaybeYield = ReturnType<typeof createYielder>;

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

  const cachedAccessor = createCachedAccessor(accessor);
  const descriptionCache: DescriptionCache = new Map();
  const maybeYield = createYielder(options.yieldEveryMs ?? 40);

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

    // Let the host paint between specifications even when individual
    // specs are fast.
    await maybeYield();

    const result = await validateSpecification(
      spec,
      cachedAccessor,
      modelInfo,
      options,
      descriptionCache,
      maybeYield,
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
  descriptionCache: DescriptionCache,
  maybeYield: MaybeYield,
  onProgress?: (progress: Omit<ValidationProgress, 'specificationIndex' | 'totalSpecifications' | 'percentage'>) => void
): Promise<IDSSpecificationResult> {
  const { translator, maxEntities, includePassingEntities = true } = options;
  const modelId = modelInfo.modelId;

  // Phase 1: Find applicable entities
  const applicableIds = await findApplicableEntities(spec, accessor, maybeYield, onProgress);

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
    if ((i & 31) === 0) await maybeYield();

    const entityResult = validateEntityRequirements(
      spec,
      expressId,
      modelId,
      accessor,
      descriptionCache,
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
async function findApplicableEntities(
  spec: IDSSpecification,
  accessor: IFCDataAccessor,
  maybeYield: MaybeYield,
  onProgress?: (progress: Omit<ValidationProgress, 'specificationIndex' | 'totalSpecifications' | 'percentage'>) => void
): Promise<number[]> {
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

  // Filter candidates by all applicability facets. With property-only
  // applicability the candidate set is the whole model, so this scan is
  // where large runs spend most of their time — report progress and
  // yield so the host UI stays responsive.
  const applicableIds: number[] = [];
  const totalCandidates = candidateIds.length;

  for (let i = 0; i < totalCandidates; i++) {
    const expressId = candidateIds[i];

    if (onProgress && totalCandidates > 8192 && (i & 8191) === 0) {
      onProgress({
        phase: 'filtering',
        entitiesProcessed: i,
        totalEntities: totalCandidates,
      });
    }
    if ((i & 255) === 0) await maybeYield();

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
  descriptionCache: DescriptionCache,
  translator?: TranslationService
): IDSEntityResult {
  const requirementResults: IDSRequirementResult[] = [];
  let allPassed = true;

  for (const requirement of spec.requirements) {
    const result = checkRequirement(requirement, expressId, accessor, descriptionCache, translator);
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
  descriptionCache: DescriptionCache,
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

  // Generate checked description. It is entity-independent, so format
  // it once per requirement per run — not once per entity result.
  let checkedDescription = descriptionCache.get(requirement);
  if (checkedDescription === undefined) {
    checkedDescription = translator
      ? translator.describeRequirement(requirement)
      : formatRequirementDescription(requirement);
    descriptionCache.set(requirement, checkedDescription);
  }

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

  // The XML parser canonicalises the IDS 1.0 default — an
  // `<applicability>` without explicit `minOccurs` becomes `1`
  // (REQUIRED) — so we don't have to fall back here. The `?? 0`
  // covers exotic specs that omit applicability entirely but still
  // declare `maxOccurs`.
  const minExpected = spec.minOccurs ?? 0;
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
