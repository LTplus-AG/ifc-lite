/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS (Information Delivery Specification) to BCF Reporter
 *
 * Creates BCF projects from IDS validation results, generating one topic
 * per failing entity with failure details as comments and viewpoints that
 * isolate and select the failing element.
 *
 * This is a pure function with no viewer/React dependencies — it can be
 * used headlessly (CLI, server-side, tests) as well as from the viewer.
 *
 * Inspired by IfcOpenShell's ifctester BCF reporter, but improved:
 * - Groups failures per entity (not per requirement×entity) to avoid topic flood
 * - Uses comments for requirement details instead of cramming into title
 * - Isolates the failing element (defaultVisibility=false)
 * - Colors the failing element red
 * - Sets topic metadata (type, status, priority, labels)
 * - Configurable grouping strategies
 */

import type { BCFProject, BCFTopic, BCFComment, BCFViewpoint, BCFPerspectiveCamera } from './types.js';
import { generateUuid } from '@ifc-lite/encoding';

// ============================================================================
// Internal BCF helpers (avoiding index.js import to prevent jszip dependency)
// ============================================================================

function createProject(name: string, version: '2.1' | '3.0'): BCFProject {
  return {
    version,
    projectId: generateUuid(),
    name,
    topics: new Map(),
  };
}

function createTopic(opts: {
  title: string;
  description?: string;
  author: string;
  topicType?: string;
  topicStatus?: string;
  priority?: string;
  labels?: string[];
}): BCFTopic {
  return {
    guid: generateUuid(),
    title: opts.title,
    description: opts.description,
    topicType: opts.topicType ?? 'Issue',
    topicStatus: opts.topicStatus ?? 'Open',
    priority: opts.priority,
    creationDate: new Date().toISOString(),
    creationAuthor: opts.author,
    labels: opts.labels,
    comments: [],
    viewpoints: [],
  };
}

function createComment(opts: { author: string; comment: string; viewpointGuid?: string }): BCFComment {
  return {
    guid: generateUuid(),
    date: new Date().toISOString(),
    author: opts.author,
    comment: opts.comment,
    viewpointGuid: opts.viewpointGuid,
  };
}

// ============================================================================
// Input types (structurally compatible with @ifc-lite/ids types, no import needed)
// ============================================================================

/** Input for the BCF reporter — structurally matches IDSValidationReport */
export interface IDSReportInput {
  /** IDS document title */
  title: string;
  /** Optional IDS document description */
  description?: string;
  /** Results per specification */
  specificationResults: IDSSpecResultInput[];
}

/** Specification result — structurally matches IDSSpecificationResult */
export interface IDSSpecResultInput {
  specification: {
    name: string;
    description?: string;
  };
  status: 'pass' | 'fail' | 'not_applicable';
  applicableCount: number;
  passedCount: number;
  failedCount: number;
  entityResults: IDSEntityResultInput[];
  /**
   * Present when the specification declares minOccurs/maxOccurs. A
   * cardinality-only failure (e.g. a required entity type entirely
   * absent from the model) has `applicableCount === 0` and an empty
   * `entityResults` — there is no entity to attach a per-entity topic
   * to, so grouping strategies that iterate `entityResults` must fall
   * back to this to avoid dropping the failure silently.
   */
  cardinalityResult?: {
    passed: boolean;
    actualCount: number;
    minExpected?: number;
    maxExpected?: number | 'unbounded';
    message: string;
  };
}

/** Entity result — structurally matches IDSEntityResult */
export interface IDSEntityResultInput {
  expressId: number;
  modelId: string;
  entityType: string;
  entityName?: string;
  globalId?: string;
  passed: boolean;
  requirementResults: IDSRequirementResultInput[];
}

/** Bounds for an entity — used for camera computation in viewpoints (Y-up viewer coords) */
export interface EntityBoundsInput {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** Requirement result — structurally matches IDSRequirementResult */
export interface IDSRequirementResultInput {
  status: 'pass' | 'fail' | 'not_applicable';
  facetType: string;
  checkedDescription: string;
  failureReason?: string;
  actualValue?: string;
  expectedValue?: string;
}

// ============================================================================
// Export options
// ============================================================================

/** Options for the BCF IDS export */
export interface IDSBCFExportOptions {
  /** Author email for BCF topics (default: "ids-validator@ifc-lite") */
  author?: string;
  /** Project name (default: IDS document title) */
  projectName?: string;
  /** BCF version (default: "2.1") */
  version?: '2.1' | '3.0';
  /**
   * Topic grouping strategy:
   * - "per-entity": One topic per failing entity, requirements as comments (default)
   * - "per-specification": One topic per failing specification, entities as comments
   * - "per-requirement": One topic per (specification, requirement, entity) — like IfcOpenShell
   */
  topicGrouping?: 'per-entity' | 'per-specification' | 'per-requirement';
  /** Include passing entities as Info topics (default: false) */
  includePassingEntities?: boolean;
  /** Topic type for failures (default: "Error") */
  failureTopicType?: string;
  /** Topic type for passes (default: "Info") */
  passTopicType?: string;
  /** Maximum topics to create — safety valve for large models (default: 1000) */
  maxTopics?: number;
  /** ARGB hex color for failing elements in viewpoints (default: "FFFF3333" — red) */
  failureColor?: string;
  /**
   * Entity bounds map for computing per-entity camera positions.
   * Key: "modelId:expressId", Value: bounding box in viewer Y-up coordinates.
   * When provided, viewpoints will include a perspective camera framing the entity.
   */
  entityBounds?: Map<string, EntityBoundsInput>;
  /**
   * Entity snapshot map for attaching screenshots to viewpoints.
   * Key: "modelId:expressId", Value: data URL (PNG).
   * When provided, viewpoints will include the snapshot image.
   */
  entitySnapshots?: Map<string, string>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_AUTHOR = 'ids-validator@ifc-lite';
const DEFAULT_MAX_TOPICS = 1000;
const DEFAULT_FAILURE_COLOR = 'FFFF3333'; // Semi-opaque red
const DEFAULT_FAILURE_TOPIC_TYPE = 'Error';
const DEFAULT_PASS_TOPIC_TYPE = 'Info';
/**
 * Max comments per topic in per-specification grouping.
 * Prevents oversized topics when a spec fails hundreds of entities.
 * Remaining entities are summarized with a "... and N more" comment.
 */
const MAX_COMMENTS_PER_TOPIC = 50;

// ============================================================================
// Main export function
// ============================================================================

/**
 * Create a BCF project from IDS validation results.
 *
 * Each failing entity becomes a BCF topic with:
 * - Title: "{EntityType}: {EntityName}"
 * - Description: specification context + failure summary
 * - Comments: one per failed requirement with full details
 * - Viewpoint: entity selected, isolated, colored red
 *
 * @param report - IDS validation results
 * @param options - Export configuration
 * @returns BCF project ready for writeBCF()
 */
export function createBCFFromIDSReport(
  report: IDSReportInput,
  options: IDSBCFExportOptions = {},
): BCFProject {
  const {
    author = DEFAULT_AUTHOR,
    projectName,
    version = '2.1',
    topicGrouping = 'per-entity',
    includePassingEntities = false,
    failureTopicType = DEFAULT_FAILURE_TOPIC_TYPE,
    passTopicType = DEFAULT_PASS_TOPIC_TYPE,
    maxTopics = DEFAULT_MAX_TOPICS,
    failureColor = DEFAULT_FAILURE_COLOR,
    entityBounds,
    entitySnapshots,
  } = options;

  const project = createProject(projectName ?? report.title, version);

  switch (topicGrouping) {
    case 'per-entity':
      buildTopicsPerEntity(project, report, {
        author,
        includePassingEntities,
        failureTopicType,
        passTopicType,
        maxTopics,
        failureColor,
        entityBounds,
        entitySnapshots,
      });
      break;
    case 'per-specification':
      buildTopicsPerSpecification(project, report, {
        author,
        failureTopicType,
        maxTopics,
        failureColor,
        entityBounds,
        entitySnapshots,
      });
      break;
    case 'per-requirement':
      buildTopicsPerRequirement(project, report, {
        author,
        failureTopicType,
        maxTopics,
        failureColor,
        entityBounds,
        entitySnapshots,
      });
      break;
  }

  return project;
}

/**
 * Build the topic for a specification that FAILED on cardinality alone
 * (its applicability matched zero entities and minOccurs required at
 * least one). There is no entity to attach a per-entity or
 * per-requirement topic to, so grouping strategies that iterate
 * `entityResults` need this fallback or the failure never appears in
 * the exported BCF file at all.
 */
function createCardinalityFailureTopic(
  specResult: IDSSpecResultInput,
  author: string,
  failureTopicType: string,
): BCFTopic {
  const message = specResult.cardinalityResult?.message ?? 'Cardinality requirement not satisfied';
  return createTopic({
    title: `${specResult.specification.name}: cardinality requirement not met`,
    description: `Specification: ${specResult.specification.name}\n${specResult.specification.description ?? ''}\n\n${message} (0 applicable entities matched).`,
    author,
    topicType: failureTopicType,
    topicStatus: 'Open',
    priority: 'High',
    labels: ['IDS', specResult.specification.name, 'cardinality'],
  });
}

/**
 * Add a synthetic "Info" topic recording that `maxTopics` cut off `remaining`
 * further items. Without this, a large model silently drops entities past
 * the cap with no trace in the exported BCF file — the same silent-loss
 * shape `MAX_COMMENTS_PER_TOPIC`'s "... and N more" comment exists to avoid
 * for comments within one topic.
 */
function addTruncationNoticeTopic(
  project: BCFProject,
  author: string,
  remaining: number,
  itemLabel: string,
): void {
  if (remaining <= 0) return;
  const topic = createTopic({
    title: `... and ${remaining} more ${itemLabel}${remaining === 1 ? '' : 's'} (truncated at maxTopics)`,
    description: `The IDS validation report contained more ${itemLabel}s than the configured maxTopics limit. ${remaining} additional ${remaining === 1 ? 'entry was' : 'entries were'} not exported as BCF topics.`,
    author,
    topicType: 'Info',
    topicStatus: 'Open',
    labels: ['IDS', 'truncated'],
  });
  project.topics.set(topic.guid, topic);
}

// ============================================================================
// Per-entity grouping (default — recommended)
// ============================================================================

interface BuildOptions {
  author: string;
  includePassingEntities?: boolean;
  failureTopicType: string;
  passTopicType?: string;
  maxTopics: number;
  failureColor: string;
  entityBounds?: Map<string, EntityBoundsInput>;
  entitySnapshots?: Map<string, string>;
}

function buildTopicsPerEntity(
  project: BCFProject,
  report: IDSReportInput,
  opts: BuildOptions,
): void {
  let topicCount = 0;
  let qualifyingCount = 0;

  for (const specResult of report.specificationResults) {
    if (specResult.status === 'not_applicable') continue;

    // A cardinality-only failure (required entity type matched zero
    // times) has no entities to iterate below — without this branch the
    // failure is invisible in per-entity grouping.
    if (specResult.status === 'fail' && specResult.entityResults.length === 0) {
      qualifyingCount++;
      if (topicCount < opts.maxTopics) {
        const topic = createCardinalityFailureTopic(specResult, opts.author, opts.failureTopicType);
        project.topics.set(topic.guid, topic);
        topicCount++;
      }
      continue;
    }

    for (const entity of specResult.entityResults) {
      // Skip passing entities unless requested
      if (entity.passed && !opts.includePassingEntities) continue;

      qualifyingCount++;
      if (topicCount >= opts.maxTopics) continue;

      const failedReqs = entity.requirementResults.filter(r => r.status === 'fail');
      const totalReqs = entity.requirementResults.filter(r => r.status !== 'not_applicable').length;

      const entityLabel = entity.entityName || `#${entity.expressId}`;
      const isFailed = !entity.passed;

      // Build topic
      const topic = createTopic({
        title: `${entity.entityType}: ${entityLabel}`,
        description: buildEntityDescription(
          specResult,
          entity,
          failedReqs.length,
          totalReqs,
        ),
        author: opts.author,
        topicType: isFailed ? opts.failureTopicType : (opts.passTopicType ?? DEFAULT_PASS_TOPIC_TYPE),
        topicStatus: isFailed ? 'Open' : 'Closed',
        priority: isFailed ? (failedReqs.length === totalReqs ? 'High' : 'Medium') : undefined,
        labels: ['IDS', specResult.specification.name],
      });

      // Add viewpoint with isolation + selection + coloring + optional camera/snapshot
      // Viewpoint MUST be created first so comments can reference it via viewpointGuid
      let viewpointGuid: string | undefined;
      if (entity.globalId) {
        const boundsKey = `${entity.modelId}:${entity.expressId}`;
        const bounds = opts.entityBounds?.get(boundsKey);
        const snapshot = opts.entitySnapshots?.get(boundsKey);
        const viewpoint = buildEntityViewpoint(
          entity.globalId,
          isFailed ? opts.failureColor : undefined,
          bounds,
          snapshot,
        );
        topic.viewpoints.push(viewpoint);
        viewpointGuid = viewpoint.guid;
      }

      // Add a comment per failed requirement, linked to the viewpoint
      for (const req of failedReqs) {
        const comment = createComment({
          author: opts.author,
          comment: buildRequirementComment(req),
          viewpointGuid,
        });
        topic.comments.push(comment);
      }

      project.topics.set(topic.guid, topic);
      topicCount++;
    }
  }

  addTruncationNoticeTopic(project, opts.author, qualifyingCount - topicCount, 'entity');
}

// ============================================================================
// Per-specification grouping
// ============================================================================

function buildTopicsPerSpecification(
  project: BCFProject,
  report: IDSReportInput,
  opts: Omit<BuildOptions, 'includePassingEntities' | 'passTopicType'>,
): void {
  let topicCount = 0;
  let qualifyingCount = 0;

  for (const specResult of report.specificationResults) {
    if (specResult.status !== 'fail') continue;
    qualifyingCount++;
    if (topicCount >= opts.maxTopics) continue;

    const failedEntities = specResult.entityResults.filter(e => !e.passed);

    const topic = createTopic({
      title: `[FAIL] ${specResult.specification.name}`,
      description: buildSpecDescription(specResult),
      author: opts.author,
      topicType: opts.failureTopicType,
      topicStatus: 'Open',
      priority: specResult.failedCount > specResult.passedCount ? 'High' : 'Medium',
      labels: ['IDS', specResult.specification.name],
    });

    // Add viewpoint selecting all failed entities with globalIds (must be first for comment linking)
    const failedGuids = failedEntities
      .map(e => e.globalId)
      .filter((g): g is string => g !== undefined);

    let viewpointGuid: string | undefined;
    if (failedGuids.length > 0) {
      const viewpoint = buildMultiEntityViewpoint(failedGuids, opts.failureColor);
      topic.viewpoints.push(viewpoint);
      viewpointGuid = viewpoint.guid;
    }

    // Add comments for failed entities (capped to avoid huge topics), linked to viewpoint
    const maxCommentsPerTopic = MAX_COMMENTS_PER_TOPIC;
    const entitiesToComment = failedEntities.slice(0, maxCommentsPerTopic);

    for (const entity of entitiesToComment) {
      const entityLabel = entity.entityName || `#${entity.expressId}`;
      const failedReqs = entity.requirementResults.filter(r => r.status === 'fail');
      const failureSummary = failedReqs
        .map(r => r.failureReason ?? r.checkedDescription)
        .join('; ');

      const comment = createComment({
        author: opts.author,
        comment: `${entity.entityType}: ${entityLabel}${entity.globalId ? ` (${entity.globalId})` : ''}\n${failureSummary}`,
        viewpointGuid,
      });
      topic.comments.push(comment);
    }

    if (failedEntities.length > maxCommentsPerTopic) {
      const comment = createComment({
        author: opts.author,
        comment: `... and ${failedEntities.length - maxCommentsPerTopic} more failing entities`,
      });
      topic.comments.push(comment);
    }

    project.topics.set(topic.guid, topic);
    topicCount++;
  }

  addTruncationNoticeTopic(project, opts.author, qualifyingCount - topicCount, 'specification');
}

// ============================================================================
// Per-requirement grouping (like IfcOpenShell, but improved)
// ============================================================================

function buildTopicsPerRequirement(
  project: BCFProject,
  report: IDSReportInput,
  opts: Omit<BuildOptions, 'includePassingEntities' | 'passTopicType'>,
): void {
  let topicCount = 0;
  let qualifyingCount = 0;

  for (const specResult of report.specificationResults) {
    if (specResult.status !== 'fail') continue;

    // Cardinality-only failure — no entity/requirement to attach a topic
    // to below. Same fallback as buildTopicsPerEntity, for the same
    // reason: otherwise the failure has no BCF topic anywhere.
    if (specResult.entityResults.length === 0) {
      qualifyingCount++;
      if (topicCount < opts.maxTopics) {
        const topic = createCardinalityFailureTopic(specResult, opts.author, opts.failureTopicType);
        project.topics.set(topic.guid, topic);
        topicCount++;
      }
      continue;
    }

    for (const entity of specResult.entityResults) {
      if (entity.passed) continue;

      for (const req of entity.requirementResults) {
        if (req.status !== 'fail') continue;
        qualifyingCount++;
        if (topicCount >= opts.maxTopics) continue;

        const entityLabel = entity.entityName || `#${entity.expressId}`;

        const topic = createTopic({
          title: `${entity.entityType}: ${entityLabel} - ${req.failureReason ?? req.checkedDescription}`,
          description: `Specification: ${specResult.specification.name}\n${specResult.specification.description ?? ''}\n\nRequirement: ${req.checkedDescription}${entity.globalId ? `\nGlobalId: ${entity.globalId}` : ''}`,
          author: opts.author,
          topicType: opts.failureTopicType,
          topicStatus: 'Open',
          labels: ['IDS', specResult.specification.name],
        });

        // Viewpoint for single entity (must be first for comment linking)
        let viewpointGuid: string | undefined;
        if (entity.globalId) {
          const boundsKey = `${entity.modelId}:${entity.expressId}`;
          const bounds = opts.entityBounds?.get(boundsKey);
          const snapshot = opts.entitySnapshots?.get(boundsKey);
          const viewpoint = buildEntityViewpoint(entity.globalId, opts.failureColor, bounds, snapshot);
          topic.viewpoints.push(viewpoint);
          viewpointGuid = viewpoint.guid;
        }

        // Single comment with full failure detail, linked to viewpoint
        const comment = createComment({
          author: opts.author,
          comment: buildRequirementComment(req),
          viewpointGuid,
        });
        topic.comments.push(comment);

        project.topics.set(topic.guid, topic);
        topicCount++;
      }
    }
  }

  addTruncationNoticeTopic(project, opts.author, qualifyingCount - topicCount, 'requirement failure');
}

// ============================================================================
// Helpers — Description builders
// ============================================================================

function buildEntityDescription(
  specResult: IDSSpecResultInput,
  entity: IDSEntityResultInput,
  failedCount: number,
  totalCount: number,
): string {
  const lines: string[] = [];

  if (!entity.passed) {
    lines.push(`IDS Validation Failure — ${failedCount} of ${totalCount} requirements failed`);
  } else {
    lines.push('IDS Validation Passed — all requirements satisfied');
  }

  lines.push('');
  lines.push(`Specification: ${specResult.specification.name}`);
  if (specResult.specification.description) {
    lines.push(`Description: ${specResult.specification.description}`);
  }
  lines.push(`Entity Type: ${entity.entityType}`);
  if (entity.globalId) {
    lines.push(`GlobalId: ${entity.globalId}`);
  }
  if (entity.entityName) {
    lines.push(`Name: ${entity.entityName}`);
  }

  return lines.join('\n');
}

function buildSpecDescription(specResult: IDSSpecResultInput): string {
  const lines: string[] = [];

  lines.push(`IDS Specification Failure — ${specResult.failedCount} of ${specResult.applicableCount} entities failed`);

  if (specResult.specification.description) {
    lines.push('');
    lines.push(specResult.specification.description);
  }

  lines.push('');
  lines.push(`Applicable: ${specResult.applicableCount}`);
  lines.push(`Passed: ${specResult.passedCount}`);
  lines.push(`Failed: ${specResult.failedCount}`);

  return lines.join('\n');
}

function buildRequirementComment(req: IDSRequirementResultInput): string {
  const lines: string[] = [];

  lines.push(`[${req.facetType}] ${req.checkedDescription}`);

  if (req.failureReason) {
    lines.push(`Failure: ${req.failureReason}`);
  }
  if (req.expectedValue) {
    lines.push(`Expected: ${req.expectedValue}`);
  }
  if (req.actualValue) {
    lines.push(`Actual: ${req.actualValue}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Helpers — Camera computation
// ============================================================================

/**
 * Compute a BCF perspective camera from entity bounds.
 *
 * Bounds are in viewer coordinates (Y-up).
 * BCF uses Z-up, so we convert:
 *   BCF.x = Viewer.x
 *   BCF.y = -Viewer.z
 *   BCF.z = Viewer.y
 *
 * Camera is placed at a southeast-isometric angle from the entity center,
 * at a distance that frames the entity's bounding box with padding.
 */
function computeCameraFromBounds(bounds: EntityBoundsInput): BCFPerspectiveCamera {
  // Center in viewer coords (Y-up)
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;

  // Max extent for framing distance
  const sx = bounds.max.x - bounds.min.x;
  const sy = bounds.max.y - bounds.min.y;
  const sz = bounds.max.z - bounds.min.z;
  const maxSize = Math.max(sx, sy, sz, 0.1); // Floor to avoid zero

  // Camera distance: fit maxSize into 60deg FOV with 1.5x padding
  const fovRad = (60 * Math.PI) / 180;
  const distance = (maxSize / 2) / Math.tan(fovRad / 2) * 1.5;

  // Southeast-isometric offset in viewer coords (Y-up):
  // camera position = center + normalized(0.6, 0.5, 0.6) * distance
  const offsetLen = Math.sqrt(0.6 * 0.6 + 0.5 * 0.5 + 0.6 * 0.6);
  const ox = (0.6 / offsetLen) * distance;
  const oy = (0.5 / offsetLen) * distance;
  const oz = (0.6 / offsetLen) * distance;

  const camX = cx + ox;
  const camY = cy + oy;
  const camZ = cz + oz;

  // Direction: from camera to center (viewer coords)
  const dx = cx - camX;
  const dy = cy - camY;
  const dz = cz - camZ;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Convert to BCF coords (Z-up)
  // Viewer (x, y, z) → BCF (x, -z, y)
  return {
    cameraViewPoint: { x: camX, y: -camZ, z: camY },
    cameraDirection: {
      x: dx / dLen,
      y: -dz / dLen,
      z: dy / dLen,
    },
    cameraUpVector: { x: 0, y: 0, z: 1 }, // BCF Z-up
    fieldOfView: 60,
  };
}

// ============================================================================
// Helpers — Viewpoint builders
// ============================================================================

/**
 * Build a viewpoint for a single entity: selected, isolated, colored.
 * Optionally includes a perspective camera computed from entity bounds,
 * and a snapshot image if provided.
 */
function buildEntityViewpoint(
  globalId: string,
  failureColor: string | undefined,
  bounds?: EntityBoundsInput,
  snapshot?: string,
): BCFViewpoint {
  // Create independent component objects to prevent mutation side effects
  const viewpoint: BCFViewpoint = {
    guid: generateUuid(),
    components: {
      selection: [{ ifcGuid: globalId }],
      visibility: {
        defaultVisibility: false,
        exceptions: [{ ifcGuid: globalId }],
      },
    },
  };

  if (failureColor) {
    viewpoint.components!.coloring = [
      {
        color: failureColor,
        components: [{ ifcGuid: globalId }],
      },
    ];
  }

  // Compute camera from bounds (viewer Y-up → BCF Z-up)
  if (bounds) {
    viewpoint.perspectiveCamera = computeCameraFromBounds(bounds);
  }

  // Attach snapshot
  if (snapshot) {
    viewpoint.snapshot = snapshot;
  }

  return viewpoint;
}

/**
 * Build a viewpoint for multiple entities: all selected and visible, colored.
 * Used by per-specification grouping where one topic covers many entities.
 */
function buildMultiEntityViewpoint(
  globalIds: string[],
  failureColor: string | undefined,
): BCFViewpoint {
  // Use independent arrays per field to prevent mutation side effects
  const viewpoint: BCFViewpoint = {
    guid: generateUuid(),
    components: {
      selection: globalIds.map(id => ({ ifcGuid: id })),
      visibility: {
        defaultVisibility: false,
        exceptions: globalIds.map(id => ({ ifcGuid: id })),
      },
    },
  };

  if (failureColor) {
    viewpoint.components!.coloring = [
      {
        color: failureColor,
        components: globalIds.map(id => ({ ifcGuid: id })),
      },
    ];
  }

  return viewpoint;
}
