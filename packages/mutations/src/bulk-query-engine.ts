/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bulk Query Engine for mass property updates
 *
 * Provides SQL-like query capabilities for selecting and modifying
 * multiple IFC entities at once.
 */

import type { EntityTable, SpatialHierarchy, PropertyTable } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation, PropertyValue } from './types.js';

/**
 * Filter operators for property values
 */
export type FilterOperator =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'IS_NULL'
  | 'IS_NOT_NULL';

/**
 * Property filter condition
 */
export interface PropertyFilter {
  psetName?: string;
  propName: string;
  operator: FilterOperator;
  value?: PropertyValue;
}

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
  /** Filter by property conditions */
  propertyFilters?: PropertyFilter[];
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
      attribute: 'name' | 'description' | 'objectType';
      value: string;
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
  private properties: PropertyTable | null;
  private mutationView: MutablePropertyView;
  private strings: { get(idx: number): string } | null;
  /** expressId → array index lookup, built once to avoid O(n) scans */
  private expressIdIndex: Map<number, number>;

  constructor(
    entities: EntityTable,
    mutationView: MutablePropertyView,
    spatialHierarchy?: SpatialHierarchy | null,
    properties?: PropertyTable | null,
    strings?: { get(idx: number): string } | null
  ) {
    this.entities = entities;
    this.mutationView = mutationView;
    this.spatialHierarchy = spatialHierarchy || null;
    this.properties = properties || null;
    this.strings = strings || null;

    // Build O(1) lookup map once instead of O(n) linear scan per query
    this.expressIdIndex = new Map<number, number>();
    for (let i = 0; i < entities.count; i++) {
      this.expressIdIndex.set(entities.expressId[i], i);
    }
  }

  /**
   * Select entities matching criteria
   */
  select(criteria: SelectionCriteria): number[] {
    let candidates: number[];

    // Fast path: filter by entity types directly during iteration instead of
    // building the full ID list first, then filtering (avoids two passes).
    if (criteria.entityTypes && criteria.entityTypes.length > 0) {
      const typeSet = new Set(criteria.entityTypes);
      candidates = [];
      for (let i = 0; i < this.entities.count; i++) {
        if (typeSet.has(this.entities.typeEnum[i])) {
          candidates.push(this.entities.expressId[i]);
        }
      }
    } else {
      candidates = this.getAllEntityIds();
    }

    // Filter by storeys
    if (criteria.storeys && criteria.storeys.length > 0 && this.spatialHierarchy) {
      const storeySet = new Set(criteria.storeys);
      const storeyElements = new Set<number>();
      for (const storeyId of storeySet) {
        const elements = this.spatialHierarchy.byStorey.get(storeyId);
        if (elements) {
          for (const el of elements) {
            storeyElements.add(el);
          }
        }
      }
      candidates = candidates.filter((id) => storeyElements.has(id));
    }

    // Filter by buildings
    if (criteria.buildings && criteria.buildings.length > 0 && this.spatialHierarchy) {
      const buildingSet = new Set(criteria.buildings);
      const buildingElements = new Set<number>();
      for (const buildingId of buildingSet) {
        const elements = this.spatialHierarchy.byBuilding.get(buildingId);
        if (elements) {
          for (const el of elements) {
            buildingElements.add(el);
          }
        }
      }
      candidates = candidates.filter((id) => buildingElements.has(id));
    }

    // Filter by spaces
    if (criteria.spaces && criteria.spaces.length > 0 && this.spatialHierarchy) {
      const spaceSet = new Set(criteria.spaces);
      const spaceElements = new Set<number>();
      for (const spaceId of spaceSet) {
        const elements = this.spatialHierarchy.bySpace.get(spaceId);
        if (elements) {
          for (const el of elements) {
            spaceElements.add(el);
          }
        }
      }
      candidates = candidates.filter((id) => spaceElements.has(id));
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
      candidates = candidates.filter((id) => {
        const idx = this.findEntityIndex(id);
        if (idx === -1) return false;
        const globalIdIdx = this.entities.globalId[idx];
        const globalId = this.strings!.get(globalIdIdx);
        return globalIdSet.has(globalId);
      });
    }

    // Filter by name pattern
    if (criteria.namePattern && this.strings) {
      const regex = new RegExp(criteria.namePattern, 'i');
      candidates = candidates.filter((id) => {
        const idx = this.findEntityIndex(id);
        if (idx === -1) return false;
        const nameIdx = this.entities.name[idx];
        const name = this.strings!.get(nameIdx);
        return regex.test(name);
      });
    }

    // Filter by property conditions
    if (criteria.propertyFilters && criteria.propertyFilters.length > 0) {
      for (const filter of criteria.propertyFilters) {
        candidates = this.filterByProperty(candidates, filter);
      }
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
        // Attribute mutations would need to be implemented
        // For now, we'll skip these
        return null;

      default:
        return null;
    }
  }

  /**
   * Filter candidates by property condition
   */
  private filterByProperty(candidates: number[], filter: PropertyFilter): number[] {
    return candidates.filter((entityId) => {
      // Get property value from mutation view (includes mutations)
      const value = filter.psetName
        ? this.mutationView.getPropertyValue(entityId, filter.psetName, filter.propName)
        : this.findPropertyByName(entityId, filter.propName);

      return this.matchesFilter(value, filter);
    });
  }

  /**
   * Find a property by name across all property sets
   */
  private findPropertyByName(entityId: number, propName: string): PropertyValue | null {
    if (!this.properties) return null;

    const psets = this.properties.getForEntity(entityId);
    for (const pset of psets) {
      for (const prop of pset.properties) {
        if (prop.name === propName) {
          return prop.value;
        }
      }
    }
    return null;
  }

  /**
   * Check if a value matches a filter condition
   */
  private matchesFilter(value: PropertyValue | null, filter: PropertyFilter): boolean {
    // Handle null checks
    if (filter.operator === 'IS_NULL') {
      return value === null || value === undefined;
    }
    if (filter.operator === 'IS_NOT_NULL') {
      return value !== null && value !== undefined;
    }

    // For other operators, null values don't match
    if (value === null || value === undefined) {
      return false;
    }

    const filterValue = filter.value;

    // String operations
    if (typeof value === 'string' && typeof filterValue === 'string') {
      switch (filter.operator) {
        case '=':
          return value === filterValue;
        case '!=':
          return value !== filterValue;
        case 'CONTAINS':
          return value.toLowerCase().includes(filterValue.toLowerCase());
        case 'STARTS_WITH':
          return value.toLowerCase().startsWith(filterValue.toLowerCase());
        case 'ENDS_WITH':
          return value.toLowerCase().endsWith(filterValue.toLowerCase());
        default:
          return false;
      }
    }

    // Numeric operations
    if (typeof value === 'number' && typeof filterValue === 'number') {
      switch (filter.operator) {
        case '=':
          return value === filterValue;
        case '!=':
          return value !== filterValue;
        case '>':
          return value > filterValue;
        case '<':
          return value < filterValue;
        case '>=':
          return value >= filterValue;
        case '<=':
          return value <= filterValue;
        default:
          return false;
      }
    }

    // Boolean operations
    if (typeof value === 'boolean') {
      const boolFilterValue = filterValue === true || filterValue === 'true';
      switch (filter.operator) {
        case '=':
          return value === boolFilterValue;
        case '!=':
          return value !== boolFilterValue;
        default:
          return false;
      }
    }

    return false;
  }

  /**
   * Get all entity IDs
   */
  private getAllEntityIds(): number[] {
    const ids: number[] = [];
    for (let i = 0; i < this.entities.count; i++) {
      ids.push(this.entities.expressId[i]);
    }
    return ids;
  }

  /**
   * Find the index of an entity by ID (O(1) via pre-built map)
   */
  private findEntityIndex(expressId: number): number {
    return this.expressIdIndex.get(expressId) ?? -1;
  }
}
