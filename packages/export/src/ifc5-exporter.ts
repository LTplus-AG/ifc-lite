/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC5 (IFCX) Exporter
 *
 * Converts an IfcDataStore (from IFC2X3/IFC4/IFC4X3 STEP files) to the
 * IFC5 IFCX JSON format with USD geometry.
 *
 * This performs full schema conversion:
 * - Entity type mapping to IFC5 (aligned with IFC4X3 naming)
 * - Properties converted to IFCX attribute namespaces
 * - Tessellated geometry converted to USD mesh format
 * - Spatial hierarchy mapped to IFCX path-based structure
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import {
  IfcTypeEnumToString,
  IfcTypeEnumFromString,
  type IfcTypeEnum,
  PropertyValueType,
} from '@ifc-lite/data';
import { convertEntityType, type IfcSchemaVersion } from './schema-converter.js';

/** Recursive spatial tree node type used when walking the hierarchy. */
interface SpatialTreeNode {
  expressId: number;
  name?: string;
  children: SpatialTreeNode[];
}

// ============================================================================
// Standard IFCX schema imports
// ============================================================================

/** Standard IFC5 schema package URIs, keyed by the attribute prefix they provide. */
const IFCX_SCHEMA_IMPORTS = {
  /** Core IFC: bsi::ifc::class, bsi::ifc::presentation::*, bsi::ifc::material, bsi::ifc::spaceBoundary */
  IFC_CORE: 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx',
  /** IFC properties: bsi::ifc::prop::* */
  IFC_PROP: 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx',
  /** OpenUSD geometry: usd::usdgeom::mesh, usd::xformop, usd::usdgeom::visibility */
  USD: 'https://ifcx.dev/@openusd.org/usd@v1.ifcx',
} as const;

/**
 * Property names that have official IFC5 schema definitions in prop@v5a.ifcx.
 * Source: https://github.com/buildingSMART/ifcx.dev/blob/main/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx
 *
 * IFC4 properties NOT in this set (e.g. Reference, LoadBearing, ExtendToStructure)
 * must be omitted from IFC5 export — the viewer reports "Missing schema" errors for them.
 *
 * Name and Description are handled separately (always exported), so they're excluded here.
 */
export const IFC5_KNOWN_PROP_NAMES = new Set([
  'UsageType',
  'TypeName',
  'IsExternal',
  'RefElevation',
  'ElevationOfRefHeight',
  'ElevationOfTerrain',
  'NumberOfStoreys',
  'Height',
  'Width',
  'Length',
  'Depth',
  'Volume',
  'NetVolume',
  'NetArea',
  'NetSideArea',
  'CrossSectionArea',
  'Station',
]);

// ============================================================================
// Types
// ============================================================================

/** Options for IFC5 export */
export interface Ifc5ExportOptions {
  /** Author name */
  author?: string;
  /** Data version identifier */
  dataVersion?: string;
  /** Include geometry as USD meshes (default: true) */
  includeGeometry?: boolean;
  /** Include properties (default: true) */
  includeProperties?: boolean;
  /** Apply mutations (default: true if mutation view provided) */
  applyMutations?: boolean;
  /** Pretty print JSON (default: true) */
  prettyPrint?: boolean;
  /** Only export visible entities */
  visibleOnly?: boolean;
  /** Hidden entity IDs (local expressIds) */
  hiddenEntityIds?: Set<number>;
  /** Isolated entity IDs (local expressIds, null = no isolation) */
  isolatedEntityIds?: Set<number> | null;
  /** Only export properties with known IFC5 schemas (default: true).
   *  When false, all IFC4 properties are exported even if they lack
   *  an official IFC5 schema definition (viewer may show warnings). */
  onlyKnownProperties?: boolean;
  /** Only export entities reachable from the spatial tree (default: true).
   *  When true, relationship entities (IfcRel*), type objects, materials,
   *  and other non-spatial entities are excluded from the output. */
  onlyTreeEntities?: boolean;
}

/** Result of IFC5 export */
export interface Ifc5ExportResult {
  /** IFCX JSON content */
  content: string;
  /** Statistics */
  stats: {
    nodeCount: number;
    propertyCount: number;
    meshCount: number;
    fileSize: number;
  };
}

/** IFCX file structure */
interface IfcxFileOutput {
  header: {
    id: string;
    ifcxVersion: string;
    dataVersion: string;
    author: string;
    timestamp: string;
  };
  imports: { uri: string }[];
  schemas: Record<string, unknown>;
  data: IfcxNodeOutput[];
}

/** IFCX node in output */
interface IfcxNodeOutput {
  path: string;
  children?: Record<string, string | null>;
  inherits?: Record<string, string | null>;
  attributes?: Record<string, unknown>;
}

// ============================================================================
// Exporter
// ============================================================================

/**
 * Exports IFC data (from any schema) to IFC5 IFCX JSON format.
 */
export class Ifc5Exporter {
  private dataStore: IfcDataStore;
  private mutationView: MutablePropertyView | null;
  private geometryResult: GeometryResult | null;
  private idOffset: number;
  /** Unique child name per entity (with _<id> suffix when siblings collide) */
  private childNames = new Map<number, string>();
  /** Real names from SpatialNode tree (reliable for spatial containers) */
  private spatialNodeNames = new Map<number, string>();
  /** Spatial container children (Project→Sites, Site→Buildings, etc.) */
  private spatialChildIds = new Map<number, number[]>();
  /** UUID path for each entity expressId */
  private entityUuids = new Map<number, string>();

  constructor(
    dataStore: IfcDataStore,
    geometryResult?: GeometryResult | null,
    mutationView?: MutablePropertyView,
    idOffset?: number,
  ) {
    this.dataStore = dataStore;
    this.geometryResult = geometryResult ?? null;
    this.mutationView = mutationView ?? null;
    this.idOffset = idOffset ?? 0;
  }

  /**
   * Export to IFCX JSON format
   */
  export(options: Ifc5ExportOptions = {}): Ifc5ExportResult {
    const sourceSchema = (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';

    // Build UUID paths and child-name maps from spatial hierarchy
    this.buildEntityMaps();

    // Build mesh lookup by expressId
    const meshByEntity = this.buildMeshLookup(options);

    // Build visible set
    const visibleIds = this.buildVisibleSet(options);

    // Build spatial tree set (entities reachable from the project node)
    const treeIds = options.onlyTreeEntities !== false ? this.buildTreeEntitySet() : null;

    // Collect nodes
    const nodes: IfcxNodeOutput[] = [];
    let propertyCount = 0;
    let meshCount = 0;

    const { entities, strings } = this.dataStore;

    // Find the project entity so we can create a root node pointing to it
    let projectExpressId: number | null = null;

    for (let i = 0; i < entities.count; i++) {
      const expressId = entities.expressId[i];

      // Visibility filter
      if (visibleIds && !visibleIds.has(expressId)) continue;

      // Spatial tree filter
      if (treeIds && !treeIds.has(expressId)) continue;

      const typeEnum = entities.typeEnum[i];
      const typeName = IfcTypeEnumToString(typeEnum as IfcTypeEnum) || 'IfcElement';

      // Convert entity type to IFC5 (aligned with IFC4X3)
      const ifc5Type = convertEntityType(
        typeName.toUpperCase(),
        sourceSchema,
        'IFC5',
      );
      // Convert back to PascalCase for IFCX
      const ifc5Class = stepTypeToClassName(ifc5Type);

      if (ifc5Class === 'IfcProject') {
        projectExpressId = expressId;
      }

      // Get UUID path for this entity
      const path = this.entityUuids.get(expressId) || generateUuid(expressId);

      // Build attributes
      const attributes: Record<string, unknown> = {};

      // IFC class (requires both code and uri per official schema)
      attributes['bsi::ifc::class'] = {
        code: ifc5Class,
        uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${ifc5Class}`,
      };

      // Name → bsi::ifc::prop::Name (IFC5 uses prop namespace, not bsi::ifc::name)
      const name = strings.get(entities.name[i])
        || this.spatialNodeNames.get(expressId);
      if (name) {
        attributes['bsi::ifc::prop::Name'] = name;
      }

      // Description → bsi::ifc::prop::Description
      const description = strings.get(entities.description[i]);
      if (description) {
        attributes['bsi::ifc::prop::Description'] = description;
      }

      // Properties
      if (options.includeProperties !== false) {
        const props = this.getPropertiesForEntity(expressId, options);
        for (const [key, value] of Object.entries(props)) {
          attributes[key] = value;
          propertyCount++;
        }
      }

      // Build node
      const node: IfcxNodeOutput = { path };

      // Children from spatial hierarchy
      const children = this.getChildrenForEntity(expressId);
      if (Object.keys(children).length > 0) {
        node.children = children;
      }

      // Geometry as USD mesh
      if (options.includeGeometry !== false) {
        const meshes = meshByEntity.get(expressId);
        if (meshes && meshes.length > 0) {
          const usdMesh = this.convertToUsdMesh(meshes);
          attributes['usd::usdgeom::mesh'] = usdMesh;

          // Color/presentation
          const [r, g, b, a] = meshes[0].color;
          attributes['bsi::ifc::presentation::diffuseColor'] = [r, g, b];
          if (a < 1.0) {
            attributes['bsi::ifc::presentation::opacity'] = a;
          }
          meshCount++;
        }
      }

      if (Object.keys(attributes).length > 0) {
        node.attributes = attributes;
      }

      nodes.push(node);
    }

    // Add a document root node that contains the project (IFCX convention)
    if (projectExpressId !== null) {
      const projectUuid = this.entityUuids.get(projectExpressId);
      if (projectUuid) {
        const projectName = this.childNames.get(projectExpressId)
          || strings.get(entities.name[this.findEntityIndex(projectExpressId)])
          || 'Project';
        const rootUuid = generateUuid(0);
        nodes.unshift({
          path: rootUuid,
          children: { [projectName]: projectUuid },
          attributes: {},
        });
      }
    }

    // Determine required imports by scanning which attribute namespaces are used
    const imports = collectRequiredImports(nodes);

    // Assemble IFCX file
    const file: IfcxFileOutput = {
      header: {
        id: `ifcx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        ifcxVersion: 'ifcx_alpha',
        dataVersion: options.dataVersion || '1.0.0',
        author: options.author || 'ifc-lite',
        timestamp: new Date().toISOString(),
      },
      imports,
      schemas: {},
      data: nodes,
    };

    const content = options.prettyPrint !== false
      ? JSON.stringify(file, null, 2)
      : JSON.stringify(file);

    return {
      content,
      stats: {
        nodeCount: nodes.length,
        propertyCount,
        meshCount,
        fileSize: new TextEncoder().encode(content).length,
      },
    };
  }

  /** Find the entity table index for a given expressId. */
  private findEntityIndex(expressId: number): number {
    const { entities } = this.dataStore;
    for (let i = 0; i < entities.count; i++) {
      if (entities.expressId[i] === expressId) return i;
    }
    return 0;
  }

  // --------------------------------------------------------------------------
  // Path building
  // --------------------------------------------------------------------------

  /**
   * Build UUID paths and child-name maps for all entities.
   *
   * IFCX uses flat UUID paths (not hierarchical). Hierarchy is expressed
   * solely via the `children` dict on each node. This method:
   * 1. Assigns a UUID to every entity (using GlobalId when available)
   * 2. Builds the spatial parent→children map
   * 3. Computes unique child names for the children dict keys
   */
  private buildEntityMaps(): void {
    const { spatialHierarchy, entities, strings } = this.dataStore;

    // --- 1. Assign UUID paths ---
    this.entityUuids.clear();
    for (let i = 0; i < entities.count; i++) {
      const id = entities.expressId[i];
      // Use IFC GlobalId if available, otherwise generate a deterministic UUID
      const globalId = strings.get(entities.globalId[i]);
      this.entityUuids.set(id, globalId || generateUuid(id));
    }

    // --- 2. Build parent→children and spatial maps ---
    const parentOf = new Map<number, number>();

    const processChildren = (parentId: number, childIds: Set<number> | number[] | undefined) => {
      if (!childIds) return;
      for (const childId of childIds) {
        parentOf.set(childId, parentId);
      }
    };

    this.spatialChildIds.clear();
    this.spatialNodeNames.clear();
    if (spatialHierarchy?.project) {
      const walkTree = (node: { expressId: number; name?: string; children: SpatialTreeNode[] }) => {
        if (node.name) {
          this.spatialNodeNames.set(node.expressId, node.name);
        }
        const childIds: number[] = [];
        for (const child of node.children) {
          parentOf.set(child.expressId, node.expressId);
          childIds.push(child.expressId);
          walkTree(child);
        }
        this.spatialChildIds.set(node.expressId, childIds);
      };
      walkTree(spatialHierarchy.project);
    }

    // Add element containment from flat maps
    if (spatialHierarchy) {
      for (const map of [spatialHierarchy.bySite, spatialHierarchy.byBuilding, spatialHierarchy.byStorey, spatialHierarchy.bySpace]) {
        if (map) {
          for (const [parentId, children] of map) {
            processChildren(parentId, children);
          }
        }
      }
    }

    // --- 3. Compute unique child names ---
    // Build entity name lookup
    const entityNameById = new Map<number, string>();
    for (let i = 0; i < entities.count; i++) {
      const id = entities.expressId[i];
      let name = strings.get(entities.name[i]) || '';
      if (!name) name = this.spatialNodeNames.get(id) || '';
      if (!name) {
        const typeName = IfcTypeEnumToString(entities.typeEnum[i] as IfcTypeEnum);
        if (typeName !== 'Unknown') name = typeName;
      }
      entityNameById.set(id, name);
    }

    // Group children by parent
    const childrenOf = new Map<number | undefined, number[]>();
    for (const [childId, parentId] of parentOf) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId)!.push(childId);
    }
    for (let i = 0; i < entities.count; i++) {
      const id = entities.expressId[i];
      if (!parentOf.has(id)) {
        if (!childrenOf.has(undefined)) childrenOf.set(undefined, []);
        childrenOf.get(undefined)!.push(id);
      }
    }

    // Compute unique child names: append _<expressId> on collision
    this.childNames.clear();
    for (const [, siblings] of childrenOf) {
      const nameCount = new Map<string, number>();
      for (const id of siblings) {
        const raw = entityNameById.get(id) || `e${id}`;
        const safe = raw.replace(/[/\\]/g, '_').replace(/\s+/g, '_');
        nameCount.set(safe, (nameCount.get(safe) || 0) + 1);
      }
      for (const id of siblings) {
        const raw = entityNameById.get(id) || `e${id}`;
        const safe = raw.replace(/[/\\]/g, '_').replace(/\s+/g, '_');
        this.childNames.set(id, nameCount.get(safe)! > 1 ? `${safe}_${id}` : safe);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  /**
   * Get properties for an entity, converted to IFCX attribute format.
   */
  private getPropertiesForEntity(
    entityId: number,
    options: Ifc5ExportOptions,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Prefer mutation view if available
    if (this.mutationView && options.applyMutations !== false) {
      const psets = this.mutationView.getForEntity(entityId);
      for (const pset of psets) {
        for (const prop of pset.properties) {
          if (options.onlyKnownProperties !== false && !IFC5_KNOWN_PROP_NAMES.has(prop.name)) continue;
          const key = `bsi::ifc::prop::${prop.name}`;
          result[key] = this.convertPropertyValue(prop.value, prop.type);
        }
      }
    } else if (this.dataStore.properties) {
      const psets = this.dataStore.properties.getForEntity(entityId);
      for (const pset of psets) {
        for (const prop of pset.properties) {
          if (options.onlyKnownProperties !== false && !IFC5_KNOWN_PROP_NAMES.has(prop.name)) continue;
          const key = `bsi::ifc::prop::${prop.name}`;
          result[key] = this.convertPropertyValue(prop.value, prop.type);
        }
      }
    }

    return result;
  }

  /**
   * Convert a property value to IFCX-compatible format.
   * IFCX uses native JSON types rather than IFC wrapped types.
   */
  private convertPropertyValue(value: unknown, type: PropertyValueType): unknown {
    if (value === null || value === undefined) return null;

    switch (type) {
      case PropertyValueType.Real:
        return Number(value);
      case PropertyValueType.Integer:
        return Math.round(Number(value));
      case PropertyValueType.Boolean:
      case PropertyValueType.Logical:
        return Boolean(value);
      default:
        return value;
    }
  }

  // --------------------------------------------------------------------------
  // Children
  // --------------------------------------------------------------------------

  /**
   * Get children for a spatial entity.
   * IFCX children format: { childName: childUuid }
   */
  private getChildrenForEntity(
    entityId: number,
  ): Record<string, string | null> {
    const children: Record<string, string | null> = {};

    const addChild = (childId: number) => {
      const childUuid = this.entityUuids.get(childId);
      if (!childUuid) return;
      const childName = this.childNames.get(childId) || `e${childId}`;
      children[childName] = childUuid;
    };

    // Spatial container children (Project→Sites, Site→Buildings, etc.)
    const spatialKids = this.spatialChildIds.get(entityId);
    if (spatialKids) {
      for (const childId of spatialKids) {
        addChild(childId);
      }
    }

    // Element children from containment maps
    const { spatialHierarchy } = this.dataStore;
    if (spatialHierarchy) {
      const childSets = [
        spatialHierarchy.bySite?.get(entityId),
        spatialHierarchy.byBuilding?.get(entityId),
        spatialHierarchy.byStorey?.get(entityId),
        spatialHierarchy.bySpace?.get(entityId),
      ];
      for (const childSet of childSets) {
        if (!childSet) continue;
        for (const childId of childSet) {
          addChild(childId);
        }
      }
    }

    return children;
  }

  // --------------------------------------------------------------------------
  // Geometry conversion
  // --------------------------------------------------------------------------

  /**
   * Build mesh lookup from GeometryResult, keyed by original expressId.
   */
  private buildMeshLookup(options: Ifc5ExportOptions): Map<number, MeshData[]> {
    const lookup = new Map<number, MeshData[]>();
    if (!this.geometryResult || options.includeGeometry === false) return lookup;

    for (const mesh of this.geometryResult.meshes) {
      // Convert global expressId back to original local expressId
      const localId = mesh.expressId - this.idOffset;
      const id = localId > 0 ? localId : mesh.expressId;

      if (!lookup.has(id)) {
        lookup.set(id, []);
      }
      lookup.get(id)!.push(mesh);
    }

    return lookup;
  }

  /**
   * Convert tessellated MeshData (Y-up) to USD mesh format (Z-up).
   * Merges multiple mesh fragments for the same entity.
   */
  private convertToUsdMesh(meshes: MeshData[]): {
    points: number[][];
    faceVertexIndices: number[];
  } {
    const allPoints: number[][] = [];
    const allIndices: number[] = [];
    let indexOffset = 0;

    for (const mesh of meshes) {
      // Convert positions from Y-up to Z-up
      // Y-up: X=right, Y=up, Z=back
      // Z-up: X=right, Y=forward, Z=up
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const x = mesh.positions[i];
        const y = mesh.positions[i + 1];   // Y-up Y = Z-up Z
        const z = mesh.positions[i + 2];   // Y-up Z = -Z-up Y
        allPoints.push([x, -z, y]);
      }

      // Offset indices for merged mesh
      for (let i = 0; i < mesh.indices.length; i += 3) {
        allIndices.push(
          mesh.indices[i] + indexOffset,
          mesh.indices[i + 1] + indexOffset,
          mesh.indices[i + 2] + indexOffset,
        );
      }

      indexOffset += mesh.positions.length / 3;
    }

    return {
      points: allPoints,
      faceVertexIndices: allIndices,
    };
  }

  // --------------------------------------------------------------------------
  // Visibility
  // --------------------------------------------------------------------------

  /**
   * Build the set of entity IDs reachable from the spatial tree.
   * Includes Project, Site, Building, Storey, Space, and all contained elements.
   */
  private buildTreeEntitySet(): Set<number> {
    const ids = new Set<number>();

    // Walk spatial hierarchy tree
    const { spatialHierarchy } = this.dataStore;
    if (spatialHierarchy?.project) {
      const walk = (node: { expressId: number; children: SpatialTreeNode[] }) => {
        ids.add(node.expressId);
        for (const child of node.children) walk(child);
      };
      walk(spatialHierarchy.project);
    }

    // Add elements from containment maps (elements assigned to storeys, etc.)
    if (spatialHierarchy) {
      for (const map of [spatialHierarchy.bySite, spatialHierarchy.byBuilding, spatialHierarchy.byStorey, spatialHierarchy.bySpace]) {
        if (map) {
          for (const children of map.values()) {
            for (const id of children) ids.add(id);
          }
        }
      }
    }

    return ids;
  }

  /**
   * Build visible entity set if visibility filtering is requested.
   */
  private buildVisibleSet(options: Ifc5ExportOptions): Set<number> | null {
    if (!options.visibleOnly) return null;

    const hidden = options.hiddenEntityIds ?? new Set<number>();
    const isolated = options.isolatedEntityIds ?? null;
    const visible = new Set<number>();

    const { entities } = this.dataStore;

    for (let i = 0; i < entities.count; i++) {
      const id = entities.expressId[i];
      if (isolated) {
        // When isolation is active, only isolated entities are visible
        if (isolated.has(id)) visible.add(id);
      } else {
        // Otherwise, everything except hidden is visible
        if (!hidden.has(id)) visible.add(id);
      }
    }

    return visible;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Scan data nodes and return the list of standard IFCX import URIs needed
 * for the attribute namespaces actually used.
 */
function collectRequiredImports(nodes: IfcxNodeOutput[]): { uri: string }[] {
  let needsIfcCore = false;
  let needsIfcProp = false;
  let needsUsd = false;

  for (const node of nodes) {
    if (!node.attributes) continue;
    for (const key of Object.keys(node.attributes)) {
      // IFC core schemas: class, presentation, material, spaceBoundary
      if (!needsIfcCore && (
        key === 'bsi::ifc::class' ||
        key.startsWith('bsi::ifc::presentation::') ||
        key === 'bsi::ifc::material' ||
        key === 'bsi::ifc::spaceBoundary'
      )) {
        needsIfcCore = true;
      }
      // IFC property schemas: bsi::ifc::prop::*
      if (!needsIfcProp && key.startsWith('bsi::ifc::prop::')) {
        needsIfcProp = true;
      }
      // USD schemas: usd::*
      if (!needsUsd && key.startsWith('usd::')) {
        needsUsd = true;
      }
      if (needsIfcCore && needsIfcProp && needsUsd) break;
    }
    if (needsIfcCore && needsIfcProp && needsUsd) break;
  }

  const imports: { uri: string }[] = [];
  if (needsIfcCore) imports.push({ uri: IFCX_SCHEMA_IMPORTS.IFC_CORE });
  if (needsIfcProp) imports.push({ uri: IFCX_SCHEMA_IMPORTS.IFC_PROP });
  if (needsUsd) imports.push({ uri: IFCX_SCHEMA_IMPORTS.USD });
  return imports;
}

/**
 * Generate a deterministic UUID-like string from an expressId.
 * Format: 8-4-4-4-12 hex chars (UUID v4-like but deterministic).
 */
function generateUuid(id: number): string {
  const hex = id.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Convert STEP uppercase type name (e.g. "IFCWALL") to PascalCase class name (e.g. "IfcWall").
 * Uses the IFC type enum lookup for canonical casing (e.g. "IfcRelAggregates", not "Ifcrelaggregates").
 */
function stepTypeToClassName(stepType: string): string {
  const enumVal = IfcTypeEnumFromString(stepType);
  const name = IfcTypeEnumToString(enumVal);
  if (name !== 'Unknown') return name;
  // Fallback for types not in the enum: simple prefix normalisation
  const lower = stepType.toLowerCase();
  if (lower.startsWith('ifc')) {
    return 'Ifc' + lower.charAt(3).toUpperCase() + lower.slice(4);
  }
  return stepType;
}
