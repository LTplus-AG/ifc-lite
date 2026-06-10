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
} as const;

// ============================================================================
// IFClite Layer Extension Namespace (`ifclite::`)
// ============================================================================

/**
 * IFClite extension attributes for layered change tracking
 * (docs/architecture/layer-prs/). Tools unaware of the namespace ignore
 * these and still get valid IFCX composition (modulo deletion overlays,
 * which `bakeLayers` can materialize away for foreign tools).
 */
export const IFCLITE_ATTR = {
  /**
   * Tombstone opinion: `true` deletes the entity (and shadows all weaker
   * opinions for the path, including child paths); `false` resurrects it.
   */
  DELETED: 'ifclite::deleted',
  /** Marks derived (cache) content excluded from canonical hashing. */
  DERIVED: 'ifclite::derived',
  /**
   * Collab structured-branch carriers (#1031): the collab runtime keeps
   * classifications / materials / geometry refs as dedicated CRDT
   * branches; on the IFCX wire they travel as ordinary attributes under
   * these keys (psets/quantities use the `bsi::ifc::v5a::<Set>::<Name>`
   * convention instead, so merge component keys stay `pset:`/`qset:`).
   */
  CLASSIFICATIONS: 'ifclite::classifications',
  MATERIALS: 'ifclite::materials',
  GEOMETRY_REF: 'ifclite::geometryRef',
} as const;

/** Header key carrying the provenance manifest (see provenance.ts). */
export const PROVENANCE_KEY = 'ifclite::provenance';

/**
 * IFC5-alpha namespaced property/quantity prefix (#1031): keys are
 * `bsi::ifc::v5a::<Set>::<Name>`. Within this namespace the routing
 * dialect is fixed (see `routesToQuantityTable` and the collab
 * structured-branch inflation): `Pset_*` members are properties, `Qto_*`
 * members are quantities, custom sets route typed records to properties
 * and raw numbers to quantities.
 */
export const V5A_ATTR_PREFIX = 'bsi::ifc::v5a::';

/** Split a v5a key into set + member name; null when not a v5a set key. */
export function parseV5aKey(key: string): { setName: string; name: string } | null {
  if (!key.startsWith(V5A_ATTR_PREFIX)) return null;
  const rest = key.slice(V5A_ATTR_PREFIX.length);
  const sep = rest.indexOf('::');
  if (sep <= 0 || sep >= rest.length - 2) return null;
  return { setName: rest.slice(0, sep), name: rest.slice(sep + 2) };
}

/**
 * Canonical wire shape for typed property values (#1031): pset
 * properties under `bsi::ifc::v5a::<Set>::<Prop>` carry this record so
 * the IFC type, unit, and provenance survive round-trips. Every writer
 * (collab snapshots, MCP draft ops) and reader (property extraction,
 * seed inflation) shares this one definition.
 */
export interface TypedPropertyValue {
  type: string;
  value: string | number | boolean | null;
  unit?: string;
  source?: string;
}

const TYPED_PROPERTY_KEYS = new Set(['type', 'value', 'unit', 'source']);

/**
 * Strict shape test for TypedPropertyValue. Deliberately rejects any
 * extra keys: legacy/migrated attributes carry raw scalars or foreign
 * objects, never this exact record, so the test is what disambiguates
 * "typed property" from "leave it alone".
 */
export function isTypedPropertyValue(value: unknown): value is TypedPropertyValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string') return false;
  if (!('value' in record)) return false;
  const v = record.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
    return false;
  }
  for (const key of Object.keys(record)) {
    if (!TYPED_PROPERTY_KEYS.has(key)) return false;
  }
  if ('unit' in record && record.unit !== undefined && typeof record.unit !== 'string') return false;
  if ('source' in record && record.source !== undefined && typeof record.source !== 'string') return false;
  return true;
}

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
