/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ObjectCountSummary } from './objectCountSummary';

/** Builders need only an expansion decision, so search can project a fully expanded tree without changing user state. */
export type ExpansionLookup = Pick<ReadonlySet<string>, 'has'>;

/** Node types for the hierarchy tree */
export type NodeType =
  | 'unified-storey'      // Grouped storey across models (multi-model only)
  | 'model-header'        // Model visibility control (section header or individual model)
  | 'IfcProject'          // Project node
  | 'IfcSite'             // Site node
  | 'IfcBuilding'         // Building node
  | 'IfcFacility'         // IFC4.3 facility root
  | 'IfcBridge'           // IFC4.3 bridge root
  | 'IfcRoad'             // IFC4.3 road root
  | 'IfcRailway'          // IFC4.3 railway root
  | 'IfcMarineFacility'   // IFC4.3 marine facility root
  | 'IfcBuildingStorey'   // Storey node
  | 'IfcFacilityPart'     // IFC4.3 facility part
  | 'IfcBridgePart'       // IFC4.3 bridge part
  | 'IfcRoadPart'         // IFC4.3 road part
  | 'IfcRailwayPart'      // IFC4.3 railway part
  | 'IfcMarinePart'       // IFC4.3 marine facility part
  | 'IfcFacilityPartCommon' // IFC4.3 generic facility part
  | 'IfcSpace'            // Space node (net room area)
  | 'IfcSpatialZone'      // Spatial zone node (modelled gross area / GFA)
  | 'type-group'          // IFC class grouping header (e.g., "IfcWall (47)")
  | 'ifc-type'            // IFC type entity node (e.g., "IfcWallType/W01")
  | 'material-group'      // Material grouping (e.g., "Concrete (47)") from the Materials tab
  | 'group'               // IfcGroup/IfcSystem/IfcZone entity row from the Groups tab (#1622)
  | 'group-member'        // Member row under an expanded group (#1622)
  | 'model-tag-group'     // Model-tag group header in the Models section's "By tag" view (#4215)
  | 'other-group'         // "Other" bucket header for geometry-less physical elements (#4764)
  | 'element';            // Individual element

export interface TreeNode {
  id: string;  // Unique ID for the node (can be composite)
  /** Local express IDs this node represents */
  expressIds: number[];
  /**
   * Federated global IDs for selection/visibility operations. For a
   * `type-group`/`ifc-type` node, a geometry-less assembly member is
   * substituted for its geometry-bearing `IfcRelAggregates` parts and the
   * list is deduped — so it is NOT index-aligned with `expressIds`/
   * `memberGlobalIds` (different length, different order). Use `globalIds`
   * for "what to isolate / eye-toggle"; use `memberGlobalIds` (or
   * `expressIds`) for "which entity is this row's Nth member".
   */
  globalIds: number[];
  /**
   * Index-aligned with `expressIds`: each member's OWN global ID, never a
   * substituted aggregated part. Only populated on grouping nodes
   * (`type-group`, `ifc-type`) where `globalIds` above is not aligned —
   * lets a click resolve "the first member of this group" to the group's
   * own first entity instead of an arbitrary aggregated part of it.
   */
  memberGlobalIds?: number[];
  /** Structured entity expressId for selectable non-element nodes (for example IFC type entities) */
  entityExpressId?: number;
  /** Model IDs this node belongs to */
  modelIds: string[];
  /** Owning model for a row representing one model; absent for cross-model groups. */
  modelId?: string;
  name: string;
  /**
   * Secondary descriptive label rendered muted after `name`, currently the IFC
   * `LongName` of a spatial node when it differs from the primary Name. Lets the
   * panel show an ISO 19650 code and its meaning together, e.g. "01" +
   * "Main Residence" (issue #1634). Undefined for rows with no distinct
   * secondary label.
   */
  secondaryName?: string;
  type: NodeType;
  /** Actual IFC class for element rows and type groups */
  ifcType?: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isVisible: boolean; // Note: For storeys, computed lazily during render for performance
  /**
   * The badge number. On a spatial node it is a count of PHYSICAL OBJECTS THAT
   * HAVE A SHAPE — see `objectCountSummary.ts` — not a count of the rows
   * underneath it, which also list annotations and shapeless elements.
   */
  elementCount?: number;
  /**
   * The breakdown behind `elementCount`, for the badge's hover card. Present
   * on spatial nodes only; rows whose badge counts something else (a class's
   * instances, a model's entities) leave it undefined and keep the plain
   * wording.
   */
  countSummary?: ObjectCountSummary;
  /**
   * The storey elevation badge, in metres, for DISPLAY only: the storey's
   * absolute height (world Z through the placement chain, or height above the
   * map datum when georeferenced), computed per model — see
   * `displayStoreyElevationMeters` (#4843). Never feed it back into grouping,
   * sorting, matching or placement, which use the relative
   * `spatialHierarchy.storeyElevations`.
   */
  storeyDisplayElevation?: number;
  /** Internal: ID offset for lazy visibility computation */
  _idOffset?: number;
  /**
   * For a decomposing assembly element (IfcElementAssembly, an IfcStair used as
   * a container, …): the federated global IDs of every `IfcRelAggregates`
   * descendant part. Present only when the element actually aggregates parts.
   * `globalIds[0]` stays the assembly itself (so tree selection + hidden-state
   * keep working); these parts carry the geometry and are used to highlight /
   * frame / isolate the whole assembly at once (issue #1133).
   */
  assemblyChildGlobalIds?: number[];
  /**
   * True when this row is a physical element that is known to have no shape
   * — its own Representation is `$` and, if it decomposes via
   * `IfcRelAggregates`, none of its parts has one either. Set only once
   * geometry is known (never during streaming, when absence is
   * unanswerable — see `makeShapeTest`'s `geometryKnown` gate). The row
   * renderer grays these out and the tree builders bucket them under an
   * "Other" node instead of dropping them (#4764); the headline object
   * count (`elementCount`) already excludes them via the shape test, so
   * this flag changes only how a row is *shown*, never what is *counted*.
   */
  noGeometry?: boolean;
}

/** Data for a storey from a single model */
export interface StoreyData {
  modelId: string;
  storeyId: number;
  name: string;
  /** Model-relative elevation (m): drives grouping, sorting and matching. */
  elevation: number;
  /** Absolute elevation (m) for the badge only (#4843). */
  displayElevation: number;
  /** Everything contained in the storey — what the tree lists. */
  elements: number[];
  /** The object count and its breakdown — what a badge may show. */
  objects: ObjectCountSummary;
}

/** Unified storey grouping storeys from multiple models */
export interface UnifiedStorey {
  key: string;  // Elevation-based key for matching
  name: string;
  /** Model-relative elevation (m) of the first contributor: grouping/sorting. */
  elevation: number;
  /**
   * Absolute elevation (m) for the badge (#4843), or undefined when the
   * contributing models disagree — each model row then shows its own.
   */
  displayElevation?: number;
  storeys: StoreyData[];
  /** Contained entities across every contributing model — rows, not objects. */
  totalElements: number;
  /** The object count and its breakdown, summed across contributing models. */
  objects: ObjectCountSummary;
}

/**
 * How the spatial browser orders storeys (and storey-like spatial parts).
 * Elevation keeps the building-section mental model; name is alphanumeric with
 * natural numeric ordering so "Level 2" sorts before "Level 10" (issue #1296).
 */
export type HierarchySortMode =
  | 'elevation-desc'  // highest storey first (default — top-down building stack)
  | 'elevation-asc'   // lowest storey first
  | 'name-asc'        // A to Z
  | 'name-desc';      // Z to A

export const HIERARCHY_SORT_MODES: readonly HierarchySortMode[] = [
  'elevation-desc',
  'elevation-asc',
  'name-asc',
  'name-desc',
];

export const DEFAULT_HIERARCHY_SORT: HierarchySortMode = 'elevation-desc';

// Spatial container types (all non-leaf spatial nodes) - these don't participate in storey filters.
const SPATIAL_CONTAINER_TYPES: Set<NodeType> = new Set([
  'IfcProject',
  'IfcSite',
  'IfcBuilding',
  'IfcFacility',
  'IfcBridge',
  'IfcRoad',
  'IfcRailway',
  'IfcMarineFacility',
  'IfcFacilityPart',
  'IfcBridgePart',
  'IfcRoadPart',
  'IfcRailwayPart',
  'IfcMarinePart',
  'IfcFacilityPartCommon',
]);
export const isSpatialContainer = (type: NodeType): boolean => SPATIAL_CONTAINER_TYPES.has(type);

/** Rows muted because they represent known geometry-less physical objects. */
export const isNoGeometryNode = (node: TreeNode): boolean =>
  node.noGeometry === true || node.type === 'other-group';
