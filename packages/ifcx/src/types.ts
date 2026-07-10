/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC5 (IFCX) type definitions
 * Based on buildingSMART IFC5-development schema
 */

// ============================================================================
// Core IFCX File Structure
// ============================================================================

export interface IfcxFile {
  header: IfcxHeader;
  imports: ImportNode[];
  schemas: Record<string, IfcxSchema>;
  data: IfcxNode[];
}

export interface IfcxHeader {
  id: string;
  ifcxVersion: string;
  dataVersion: string;
  author: string;
  timestamp: string;
}

export interface ImportNode {
  uri: string;
  integrity?: string;
}

export interface IfcxNode {
  path: string;
  children?: Record<string, string | null>;
  inherits?: Record<string, string | null>;
  attributes?: Record<string, unknown>;
}

// ============================================================================
// Schema Definitions
// ============================================================================

export type DataType =
  | 'Real'
  | 'Boolean'
  | 'Integer'
  | 'String'
  | 'DateTime'
  | 'Enum'
  | 'Array'
  | 'Object'
  | 'Reference'
  | 'Blob';

export interface EnumRestrictions {
  options: string[];
}

export interface ArrayRestrictions {
  min?: number;
  max?: number;
  value: IfcxValueDescription;
}

export interface ObjectRestrictions {
  values: Record<string, IfcxValueDescription>;
}

export interface IfcxValueDescription {
  dataType: DataType;
  optional?: boolean;
  inherits?: string[];
  quantityKind?: string;
  enumRestrictions?: EnumRestrictions;
  arrayRestrictions?: ArrayRestrictions;
  objectRestrictions?: ObjectRestrictions;
}

export interface IfcxSchema {
  uri?: string;
  value: IfcxValueDescription;
}

// ============================================================================
// Composed Node (Post-processing)
// ============================================================================

export interface ComposedNode {
  path: string;
  attributes: Map<string, unknown>;
  children: Map<string, ComposedNode>;
}

// ============================================================================
// Attribute Namespace Constants
// ============================================================================

/**
 * Well-known attribute namespaces used in IFCX files.
 * These are considered stable and safe to implement.
 */
export const ATTR = {
  // IFC Classification (stable)
  CLASS: 'bsi::ifc::class',

  // USD Geometry (stable - from OpenUSD standard)
  MESH: 'usd::usdgeom::mesh',
  TRANSFORM: 'usd::xformop',
  VISIBILITY: 'usd::usdgeom::visibility',

  // IFC Presentation (stable)
  DIFFUSE_COLOR: 'bsi::ifc::presentation::diffuseColor',
  OPACITY: 'bsi::ifc::presentation::opacity',

  // IFC Materials (likely stable)
  MATERIAL: 'bsi::ifc::material',

  // IFC Properties (stable pattern, specific props may vary)
  PROP_PREFIX: 'bsi::ifc::prop::',

  // IFC Relationships (evolving)
  SPACE_BOUNDARY: 'bsi::ifc::spaceBoundary',

  // IFC5 system membership (bsi::ifc::system schema): sits on the MEMBER
  // node as `[{ ref }]` pointing at the IfcSystem-family node — the ECS
  // successor of IfcRelAssignsToGroup (see the buildingSMART
  // Domestic_Hot_Water sample).
  PART_OF_SYSTEM: 'bsi::ifc::system::partofsystem',
} as const;

// ============================================================================
// USD Geometry Types
// ============================================================================

export interface UsdMesh {
  points: number[][];           // [[x,y,z], ...]
  faceVertexIndices: number[];  // Triangle indices
  faceVertexCounts?: number[];  // Face vertex counts (for non-triangle faces)
  normals?: number[][];         // Optional normals
}

export interface UsdTransform {
  transform: number[][];        // 4x4 matrix, row-major
}

// ============================================================================
// IFC Classification
// ============================================================================

export interface IfcClass {
  code: string;   // "IfcWall"
  uri: string;    // "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/IfcWall"
}

// ============================================================================
// Spatial Types
// ============================================================================

export const SPATIAL_TYPES = new Set([
  'IfcProject',
  'IfcSite',
  'IfcBuilding',
  'IfcBuildingStorey',
  'IfcSpace',
]);

export const BUILDING_ELEMENT_TYPES = new Set([
  'IfcWall',
  'IfcWallStandardCase',
  'IfcDoor',
  'IfcWindow',
  'IfcSlab',
  'IfcColumn',
  'IfcBeam',
  'IfcStair',
  'IfcRamp',
  'IfcRoof',
  'IfcCovering',
  'IfcCurtainWall',
  'IfcRailing',
  'IfcOpeningElement',
  'IfcBuildingElementProxy',
]);
