/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
  | 'IfcSpace'            // Space node (net room area)
  | 'IfcSpatialZone'      // Spatial zone node (modelled gross area / GFA)
  | 'type-group'          // IFC class grouping header (e.g., "IfcWall (47)")
  | 'ifc-type'            // IFC type entity node (e.g., "IfcWallType/W01")
  | 'material-group'      // Material grouping (e.g., "Concrete (47)") from the Materials tab
  | 'element';            // Individual element

export interface TreeNode {
  id: string;  // Unique ID for the node (can be composite)
  /** Local express IDs this node represents */
  expressIds: number[];
  /** Federated global IDs for selection/visibility operations */
  globalIds: number[];
  /** Structured entity expressId for selectable non-element nodes (for example IFC type entities) */
  entityExpressId?: number;
  /** Model IDs this node belongs to */
  modelIds: string[];
  name: string;
  type: NodeType;
  /** Actual IFC class for element rows and type groups */
  ifcType?: string;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isVisible: boolean; // Note: For storeys, computed lazily during render for performance
  elementCount?: number;
  storeyElevation?: number;
  /** Internal: ID offset for lazy visibility computation */
  _idOffset?: number;
}

/** Data for a storey from a single model */
export interface StoreyData {
  modelId: string;
  storeyId: number;
  name: string;
  elevation: number;
  elements: number[];
}

/** Unified storey grouping storeys from multiple models */
export interface UnifiedStorey {
  key: string;  // Elevation-based key for matching
  name: string;
  elevation: number;
  storeys: StoreyData[];
  totalElements: number;
}

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
]);
export const isSpatialContainer = (type: NodeType): boolean => SPATIAL_CONTAINER_TYPES.has(type);
