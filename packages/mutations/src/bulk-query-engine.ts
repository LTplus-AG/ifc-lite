/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bulk Query Engine: SQL-like selection and modification for multiple
 * IFC entities at once.
 */
import type { EntityTable, SpatialHierarchy } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation, PropertyValue } from './types.js';
import { checkMutationGuard, type MutationGuard } from './mutation-guard.js';
import { compileGuardedRegex } from '@ifc-lite/regex-guard';
import { effectiveBulkCandidates, effectiveRootAttribute } from './bulk-query-candidates.js';
import { applyBulkAttribute, bulkAttributeRefusal } from './bulk-attribute-action.js';
import type { ModelSchema } from './schema-attribute-names.js';

/**
 * Selection criteria for bulk queries
 */
export interface SelectionCriteria {
  /** Filter by entity types (e.g., [10, 11] for IfcWall, IfcWallStandardCase) */
  entityTypes?: number[];
  /** Filter by storey IDs */
  storeys?: number[];
  /** Filter by building IDs */
  buildings?: number[];
  /** Filter by site IDs */
  sites?: number[];
  /** Filter by space IDs */
  spaces?: number[];
  /** Filter by global IDs */
  globalIds?: string[];
  /** Filter by express IDs */
  expressIds?: number[];
  /** Filter by name pattern (regex) */
  namePattern?: string;
}

/**
 * Action to apply to selected entities
 */
export type BulkAction =
  | {
      type: 'SET_PROPERTY';
      psetName: string;
      propName: string;
      value: PropertyValue;
      valueType: PropertyValueType;
    }
  | {
      type: 'DELETE_PROPERTY';
      psetName: string;
      propName: string;
    }
  | {
      type: 'SET_ATTRIBUTE';
      /**
       * Exact EXPRESS attribute name, one of `BULK_WRITABLE_ATTRIBUTES`
       * (`Name`, `Description`, `ObjectType`, `Tag`). An entity whose class
       * does not declare it fails the run instead of being skipped.
       */
      attribute: string;
      value: string;
    }
  | {
      type: 'SET_ENTITY_TYPE';
      /** Target IFC class (PascalCase, e.g. "IfcColumn"). */
      entityType: string;
      /** Optional PredefinedType to set on the target class. */
      predefinedType?: string | null;
    };

/**
 * Complete bulk query
 */
export interface BulkQuery {
  select: SelectionCriteria;
  action: BulkAction;
}

/**
 * Result of a bulk query preview
 */
export interface BulkQueryPreview {
  matchedEntityIds: number[];
  matchedCount: number;
  estimatedMutations: number;
}

/**
 * Result of a bulk query execution
 */
export interface BulkQueryResult {
  mutations: Mutation[];
  affectedEntityCount: number;
  success: boolean;
  errors?: string[];
}

/**
 * Bulk Query Engine for mass property updates
 */
export class BulkQueryEngine {
  private entities: EntityTable;
  private spatialHierarchy: SpatialHierarchy | null;
  private mutationView: MutablePropertyView;
  private strings: { get(idx: number): string } | null;
  /** expressId → array index lookup, built once to avoid O(n) scans */
  private expressIdIndex: Map<number, number>;
  /** See mutation-guard.ts: consulted once by `applyAction`, opt-in. */
  private canEdit: MutationGuard | undefined;
  /** The model's declared schema, which decides the attributes SET_ATTRIBUTE may write. */
  private schemaVersion: ModelSchema | undefined;
  /** Live container membership supplied by a parser-aware caller. */
  private spatialMembers: ((containerId: number) => readonly number[]) | undefined;

  constructor(
    entities: EntityTable,
    mutationView: MutablePropertyView,
    spatialHierarchy?: SpatialHierarchy | null,
    strings?: { get(idx: number): string } | null,
    canEdit?: MutationGuard,
    schemaVersion?: ModelSchema,
    spatialMembers?: (containerId: number) => readonly number[],
  ) {
    this.entities = entities;
    this.mutationView = mutationView;
    this.spatialHierarchy = spatialHierarchy || null;
    this.strings = strings || null;
    this.canEdit = canEdit;
    this.schemaVersion = schemaVersion;
    this.spatialMembers = spatialMembers;

    // Build O(1) lookup map once instead of O(n) linear scan per query
    this.expressIdIndex = new Map<number, number>();
    // @raw-entity-enumeration-ok source rows build an expressId-to-slot lookup; effectiveBulkCandidates applies the mutation view
    for (let i = 0; i < entities.count; i++) {
      this.expressIdIndex.set(entities.expressId[i], i);
    }
  }

  /**
   * Select entities matching criteria
   */
  select(criteria: SelectionCriteria): number[] {
    // The session's effective entities (#5196, #5249): tombstones out,
    // creations in, a retyped entity under its new class.
    let candidates = effectiveBulkCandidates(this.entities, this.expressIdIndex, this.mutationView, criteria.entityTypes);

    // @raw-entity-enumeration-ok these source buckets are consumed only for an unchanged session; a live resolver replaces them for edited sessions
    for (const [ids, bucket] of [
      [criteria.storeys, this.spatialHierarchy?.byStorey],
      [criteria.buildings, this.spatialHierarchy?.byBuilding],
      [criteria.sites, this.spatialHierarchy?.bySite],
      [criteria.spaces, this.spatialHierarchy?.bySpace],
    ] as const) {
      if (!ids?.length) continue;
      if (!this.spatialMembers && (this.mutationView.hasPendingChanges() || !bucket)) {
        throw new Error('BulkQueryEngine: spatial filter requires live membership for edited or unavailable spatial data.');
      }
      const members = new Set<number>();
      for (const containerId of ids) {
        // @raw-entity-enumeration-ok parsed bucket is used only for a session with no pending mutation; live sessions use spatialMembers
        for (const member of this.spatialMembers?.(containerId) ?? bucket?.get(containerId) ?? []) members.add(member);
      }
      candidates = candidates.filter((id) => members.has(id));
    }

    // Filter by express IDs (direct selection)
    if (criteria.expressIds && criteria.expressIds.length > 0) {
      const idSet = new Set(criteria.expressIds);
      candidates = candidates.filter((id) => idSet.has(id));
    }

    // Fail closed when a globalId/namePattern restriction is requested but the
    // string table is unavailable, rather than silently dropping the filter and
    // returning the full candidate set (which would over-apply bulk edits).
    if (criteria.globalIds && criteria.globalIds.length > 0 && !this.strings) {
      throw new Error(
        'BulkQueryEngine: globalIds filter requires a string table; refusing to run an unscoped bulk selection.'
      );
    }
    if (criteria.namePattern && !this.strings) {
      throw new Error(
        'BulkQueryEngine: namePattern filter requires a string table; refusing to run an unscoped bulk selection.'
      );
    }

    // Filter by global IDs
    if (criteria.globalIds && criteria.globalIds.length > 0 && this.strings) {
      const globalIdSet = new Set(criteria.globalIds);
      candidates = candidates.filter((id) => globalIdSet.has(this.rootAttribute(id, 'GlobalId')));
    }

    // Filter by name pattern
    if (criteria.namePattern && this.strings) {
      const regex = compileGuardedRegex(criteria.namePattern, 'i'); // caller-supplied: guard against ReDoS
      candidates = candidates.filter((id) => regex.test(this.rootAttribute(id, 'Name')));
    }

    return candidates;
  }

  /**
   * Preview a bulk query without executing
   */
  preview(query: BulkQuery): BulkQueryPreview {
    const matchedEntityIds = this.select(query.select);
    return {
      matchedEntityIds,
      matchedCount: matchedEntityIds.length,
      estimatedMutations: matchedEntityIds.length,
    };
  }

  /**
   * Execute a bulk query
   */
  execute(query: BulkQuery): BulkQueryResult {
    // An unwritable attribute is one refusal for the run, not one error per entity.
    const refusal = query.action.type === 'SET_ATTRIBUTE' ? bulkAttributeRefusal(query.action.attribute) : null;
    if (refusal) return { mutations: [], affectedEntityCount: 0, success: false, errors: [refusal] };
    const entityIds = this.select(query.select);
    const mutations: Mutation[] = [];
    const errors: string[] = [];

    for (const entityId of entityIds) {
      try {
        const mutation = this.applyAction(entityId, query.action);
        if (mutation) {
          mutations.push(mutation);
        }
      } catch (error) {
        errors.push(`Entity ${entityId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      mutations,
      affectedEntityCount: mutations.length,
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Apply an action to a single entity (public for chunked execution from UI)
   */
  applyAction(entityId: number, action: BulkAction): Mutation | null {
    checkMutationGuard(this.canEdit);
    switch (action.type) {
      case 'SET_PROPERTY':
        return this.mutationView.setProperty(
          entityId,
          action.psetName,
          action.propName,
          action.value,
          action.valueType
        );

      case 'DELETE_PROPERTY':
        return this.mutationView.deleteProperty(
          entityId,
          action.psetName,
          action.propName
        );

      case 'SET_ATTRIBUTE':
        return applyBulkAttribute(this.entities, this.mutationView, entityId, action.attribute, action.value, this.schemaVersion);

      case 'SET_ENTITY_TYPE':
        return this.mutationView.setEntityType(
          entityId,
          action.entityType,
          action.predefinedType ?? null,
        );

      default:
        return null;
    }
  }

  /** Effective GlobalId / Name of a candidate (see bulk-query-candidates.ts). */
  private rootAttribute(expressId: number, attribute: 'GlobalId' | 'Name'): string {
    const row = this.expressIdIndex.get(expressId);
    return effectiveRootAttribute(this.entities, this.strings!, this.mutationView, row, expressId, attribute);
  }
}
