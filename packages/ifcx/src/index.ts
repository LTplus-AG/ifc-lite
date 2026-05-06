/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/ifcx - IFC5 (IFCX) parser
 *
 * Parses IFCX (JSON-based IFC5) files into data structures compatible
 * with the existing ifc-lite pipeline.
 */

import type { IfcxFile, ComposedNode } from './types.js';
import { composeIfcx, findRoots } from './composition.js';
import { extractEntities } from './entity-extractor.js';
import { extractProperties, isQuantityProperty } from './property-extractor.js';
import { extractGeometry, type MeshData } from './geometry-extractor.js';
import { extractPointClouds, type PointCloudExtraction } from './pointcloud-extractor.js';
import { buildHierarchy } from './hierarchy-builder.js';
import {
  StringTable,
  RelationshipGraphBuilder,
  RelationshipType,
  QuantityTableBuilder,
} from '@ifc-lite/data';
import type { SpatialHierarchy, EntityTable, PropertyTable, QuantityTable, RelationshipGraph } from '@ifc-lite/data';

// Federated composition imports
import { LayerStack, createLayerStack, type IfcxLayer, type LayerSource } from './layer-stack.js';
import { PathIndex, createPathIndex, parsePath, type ParsedPath, type PathEntry } from './path-resolver.js';
import {
  composeFederated,
  type ComposeOptions,
  type FederatedCompositionResult,
  type ComposedNodeWithSources,
} from './federated-composition.js';

// Re-export types
export * from './types.js';
export { composeIfcx, findRoots, getDescendants } from './composition.js';
export { extractEntities } from './entity-extractor.js';
export { extractProperties, isQuantityProperty } from './property-extractor.js';
export { extractGeometry, type MeshData } from './geometry-extractor.js';
export {
  extractPointClouds,
  type PointCloudExtraction,
} from './pointcloud-extractor.js';
export { buildHierarchy } from './hierarchy-builder.js';
export {
  findTraversalRoots,
  findTraversalSeeds,
  walkComposedFrames,
  getFrameLineage,
  getNodeLineage,
  collectIncomingEdgeNames,
  buildReachableAttributeIndex,
  type TraversalFrame,
} from './traversal.js';

// Re-export federated composition
export {
  LayerStack,
  createLayerStack,
  type IfcxLayer,
  type LayerSource,
} from './layer-stack.js';
export {
  PathIndex,
  createPathIndex,
  parsePath,
  type ParsedPath,
  type PathEntry,
} from './path-resolver.js';
export {
  composeFederated,
  type ComposeOptions,
  type FederatedCompositionResult,
  type ComposedNodeWithSources,
} from './federated-composition.js';

// IFCX writer for export
export {
  IfcxWriter,
  exportToIfcx,
  type IfcxExportOptions,
  type IfcxExportData,
  type IfcxExportResult,
} from './writer.js';

/**
 * Result of parsing an IFCX file.
 * Compatible with existing ifc-lite data structures.
 */
export interface IfcxParseResult {
  /** Columnar entity table */
  entities: EntityTable;
  /** Columnar property table */
  properties: PropertyTable;
  /** Columnar quantity table */
  quantities: QuantityTable;
  /** Relationship graph */
  relationships: RelationshipGraph;
  /** Spatial hierarchy */
  spatialHierarchy: SpatialHierarchy;
  /** String table for interned strings */
  strings: StringTable;
  /** Pre-tessellated geometry meshes */
  meshes: MeshData[];
  /** Decoded point clouds (pcd::base64, points::array, points::base64) */
  pointClouds: PointCloudExtraction[];
  /** Mapping from IFCX path to express ID */
  pathToId: Map<string, number>;
  /** Mapping from express ID to IFCX path */
  idToPath: Map<number, string>;
  /** Schema version */
  schemaVersion: 'IFC5';
  /** File size in bytes */
  fileSize: number;
  /** Number of entities */
  entityCount: number;
  /** Parse time in milliseconds */
  parseTime: number;
}

export interface IfcxParseOptions {
  /** Progress callback */
  onProgress?: (progress: { phase: string; percent: number }) => void;
}

/**
 * Parse an IFCX file and return data compatible with existing ifc-lite pipeline.
 */
export async function parseIfcx(
  buffer: ArrayBuffer,
  options: IfcxParseOptions = {}
): Promise<IfcxParseResult> {
  const startTime = performance.now();

  // Phase 1: Parse JSON
  options.onProgress?.({ phase: 'parse', percent: 0 });
  const text = new TextDecoder().decode(buffer);
  let file: IfcxFile;

  try {
    file = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid IFCX file: JSON parse error - ${e}`);
  }

  // Validate header
  if (!file.header?.ifcxVersion?.toLowerCase().includes('ifcx')) {
    throw new Error('Invalid IFCX file: missing or invalid header.ifcxVersion');
  }

  options.onProgress?.({ phase: 'parse', percent: 100 });

  // Phase 2: Compose ECS nodes
  options.onProgress?.({ phase: 'compose', percent: 0 });
  const composed = composeIfcx(file);
  options.onProgress?.({ phase: 'compose', percent: 100 });

  // Phase 3: Extract entities
  options.onProgress?.({ phase: 'entities', percent: 0 });
  const strings = new StringTable();
  const { entities, pathToId, idToPath } = extractEntities(composed, strings);
  options.onProgress?.({ phase: 'entities', percent: 100 });

  // Phase 4: Extract properties
  options.onProgress?.({ phase: 'properties', percent: 0 });
  const properties = extractProperties(composed, pathToId, strings);
  options.onProgress?.({ phase: 'properties', percent: 100 });

  // Phase 5: Extract geometry
  options.onProgress?.({ phase: 'geometry', percent: 0 });
  const meshes = extractGeometry(composed, pathToId);
  const pointClouds = extractPointClouds(composed, pathToId);
  options.onProgress?.({ phase: 'geometry', percent: 100 });

  // Phase 6: Build hierarchy
  options.onProgress?.({ phase: 'hierarchy', percent: 0 });
  const spatialHierarchy = buildHierarchy(composed, pathToId);
  options.onProgress?.({ phase: 'hierarchy', percent: 100 });

  // Phase 7: Build relationships
  options.onProgress?.({ phase: 'relationships', percent: 0 });
  const relationships = buildRelationships(composed, pathToId);
  options.onProgress?.({ phase: 'relationships', percent: 100 });

  // Phase 8: Build quantities (from properties that look like quantities)
  const quantities = buildQuantities(composed, pathToId, strings);

  const parseTime = performance.now() - startTime;

  return {
    entities,
    properties,
    quantities,
    relationships,
    spatialHierarchy,
    strings,
    meshes,
    pointClouds,
    pathToId,
    idToPath,
    schemaVersion: 'IFC5',
    fileSize: buffer.byteLength,
    entityCount: entities.count,
    parseTime,
  };
}

/**
 * Build relationship graph from composed nodes.
 * In IFCX, relationships are implicit in the children structure.
 */
function buildRelationships(
  composed: Map<string, ComposedNode>,
  pathToId: Map<string, number>
): RelationshipGraph {
  const builder = new RelationshipGraphBuilder();
  let relId = 1;

  for (const node of composed.values()) {
    const parentId = pathToId.get(node.path);
    if (parentId === undefined) continue;

    for (const child of node.children.values()) {
      const childId = pathToId.get(child.path);
      if (childId !== undefined) {
        // Determine relationship type based on node types
        const relType = determineRelationshipType(node, child);
        builder.addEdge(parentId, childId, relType, relId++);
      }
    }
  }

  return builder.build();
}

/**
 * Determine relationship type based on parent and child node types.
 */
function determineRelationshipType(
  parent: ComposedNode,
  child: ComposedNode
): RelationshipType {
  const parentClass = (parent.attributes.get('bsi::ifc::class') as { code?: string })?.code;
  const childClass = (child.attributes.get('bsi::ifc::class') as { code?: string })?.code;

  // Spatial containment
  if (isSpatialElement(parentClass) && !isSpatialElement(childClass)) {
    return RelationshipType.ContainsElements;
  }

  // Aggregation (spatial structure hierarchy)
  if (isSpatialElement(parentClass) && isSpatialElement(childClass)) {
    return RelationshipType.Aggregates;
  }

  // Default to containment
  return RelationshipType.ContainsElements;
}

function isSpatialElement(typeCode: string | undefined): boolean {
  if (!typeCode) return false;
  const spatialTypes = ['IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace'];
  return spatialTypes.includes(typeCode);
}

/**
 * Build quantity table from properties that appear to be quantities.
 * Uses the isQuantityProperty helper to identify quantity-like properties.
 */
function buildQuantities(
  composed: Map<string, ComposedNode>,
  pathToId: Map<string, number>,
  strings: StringTable
): QuantityTable {
  const builder = new QuantityTableBuilder(strings);

  // Map property names to quantity types
  const getQuantityType = (propName: string): number => {
    // Volume types
    if (propName === 'Volume' || propName.endsWith('Volume')) return 2; // QuantityType.Volume
    // Area types
    if (propName === 'Area' || propName.endsWith('Area')) return 1; // QuantityType.Area
    // Count types
    if (propName === 'Count' || propName.endsWith('Count')) return 3; // QuantityType.Count
    // Weight types
    if (propName === 'Weight' || propName === 'Mass' ||
        propName.endsWith('Weight') || propName.endsWith('Mass')) return 4; // QuantityType.Weight
    // Default to length for dimension-like quantities
    return 0; // QuantityType.Length
  };

  for (const node of composed.values()) {
    const expressId = pathToId.get(node.path);
    if (expressId === undefined) continue;

    // Get the IFC class to use as context for qset naming
    const ifcClass = (node.attributes.get('bsi::ifc::class') as { code?: string })?.code;
    const qsetName = ifcClass ? `Qto_${ifcClass.replace('Ifc', '')}BaseQuantities` : 'BaseQuantities';

    for (const [key, value] of node.attributes) {
      // Check if this looks like a quantity
      const propName = key.split('::').pop() ?? '';

      if (typeof value === 'number' && isQuantityProperty(propName)) {
        builder.add({
          entityId: expressId,
          qsetName,
          quantityName: propName,
          quantityType: getQuantityType(propName),
          value,
        });
      }
    }
  }

  return builder.build();
}

/**
 * Detect if a buffer contains IFCX (JSON), IFC (STEP), or GLB (binary glTF) format.
 */
export function detectFormat(buffer: ArrayBuffer): 'ifcx' | 'ifc' | 'glb' | 'unknown' {
  // Check GLB magic bytes first (binary format, 4-byte magic: 0x46546C67 = 'glTF')
  if (buffer.byteLength >= 4) {
    const magic = new DataView(buffer).getUint32(0, true);
    if (magic === 0x46546c67) {
      return 'glb';
    }
  }

  const bytes = new Uint8Array(buffer, 0, Math.min(100, buffer.byteLength));
  const start = new TextDecoder().decode(bytes).trim();

  // IFCX is JSON starting with {
  if (start.startsWith('{')) {
    return 'ifcx';
  }

  // IFC STEP starts with ISO-10303-21
  if (start.includes('ISO-10303-21') || start.startsWith('ISO')) {
    return 'ifc';
  }

  return 'unknown';
}

// ============================================================================
// Federated IFCX Parsing
// ============================================================================

/**
 * Input for federated parsing - a buffer with a name.
 */
export interface FederatedFileInput {
  buffer: ArrayBuffer;
  name: string;
}

/**
 * Options for federated IFCX parsing.
 */
export interface FederatedParseOptions extends IfcxParseOptions {
  /** Maximum inheritance depth (default: 10) */
  maxInheritDepth?: number;
}

/**
 * Result of parsing federated IFCX files.
 * Extends the standard result with layer information.
 */
export interface FederatedIfcxParseResult extends IfcxParseResult {
  /** Layer stack with all loaded layers */
  layerStack: LayerStack;
  /** Path index for cross-file lookups */
  pathIndex: PathIndex;
  /** Composition statistics */
  compositionStats: {
    layersUsed: number;
    inheritanceResolutions: number;
    crossLayerReferences: number;
  };
  /** Map from path to layer IDs that define it */
  pathToLayers: Map<string, string[]>;
}

/**
 * Parse multiple IFCX files as federated layers.
 *
 * Files are loaded as layers with the first file being the base (weakest)
 * and subsequent files being overlays (stronger). Layer order can be
 * adjusted after parsing using the returned LayerStack.
 *
 * @param files - Array of file buffers with names
 * @param options - Parse options
 * @returns Federated parse result with layer information
 *
 * @example
 * ```typescript
 * const result = await parseFederatedIfcx([
 *   { buffer: baseBuffer, name: 'hello-wall.ifcx' },
 *   { buffer: overlayBuffer, name: 'add-fire-rating.ifcx' },
 * ]);
 *
 * // Wall now has FireRating property from overlay
 * const wallProps = result.properties.getForEntity(wallId);
 * ```
 */
export async function parseFederatedIfcx(
  files: FederatedFileInput[],
  options: FederatedParseOptions = {}
): Promise<FederatedIfcxParseResult> {
  const startTime = performance.now();

  if (files.length === 0) {
    throw new Error('At least one IFCX file is required');
  }

  options.onProgress?.({ phase: 'parse', percent: 0 });

  // Phase 1: Parse all files and build layer stack
  const layerStack = createLayerStack();
  let totalSize = 0;

  for (let i = 0; i < files.length; i++) {
    const { buffer, name } = files[i];
    totalSize += buffer.byteLength;

    const text = new TextDecoder().decode(buffer);
    let file: IfcxFile;

    try {
      file = JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid IFCX file "${name}": JSON parse error - ${e}`);
    }

    // Validate header
    if (!file.header?.ifcxVersion?.toLowerCase().includes('ifcx')) {
      throw new Error(`Invalid IFCX file "${name}": missing or invalid header.ifcxVersion`);
    }

    // Add as layer (first file is weakest, last is strongest)
    // We add at position 0 so later files become strongest
    layerStack.addLayerAt(file, buffer, name, 0, {
      type: 'file',
      filename: name,
      size: buffer.byteLength,
    });

    options.onProgress?.({
      phase: 'parse',
      percent: Math.round(((i + 1) / files.length) * 100),
    });
  }

  options.onProgress?.({ phase: 'compose', percent: 0 });

  // Phase 2: Compose federated layers
  const compositionResult = composeFederated(layerStack, {
    onProgress: (phase, percent) => {
      options.onProgress?.({ phase: `compose-${phase}`, percent });
    },
    maxInheritDepth: options.maxInheritDepth,
  });

  options.onProgress?.({ phase: 'compose', percent: 100 });

  // Convert composed nodes to standard ComposedNode format for extractors
  const composed = new Map<string, ComposedNode>();
  for (const [path, node] of compositionResult.composed) {
    composed.set(path, node as ComposedNode);
  }

  // Phase 3: Extract entities
  options.onProgress?.({ phase: 'entities', percent: 0 });
  const strings = new StringTable();
  const { entities, pathToId, idToPath } = extractEntities(composed, strings);
  options.onProgress?.({ phase: 'entities', percent: 100 });

  // Phase 4: Extract properties
  options.onProgress?.({ phase: 'properties', percent: 0 });
  const properties = extractProperties(composed, pathToId, strings);
  options.onProgress?.({ phase: 'properties', percent: 100 });

  // Phase 5: Extract geometry
  options.onProgress?.({ phase: 'geometry', percent: 0 });
  const meshes = extractGeometry(composed, pathToId);
  const pointClouds = extractPointClouds(composed, pathToId);
  options.onProgress?.({ phase: 'geometry', percent: 100 });

  // Phase 6: Build hierarchy
  options.onProgress?.({ phase: 'hierarchy', percent: 0 });
  const spatialHierarchy = buildHierarchy(composed, pathToId);
  options.onProgress?.({ phase: 'hierarchy', percent: 100 });

  // Phase 7: Build relationships
  options.onProgress?.({ phase: 'relationships', percent: 0 });
  const relationships = buildRelationships(composed, pathToId);
  options.onProgress?.({ phase: 'relationships', percent: 100 });

  // Phase 8: Build quantities
  const quantities = buildQuantities(composed, pathToId, strings);

  // Build path-to-layers map
  const pathToLayers = new Map<string, string[]>();
  for (const [path, node] of compositionResult.composed) {
    pathToLayers.set(path, Array.from(node.contributingLayers));
  }

  const parseTime = performance.now() - startTime;

  return {
    entities,
    properties,
    quantities,
    relationships,
    spatialHierarchy,
    strings,
    meshes,
    pointClouds,
    pathToId,
    idToPath,
    schemaVersion: 'IFC5',
    fileSize: totalSize,
    entityCount: entities.count,
    parseTime,
    // Federated-specific fields
    layerStack,
    pathIndex: compositionResult.pathIndex,
    compositionStats: {
      layersUsed: compositionResult.stats.layersUsed,
      inheritanceResolutions: compositionResult.stats.inheritanceResolutions,
      crossLayerReferences: compositionResult.stats.crossLayerReferences,
    },
    pathToLayers,
  };
}

/**
 * Add an overlay layer to an existing federated result.
 * Returns a new result with the overlay applied.
 */
export async function addIfcxOverlay(
  baseResult: FederatedIfcxParseResult,
  overlayBuffer: ArrayBuffer,
  overlayName: string,
  options: FederatedParseOptions = {}
): Promise<FederatedIfcxParseResult> {
  // Parse overlay file
  const text = new TextDecoder().decode(overlayBuffer);
  let file: IfcxFile;

  try {
    file = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid IFCX overlay "${overlayName}": JSON parse error - ${e}`);
  }

  // Validate header
  if (!file.header?.ifcxVersion?.toLowerCase().includes('ifcx')) {
    throw new Error(`Invalid IFCX overlay "${overlayName}": missing or invalid header.ifcxVersion`);
  }

  // Add to layer stack (at top = strongest)
  baseResult.layerStack.addLayer(file, overlayBuffer, overlayName, {
    type: 'file',
    filename: overlayName,
    size: overlayBuffer.byteLength,
  });

  // Re-compose with new layer
  // Collect all files from the layer stack
  const files: FederatedFileInput[] = baseResult.layerStack
    .getLayers()
    .map((layer) => ({
      buffer: layer.buffer,
      name: layer.name,
    }))
    .reverse(); // Reverse because layers are stored strongest-first

  return parseFederatedIfcx(files, options);
}
