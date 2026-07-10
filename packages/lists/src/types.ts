/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for the Lists feature - configurable property tables from IFC data
 */

import type { IfcTypeEnum, PropertySet, QuantitySet } from '@ifc-lite/data';

// ============================================================================
// Data Provider Interface
// ============================================================================

/**
 * Abstract interface for accessing IFC data during list execution.
 *
 * Consumers implement this to bridge their data source (e.g., IfcDataStore,
 * server model, or custom store) to the list engine.
 *
 * @example
 * ```typescript
 * const provider: ListDataProvider = {
 *   getEntitiesByType: (type) => myStore.entities.getByType(type),
 *   getEntityName: (id) => myStore.entities.getName(id),
 *   getEntityGlobalId: (id) => myStore.entities.getGlobalId(id),
 *   getEntityDescription: (id) => myStore.entities.getDescription(id),
 *   getEntityObjectType: (id) => myStore.entities.getObjectType(id),
 *   getEntityTypeName: (id) => myStore.entities.getTypeName(id),
 *   getPropertySets: (id) => myStore.properties.getForEntity(id),
 *   getQuantitySets: (id) => myStore.quantities.getForEntity(id),
 * };
 * ```
 */
export interface ListDataProvider {
  /** Get all entity IDs matching the given IFC type */
  getEntitiesByType(type: IfcTypeEnum): number[];

  /** Get entity name (IfcRoot.Name) by express ID */
  getEntityName(expressId: number): string;
  /** Get entity GlobalId by express ID */
  getEntityGlobalId(expressId: number): string;
  /** Get entity description by express ID */
  getEntityDescription(expressId: number): string;
  /** Get entity object type / predefined type by express ID */
  getEntityObjectType(expressId: number): string;
  /** Get entity tag (IfcElement.Tag) by express ID */
  getEntityTag(expressId: number): string;
  /** Get IFC type name (e.g., "IfcWall") by express ID */
  getEntityTypeName(expressId: number): string;

  /** Get all property sets for an entity (handles on-demand extraction) */
  getPropertySets(expressId: number): PropertySet[];
  /** Get all quantity sets for an entity (handles on-demand extraction) */
  getQuantitySets(expressId: number): QuantitySet[];

  // ── Optional accessors (added for richer list targeting / columns) ──
  // Implementers built before these existed keep working: the engine
  // degrades gracefully when a method is absent (no-class lists resolve
  // to no rows; material/classification/storey conditions never match).

  /**
   * All entity express IDs in the model. Used to target a list at every
   * element regardless of IFC class (when `entityTypes` is empty).
   */
  getAllEntityIds?(): number[];
  /** Material name(s) for the element — top-level material plus any
   *  layer / constituent / profile / list-member names. */
  getMaterialNames?(expressId: number): string[];
  /** Classification references associated with the element. */
  getClassifications?(expressId: number): ListClassificationRef[];
  /** Building-storey name the element belongs to, or '' when unplaced. */
  getStoreyName?(expressId: number): string;
  /** Name of the element's IMMEDIATE spatial container — the direct
   *  IfcRelContainedInSpatialStructure parent (a storey, or for infrastructure
   *  the IfcBridgePart / IfcRoadPart / IfcSpatialZone it sits in). Falls back to
   *  the container's IFC class when the container is unnamed, '' when the element
   *  is uncontained. Used by the `spatial` column at `Container` level (Bonsai's
   *  "container"). */
  getContainerName?(expressId: number): string;
  /** IfcBuilding name containing the element, or '' when unplaced. Used by the
   *  `spatial` column at `Building` level. */
  getBuildingName?(expressId: number): string;
  /** IfcSite name containing the element, or '' when unplaced. Used by the
   *  `spatial` column at `Site` level. */
  getSiteName?(expressId: number): string;
  /** IfcProject.Name for this model — constant for every element the provider
   *  serves (one IfcProject per file). Used by the `spatial` column at
   *  `Project` level. '' when the model has no named project. */
  getProjectName?(): string;
  /** Source model / file display name — constant for every element the
   *  provider serves. Used by the `model` column to identify which federated
   *  file a row comes from. '' when unknown (e.g. single-model legacy path). */
  getModelName?(): string;
  /** IFC `PredefinedType` enum token (e.g. "FLOOR", "FLOORING"), or '' when
   *  the element has none. Used by the `PredefinedType` attribute column. */
  getEntityPredefinedType?(expressId: number): string;
  /**
   * Discover EVERY property set / property and quantity set / quantity in
   * the model — complete and independent of entity-type selection — so the
   * column picker can offer all data even with no type chosen. Optional:
   * when absent, callers fall back to the type-sampled `discoverColumns()`.
   */
  discoverAllColumns?(): DiscoveredColumns;
}

/** A classification reference exposed to the list engine (code + name). */
export interface ListClassificationRef {
  system?: string;
  code?: string;
  name?: string;
}

// ============================================================================
// List Definition (persisted config)
// ============================================================================

export interface ListDefinition {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;

  /** Which entity types to include */
  entityTypes: IfcTypeEnum[];

  /**
   * Optional explicit element scope — a snapshot of express IDs per model
   * (e.g. from a search/filter result), keyed by modelId. When present, the
   * list targets exactly these elements per model and `entityTypes` is
   * ignored; `conditions` still apply on top. Keyed by model so federated
   * snapshots don't over-select when local express IDs collide across files.
   */
  expressIdsByModel?: Record<string, number[]>;

  /** Optional property-based filter conditions */
  conditions: PropertyCondition[];

  /** Columns to display */
  columns: ColumnDefinition[];

  /** Current sort state */
  sortBy?: { columnId: string; direction: 'asc' | 'desc' };

  /** Optional grouping + summation for the summary view */
  grouping?: ListGrouping;
}

export interface ListGrouping {
  /** Column id to group rows by (e.g. a Type / Material / Storey column). */
  columnId: string;
  /** Column ids whose numeric values are summed per group and overall. */
  sumColumnIds: string[];
}

// ============================================================================
// Source Set Filtering
// ============================================================================

export interface PropertyCondition {
  /**
   * Where the compared value comes from:
   * - `attribute` — a built-in attribute (Name, Class, Description, …)
   * - `property` / `quantity` — a pset / qto value (uses `psetName`)
   * - `material` — any of the element's material names (multi-valued)
   * - `classification` — any classification code or name (multi-valued)
   * - `spatial` — a spatial-container name; `propertyName` selects the level
   *   (`Container`, `Storey` (default), `Building`, `Site`, or `Project`)
   * - `model` — the source model / file name (federation identity)
   */
  source: 'attribute' | 'property' | 'quantity' | 'material' | 'classification' | 'spatial' | 'model';
  /** Property set name (for property/quantity sources) */
  psetName?: string;
  /** Attribute / property / quantity name, or the spatial level for `spatial`
   *  (`Container` | `Storey` | `Building` | `Site` | `Project`). Ignored for
   *  material/classification/model. */
  propertyName: string;
  operator: ConditionOperator;
  value: string | number | boolean;
}

export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'exists';

// ============================================================================
// Column Definitions
// ============================================================================

export interface ColumnDefinition {
  id: string;
  /**
   * Where the column value comes from. `material` / `classification` are
   * multi-valued (joined with ", "); `spatial` is a spatial-container name at
   * the level named by `propertyName` (`Container` | `Storey` (default) |
   * `Building` | `Site` | `Project`); `model` is the source model / file name
   * (federation identity).
   */
  source: 'attribute' | 'property' | 'quantity' | 'material' | 'classification' | 'spatial' | 'model';
  /** For property: pset name. For quantity: qset name. */
  psetName?: string;
  /** Attribute / property / quantity name, or the spatial level for `spatial`
   *  (`Container` | `Storey` | `Building` | `Site` | `Project`). Ignored for
   *  material/classification/model. */
  propertyName: string;
  /** Display label override */
  label?: string;
  /**
   * `QuantityType` this column resolved to (from `@ifc-lite/data`), when
   * `source: 'quantity'`. Populated by `executeList` from the first matched
   * entity's quantity (issue #1573), so display-unit conversion downstream
   * (the viewer's list/schedule export) knows what unit-KIND a raw numeric
   * cell is in. Not part of the persisted `ListDefinition` authoring schema —
   * it's an execution-time annotation the engine derives fresh every run.
   */
  quantityType?: number;
  /**
   * Raw IFC measure value type (e.g. "IFCVOLUMETRICFLOWRATEMEASURE"), when
   * `source: 'property'` and the matched property carries one. Same
   * execution-time-only role as `quantityType`, for measure properties
   * (issue #1573).
   */
  dataType?: string;
}

// ============================================================================
// List Execution Results
// ============================================================================

export interface ListResult {
  columns: ColumnDefinition[];
  rows: ListRow[];
  /** Total matched entities before pagination */
  totalCount: number;
  /** Execution time in ms */
  executionTime: number;
  /** Per-group breakdown — present only when `grouping` is configured. */
  groups?: ListGroup[];
  /** Whole-result aggregates (count + per-column sums). Present when
   *  `grouping` is configured. */
  summary?: ListSummary;
}

/** One group in a grouped list result. */
export interface ListGroup {
  /** Group-by value, stringified. Empty values group under `label`. */
  key: string;
  /** Display label for the group header. */
  label: string;
  /** Number of rows in the group. */
  count: number;
  /** columnId → summed numeric value, for the configured sum columns. */
  sums: Record<string, number>;
}

/** Whole-result aggregates. */
export interface ListSummary {
  count: number;
  sums: Record<string, number>;
}

export interface ListRow {
  /** Entity reference for 3D selection */
  entityId: number;
  modelId: string;
  /** Column values in same order as ListResult.columns */
  values: CellValue[];
}

export type CellValue = string | number | boolean | null;

// ============================================================================
// Column Discovery
// ============================================================================

/** Available columns discovered from the model */
export interface DiscoveredColumns {
  attributes: string[];
  properties: Map<string, string[]>; // psetName -> propNames[]
  quantities: Map<string, string[]>; // qsetName -> quantNames[]
}

// ============================================================================
// Built-in Attributes
// ============================================================================

export const ENTITY_ATTRIBUTES = [
  'Name',
  'GlobalId',
  'Class',
  'Description',
  'ObjectType',
  'PredefinedType',
  'Tag',
] as const;

export type EntityAttribute = typeof ENTITY_ATTRIBUTES[number];
