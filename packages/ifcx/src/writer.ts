/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX (IFC5 JSON) file writer
 *
 * Exports IFC data to IFCX JSON format.
 */

import type { IfcxFile, IfcxNode, IfcxHeader } from './types.js';
import type { EntityTable, PropertyTable, PropertySet, SpatialHierarchy } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { IFCX_VERSION } from '@ifc-lite/data';
import { collectRequiredImports } from './writer-imports.js';
import { writerEntities } from './writer-entities.js';

/**
 * Options for IFCX export
 */
export interface IfcxExportOptions {
  /** Author name */
  author?: string;
  /** Data version identifier */
  dataVersion?: string;
  /** Include properties (default: true) */
  includeProperties?: boolean;
  /** Include geometry (default: false - geometry export not yet supported) */
  includeGeometry?: boolean;
  /** Pretty print JSON (default: true) */
  prettyPrint?: boolean;
  /** Apply mutations (default: true if mutation view provided) */
  applyMutations?: boolean;
}

/**
 * Data sources for IFCX export
 */
export interface IfcxExportData {
  /** Entity table */
  entities: EntityTable;
  /** Property table (optional if using mutation view) */
  properties?: PropertyTable;
  /** Spatial hierarchy */
  spatialHierarchy?: SpatialHierarchy;
  /** String table for lookups */
  strings?: { get(idx: number): string };
  /** Optional mutation view for property changes */
  mutationView?: MutablePropertyView;
  /** ID to path mapping (for round-trip scenarios) */
  idToPath?: Map<number, string>;
}

/**
 * Result of IFCX export
 */
export interface IfcxExportResult {
  /** JSON string content */
  content: string;
  /** Statistics */
  stats: {
    nodeCount: number;
    propertyCount: number;
    fileSize: number;
  };
}

/**
 * IFCX file writer
 */
export class IfcxWriter {
  private data: IfcxExportData;

  constructor(data: IfcxExportData) {
    this.data = data;
  }

  /**
   * Export to IFCX format
   */
  export(options: IfcxExportOptions = {}): IfcxExportResult {
    const header = this.createHeader(options);
    const nodes = this.collectNodes(options);

    const file: IfcxFile = {
      header,
      imports: collectRequiredImports(nodes),
      schemas: {},
      data: nodes,
    };

    const content = options.prettyPrint !== false
      ? JSON.stringify(file, null, 2)
      : JSON.stringify(file);

    let propertyCount = 0;
    for (const node of nodes) {
      if (node.attributes) {
        propertyCount += Object.keys(node.attributes).length;
      }
    }

    return {
      content,
      stats: {
        nodeCount: nodes.length,
        propertyCount,
        fileSize: new TextEncoder().encode(content).length,
      },
    };
  }

  /**
   * Create IFCX header
   */
  private createHeader(options: IfcxExportOptions): IfcxHeader {
    return {
      id: this.generateId(),
      ifcxVersion: IFCX_VERSION,
      dataVersion: options.dataVersion || '1.0.0',
      author: options.author || 'ifc-lite',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Collect all nodes for export
   */
  private collectNodes(options: IfcxExportOptions): IfcxNode[] {
    const nodes: IfcxNode[] = [];
    const { spatialHierarchy, mutationView, idToPath } = this.data;
    const rows = writerEntities(this.data, options.applyMutations !== false);

    // Single source of truth for expressId -> path, built once up front so that
    // an entity's own path and any *reference* to that entity as a child
    // (see getChildrenForEntity) can never diverge. Previously the child-ref
    // path was synthesized independently as `element:${childId}`, which does
    // not match `ifc:${typeName}.${expressId}` produced by generatePath() and
    // left every exported child reference dangling whenever idToPath was not
    // supplied (i.e. every plain STEP-IFC -> IFCX export).
    //
    // Seed from idToPath first: on a round-trip it may know the authoritative
    // path of an id that has no row in this file's entity table at all (e.g.
    // a node referenced only as someone else's child). Those entries must
    // survive even though the entity loop below never visits that id.
    const resolvedPaths = new Map<number, string>(idToPath ?? []);
    if (options.applyMutations !== false && mutationView && typeof mutationView.isDeleted === 'function') {
      for (const id of resolvedPaths.keys()) if (mutationView.isDeleted(id)) resolvedPaths.delete(id);
    }
    for (const row of rows) {
      const { expressId } = row;
      resolvedPaths.set(
        expressId,
        idToPath?.get(expressId)
          ?? this.generatePath(expressId, row.typeName, row.globalId)
      );
    }

    // Process the effective entity set, including authored nodes.
    for (const row of rows) {
      const { expressId } = row;

      // Get or generate path
      // The map above has a row for every entity, so the fallback is
      // unreachable — but it must derive the path the same way regardless, or
      // an entity's own path and every reference to it could disagree.
      const path = resolvedPaths.get(expressId)
        ?? this.generatePath(expressId, row.typeName, row.globalId);

      // Build attributes
      const attributes: Record<string, unknown> = {};

      // Add IFC class (requires both code and uri per official schema)
      const typeName = row.typeName;
      if (typeName) {
        attributes['bsi::ifc::class'] = {
          code: typeName,
          uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${typeName}`,
        };
      }

      // IFC5 uses bsi::ifc::prop:: namespace for name/description (not bsi::ifc::name)
      if (row.name) {
        attributes['bsi::ifc::prop::Name'] = row.name;
      }

      if (row.description) {
        attributes['bsi::ifc::prop::Description'] = row.description;
      }

      // Add properties if requested
      if (options.includeProperties !== false) {
        const props = this.getPropertiesForEntity(expressId, options);
        for (const [key, value] of Object.entries(props)) {
          attributes[key] = value;
        }
      }

      const node: IfcxNode = {
        path,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      };

      // Add children based on spatial hierarchy
      const children = this.getChildrenForEntity(expressId, spatialHierarchy, resolvedPaths);
      if (Object.keys(children).length > 0) {
        node.children = children;
      }

      nodes.push(node);
    }

    return nodes;
  }

  /**
   * Get properties for an entity
   */
  private getPropertiesForEntity(
    entityId: number,
    options: IfcxExportOptions
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const { mutationView, properties } = this.data;

    // Get properties from mutation view if available and applying mutations
    if (mutationView && options.applyMutations !== false) {
      const psets = mutationView.getForEntity(entityId);
      for (const pset of psets) {
        for (const prop of pset.properties) {
          const key = `user::${pset.name}::${prop.name}`;
          result[key] = prop.value;
        }
      }
    } else if (properties) {
      // Get properties from table
      const psets = properties.getForEntity(entityId);
      for (const pset of psets) {
        for (const prop of pset.properties) {
          const key = `user::${pset.name}::${prop.name}`;
          result[key] = prop.value;
        }
      }
    }

    return result;
  }

  /**
   * Get children relationships for an entity
   */
  private getChildrenForEntity(
    entityId: number,
    spatialHierarchy: SpatialHierarchy | undefined,
    resolvedPaths: Map<number, string>
  ): Record<string, string | null> {
    const children: Record<string, string | null> = {};

    if (!spatialHierarchy) return children;

    // Check if this entity has contained elements
    const containedElements = spatialHierarchy.byStorey.get(entityId) ||
                              spatialHierarchy.byBuilding.get(entityId) ||
                              spatialHierarchy.bySite.get(entityId) ||
                              spatialHierarchy.bySpace.get(entityId);

    if (containedElements) {
      for (const childId of containedElements) {
        // Resolve from the same expressId -> path map used to assign the
        // child's own node path, so a child reference can never point at a
        // path no node in this file actually has. If the child id has no
        // corresponding entity row (e.g. a dangling relationship in the
        // source data), skip it rather than emit an unresolvable reference.
        const childPath = resolvedPaths.get(childId);
        if (childPath === undefined) continue;
        // key = relationship/child name, value = child path
        // (IFCX children = Record<name, path>; null is reserved for removals)
        children[`element_${childId}`] = childPath;
      }
    }

    return children;
  }

  /**
   * Generate path for an entity.
   *
   * A node's `path` IS the entity's identity in IFCX: the reader hands it
   * straight back as the GlobalId (`entity-extractor.ts`: "Use path as
   * GlobalId"), the sibling IFC5 exporter keys nodes by GlobalId for that
   * reason, and the buildingSMART v5a schemas committed under
   * `packages/export/src/__fixtures__/schemas/` define no attribute that could
   * carry a GlobalId instead — there is no other slot for it.
   *
   * So synthesizing `ifc:<Type>.<expressId>` for an entity that HAS a
   * GlobalId did not merely pick a different name: it discarded the real IFC
   * identity on the way through and invented one in its place, and expressId
   * is not stable across files, so nothing downstream could federate or
   * re-match the node. The synthetic form remains the fallback for an entity
   * with no GlobalId (and an explicit `idToPath` entry still wins over both,
   * so a round-trip keeps the paths the source file authored).
   */
  private generatePath(expressId: number, typeName: string | undefined, globalId?: string): string {
    if (globalId) return globalId;
    return `ifc:${typeName ?? 'IfcElement'}.${expressId}`;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `ifcx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

/**
 * Quick export function for simple use cases
 */
export function exportToIfcx(
  data: IfcxExportData,
  options?: IfcxExportOptions
): string {
  const writer = new IfcxWriter(data);
  const result = writer.export(options);
  return result.content;
}
