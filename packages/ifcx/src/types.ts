/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC5 (IFCX) type definitions
 * Based on buildingSMART IFC5-development schema
 */

import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4,
  ENTITIES_IFC4X3,
  IfcTypeEnumToString,
  SPATIAL_STRUCTURE_TYPE_ENUMS,
} from '@ifc-lite/data';
import type { IfcEntityInfo } from '@ifc-lite/data';

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
  /**
   * Per-entity provenance carrier (`createdBy` / `createdAt` /
   * `lastEditedBy` / `lastEditedAt` / `previousPath`). IFCX nodes have
   * no provenance slot of their own, so without this key a snapshot
   * round trip loses whoever authored an entity — and the reader then
   * back-fills the FILE header's author and the read clock, which is
   * fabricated attribution wearing the shape of the real thing.
   *
   * Every field carried here is written once, when the entity is
   * created, and never re-stamped — `lastEditedBy` / `lastEditedAt`
   * included (only `promoteEntityType` writes them, on the new entity).
   * That is load-bearing, not incidental: a field re-stamped on each
   * edit would make this attribute change whenever anything else on the
   * entity does, putting it in every minimal layer and handing the merge
   * engine a component that conflicts on every concurrent edit. If a
   * per-edit stamp is ever wanted, give it its own key rather than
   * adding it here.
   */
  META: 'ifclite::meta',
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

/**
 * The IFC classes that are LEVELS of the spatial tree rather than contents of
 * one. `hierarchy-builder.ts` recurses into a child in this set and stops
 * collecting elements at one, so a class missing here is not merely absent
 * from the tree — it and everything beneath it are flattened into the
 * parent's element list.
 *
 * Derived from `@ifc-lite/data`'s `SPATIAL_STRUCTURE_TYPE_ENUMS`, this repo's
 * single answer to "is this entity part of the spatial tree", rather than
 * listed again here. The hand-written list this replaced named the five
 * building-storey levels and none of IFC4.3's twelve: `IfcSpatialZone` and
 * the facility classes (`IfcRoad`, `IfcBridge`, `IfcRailway`,
 * `IfcMarineFacility`, `IfcFacility` and their `*Part` counterparts), so an
 * infrastructure model's whole hierarchy collapsed onto its site.
 */
export const SPATIAL_TYPES: Set<string> = new Set(
  SPATIAL_STRUCTURE_TYPE_ENUMS.map((typeEnum) => IfcTypeEnumToString(typeEnum)),
);

/** `root` itself plus every descendant of it in one schema's entity table. */
function elementUniverse(entities: readonly IfcEntityInfo[], root: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entity of entities) {
    if (!entity.parent) continue;
    const siblings = children.get(entity.parent) ?? [];
    siblings.push(entity.name);
    children.set(entity.parent, siblings);
  }
  const out = new Set<string>([root]);
  const walk = (node: string): void => {
    for (const child of children.get(node) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The IFC classes recognized as physical building elements.
 *
 * Derived from `@ifc-lite/data`'s generated entity tables rather than
 * hand-listed: the 15-name hand list this replaced missed `IfcFooting`,
 * `IfcPile`, `IfcMember`, `IfcPlate`, `IfcShadingDevice`, `IfcChimney`,
 * `IfcStairFlight`, `IfcRampFlight` and the `*StandardCase` door/window
 * variants even for IFC4 alone, and wrongly included `IfcOpeningElement`
 * (a subtraction feature under `IfcFeatureElement`, not a building
 * element). It also could not have covered IFC4X3 correctly by adding more
 * names: IFC4X3 replaced the family root `IfcBuildingElement` with
 * `IfcBuiltElement`, adding a family of civil/infrastructure elements
 * (`IfcBearing`, `IfcCaissonFoundation`, `IfcCourse`, `IfcDeepFoundation`,
 * `IfcEarthworksFill`, `IfcKerb`, `IfcMooringDevice`,
 * `IfcNavigationElement`, `IfcPavement`, `IfcRail`, `IfcReinforcedSoil`,
 * `IfcTrackElement`) under the new name, so this walks both root names
 * across all three generated schemas (see `SPATIAL_TYPES` above for the
 * same fix applied to the neighboring hand-list gap).
 *
 * Each root is a member of its own family, not just the walk's starting
 * point. That matters for IFC4X3: `IfcBuildingElement` is abstract in
 * IFC2X3/IFC4, but its replacement `IfcBuiltElement` is concrete
 * (`abstract: false` in the generated IFC4X3 table), so a file may carry
 * an `IFCBUILTELEMENT` instance and dropping the root would classify it
 * as not a building element. The set carries abstract classes anyway
 * (`IfcBuildingElementComponent`, `IfcReinforcingElement`), so keeping the
 * roots is also what makes it a consistent family-membership test.
 */
export const BUILDING_ELEMENT_TYPES: Set<string> = new Set([
  ...elementUniverse(ENTITIES_IFC2X3, 'IfcBuildingElement'),
  ...elementUniverse(ENTITIES_IFC4, 'IfcBuildingElement'),
  ...elementUniverse(ENTITIES_IFC4X3, 'IfcBuiltElement'),
]);
