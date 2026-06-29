/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GLB (binary glTF) parser for loading pre-cached geometry
 *
 * Complements the GLTFExporter by enabling round-trip workflows:
 * IFC -> GLB (export) -> GLB -> MeshData (import)
 */

import type { MeshData } from '@ifc-lite/geometry';
import { safeUtf8Decode } from '@ifc-lite/data';

// glTF 2.0 constants
const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

// Component types
const COMPONENT_BYTE = 5120;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_SHORT = 5122;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;
const COMPONENT_FLOAT = 5126;

/** Parsed GLB structure */
export interface ParsedGLB {
  json: GLTFDocument;
  bin: Uint8Array | null;
}

/** Mapping from IFC express ID to GLB node/mesh indices */
export interface GLBMapping {
  expressIdToNode: Map<number, number>;
  expressIdToMesh: Map<number, number>;
  nodeToExpressId: Map<number, number>;
}

// Minimal glTF type definitions for parsing
interface GLTFDocument {
  asset: { version: string; generator?: string };
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GLTFNode[];
  meshes?: GLTFMesh[];
  materials?: GLTFMaterial[];
  accessors?: GLTFAccessor[];
  bufferViews?: GLTFBufferView[];
  buffers?: GLTFBuffer[];
}

interface GLTFNode {
  mesh?: number;
  name?: string;
  extras?: { expressId?: number };
  children?: number[];
  /** Node-local translation (xyz). Our exporter places all geometry under a
   *  single translated root node, so this must be composed down the hierarchy. */
  translation?: number[];
}

interface GLTFMesh {
  primitives: GLTFPrimitive[];
  name?: string;
}

interface GLTFPrimitive {
  attributes: {
    POSITION: number;
    NORMAL?: number;
  };
  indices?: number;
  mode?: number;
  material?: number;
}

interface GLTFMaterial {
  pbrMetallicRoughness?: {
    baseColorFactor?: [number, number, number, number] | number[];
  };
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
}

interface GLTFAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
  min?: number[];
  max?: number[];
}

interface GLTFBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

interface GLTFBuffer {
  byteLength: number;
  uri?: string;
}

/**
 * Parse a GLB (binary glTF) file
 *
 * @param data - The GLB file as a Uint8Array
 * @returns Parsed GLB with JSON document and binary buffer
 * @throws Error if the GLB format is invalid
 */
export function parseGLB(data: Uint8Array): ParsedGLB {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate header (12 bytes)
  if (data.byteLength < 12) {
    throw new Error('GLB file too small for header');
  }

  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(`Invalid GLB magic: expected 0x${GLB_MAGIC.toString(16)}, got 0x${magic.toString(16)}`);
  }

  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) {
    throw new Error(`Unsupported GLB version: ${version}`);
  }

  const totalLength = view.getUint32(8, true);
  if (totalLength > data.byteLength) {
    throw new Error(`GLB declared length ${totalLength} exceeds data length ${data.byteLength}`);
  }

  // Parse chunks
  let offset = 12;
  let json: GLTFDocument | null = null;
  let bin: Uint8Array | null = null;

  while (offset < totalLength) {
    if (offset + 8 > totalLength) {
      throw new Error('Incomplete chunk header');
    }

    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;

    if (offset + chunkLength > totalLength) {
      throw new Error('Chunk extends beyond file');
    }

    if (chunkType === CHUNK_TYPE_JSON) {
      // Decode SAB-safe: the viewer streams large imports (>= 256 MB) into a
      // SharedArrayBuffer (acquireFileBuffer), and `TextDecoder.decode` rejects any
      // SharedArrayBuffer-backed view (a Spectre mitigation) with "...can't be a
      // SharedArrayBuffer...". safeUtf8Decode copies the JSON chunk into a private
      // (non-shared) scratch buffer on the SAB path, so re-importing a large GLB no
      // longer throws. Only the small JSON chunk is copied; BIN stays zero-copy.
      const jsonString = safeUtf8Decode(data, offset, offset + chunkLength);
      json = JSON.parse(jsonString) as GLTFDocument;
    } else if (chunkType === CHUNK_TYPE_BIN) {
      bin = data.slice(offset, offset + chunkLength);
    }

    offset += chunkLength;
  }

  if (!json) {
    throw new Error('GLB missing JSON chunk');
  }

  return { json, bin };
}

/**
 * Extract mapping between IFC express IDs and GLB node/mesh indices
 *
 * This relies on the extras.expressId property set during export.
 *
 * @param gltf - Parsed glTF document
 * @returns Mapping between express IDs and node/mesh indices
 */
export function extractGLBMapping(gltf: GLTFDocument): GLBMapping {
  const expressIdToNode = new Map<number, number>();
  const expressIdToMesh = new Map<number, number>();
  const nodeToExpressId = new Map<number, number>();

  if (!gltf.nodes) {
    return { expressIdToNode, expressIdToMesh, nodeToExpressId };
  }

  for (let nodeIdx = 0; nodeIdx < gltf.nodes.length; nodeIdx++) {
    const node = gltf.nodes[nodeIdx];
    const expressId = node.extras?.expressId;

    if (expressId !== undefined) {
      expressIdToNode.set(expressId, nodeIdx);
      nodeToExpressId.set(nodeIdx, expressId);

      if (node.mesh !== undefined) {
        expressIdToMesh.set(expressId, node.mesh);
      }
    }
  }

  return { expressIdToNode, expressIdToMesh, nodeToExpressId };
}

/**
 * Get the byte size for a glTF component type
 */
function getComponentSize(componentType: number): number {
  switch (componentType) {
    case COMPONENT_BYTE:
    case COMPONENT_UNSIGNED_BYTE:
      return 1;
    case COMPONENT_SHORT:
    case COMPONENT_UNSIGNED_SHORT:
      return 2;
    case COMPONENT_UNSIGNED_INT:
    case COMPONENT_FLOAT:
      return 4;
    default:
      throw new Error(`Unknown component type: ${componentType}`);
  }
}

/**
 * Get the number of components for an accessor type
 */
function getComponentCount(type: string): number {
  switch (type) {
    case 'SCALAR':
      return 1;
    case 'VEC2':
      return 2;
    case 'VEC3':
      return 3;
    case 'VEC4':
      return 4;
    case 'MAT2':
      return 4;
    case 'MAT3':
      return 9;
    case 'MAT4':
      return 16;
    default:
      throw new Error(`Unknown accessor type: ${type}`);
  }
}

/**
 * Read accessor data as a typed array
 */
function readAccessorData(
  gltf: GLTFDocument,
  bin: Uint8Array,
  accessorIdx: number
): Float32Array | Uint32Array | Uint16Array | Uint8Array {
  const accessor = gltf.accessors?.[accessorIdx];
  if (!accessor) {
    throw new Error(`Accessor ${accessorIdx} not found`);
  }

  const bufferView = gltf.bufferViews?.[accessor.bufferView];
  if (!bufferView) {
    throw new Error(`BufferView ${accessor.bufferView} not found`);
  }

  const componentSize = getComponentSize(accessor.componentType);
  const componentCount = getComponentCount(accessor.type);
  const elementSize = componentSize * componentCount;
  const byteStride = bufferView.byteStride ?? elementSize;

  const bufferOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

  // If data is tightly packed, we can use a view directly
  if (byteStride === elementSize) {
    const byteLength = accessor.count * elementSize;
    const slice = bin.slice(bufferOffset, bufferOffset + byteLength);

    switch (accessor.componentType) {
      case COMPONENT_FLOAT:
        return new Float32Array(slice.buffer, slice.byteOffset, accessor.count * componentCount);
      case COMPONENT_UNSIGNED_INT:
        return new Uint32Array(slice.buffer, slice.byteOffset, accessor.count * componentCount);
      case COMPONENT_UNSIGNED_SHORT:
        return new Uint16Array(slice.buffer, slice.byteOffset, accessor.count * componentCount);
      case COMPONENT_UNSIGNED_BYTE:
        return slice;
      default:
        throw new Error(`Unsupported component type for reading: ${accessor.componentType}`);
    }
  }

  // Handle strided data
  const result =
    accessor.componentType === COMPONENT_FLOAT
      ? new Float32Array(accessor.count * componentCount)
      : accessor.componentType === COMPONENT_UNSIGNED_INT
        ? new Uint32Array(accessor.count * componentCount)
        : accessor.componentType === COMPONENT_UNSIGNED_SHORT
          ? new Uint16Array(accessor.count * componentCount)
          : new Uint8Array(accessor.count * componentCount);

  const dataView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  for (let i = 0; i < accessor.count; i++) {
    const elementOffset = bufferOffset + i * byteStride;
    for (let c = 0; c < componentCount; c++) {
      const byteOffset = elementOffset + c * componentSize;
      let value: number;

      switch (accessor.componentType) {
        case COMPONENT_FLOAT:
          value = dataView.getFloat32(byteOffset, true);
          break;
        case COMPONENT_UNSIGNED_INT:
          value = dataView.getUint32(byteOffset, true);
          break;
        case COMPONENT_UNSIGNED_SHORT:
          value = dataView.getUint16(byteOffset, true);
          break;
        case COMPONENT_UNSIGNED_BYTE:
          value = dataView.getUint8(byteOffset);
          break;
        default:
          throw new Error(`Unsupported component type: ${accessor.componentType}`);
      }

      result[i * componentCount + c] = value;
    }
  }

  return result;
}

/**
 * Parse GLB geometry into MeshData format
 *
 * @param gltf - Parsed glTF document
 * @param bin - Binary buffer from GLB
 * @returns Array of MeshData objects
 */
export function parseGLBToMeshData(gltf: GLTFDocument, bin: Uint8Array): MeshData[] {
  const meshes: MeshData[] = [];
  const mapping = extractGLBMapping(gltf);

  if (!gltf.nodes || !gltf.meshes) {
    return meshes;
  }

  // Compose node translations down the hierarchy. Our exporter parents every
  // element node under one translated root (placement rides that root, vertices
  // are centre-relative), so a parser that read accessors alone would land the
  // whole model at the scene centre. Walk from the scene roots accumulating
  // translation; the composed value rides each mesh as `MeshData.origin` below.
  const nodeWorldT = new Map<number, [number, number, number]>();
  {
    const seen = new Set<number>();
    const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes.map((_, i) => i);
    const walk = (idx: number, px: number, py: number, pz: number): void => {
      const nd = gltf.nodes?.[idx];
      if (!nd || seen.has(idx)) return; // guard against malformed cycles
      seen.add(idx);
      const t = nd.translation;
      const x = px + (t?.[0] ?? 0);
      const y = py + (t?.[1] ?? 0);
      const z = pz + (t?.[2] ?? 0);
      nodeWorldT.set(idx, [x, y, z]);
      for (const c of nd.children ?? []) walk(c, x, y, z);
    };
    for (const r of roots) walk(r, 0, 0, 0);
    // Extraction below iterates ALL nodes, not just scene-reachable ones. Walk any
    // node the scene roots didn't reach (disconnected components) as its own root so
    // every mesh node gets a composed transform — never silently emitted in local space.
    for (let i = 0; i < gltf.nodes.length; i++) {
      if (!seen.has(i)) walk(i, 0, 0, 0);
    }
  }

  const DEFAULT_COLOR: [number, number, number, number] = [0.8, 0.8, 0.8, 1.0];

  const resolveMaterialColor = (
    materialIdx: number | undefined,
  ): [number, number, number, number] => {
    if (materialIdx === undefined) return [...DEFAULT_COLOR];
    const material = gltf.materials?.[materialIdx];
    const factor = material?.pbrMetallicRoughness?.baseColorFactor;
    if (!Array.isArray(factor) || factor.length < 3) return [...DEFAULT_COLOR];
    const r = factor[0], g = factor[1], b = factor[2];
    const a = factor.length >= 4 ? factor[3] : 1.0;
    if (
      typeof r !== 'number' || !Number.isFinite(r) ||
      typeof g !== 'number' || !Number.isFinite(g) ||
      typeof b !== 'number' || !Number.isFinite(b) ||
      typeof a !== 'number' || !Number.isFinite(a)
    ) {
      return [...DEFAULT_COLOR];
    }
    return [r, g, b, a];
  };

  for (let nodeIdx = 0; nodeIdx < gltf.nodes.length; nodeIdx++) {
    const node = gltf.nodes[nodeIdx];
    if (node.mesh === undefined) continue;

    const mesh = gltf.meshes[node.mesh];
    if (!mesh || !mesh.primitives.length) continue;

    const expressId = mapping.nodeToExpressId.get(nodeIdx) ?? nodeIdx;

    // Process each primitive (typically one per mesh from our exporter)
    for (const primitive of mesh.primitives) {
      // Skip non-triangle primitives (mode 4 = TRIANGLES, undefined defaults to TRIANGULAR)
      if (primitive.mode !== undefined && primitive.mode !== 4) {
        continue;
      }

      const posAccessorIdx = primitive.attributes.POSITION;
      const normAccessorIdx = primitive.attributes.NORMAL;
      const idxAccessorIdx = primitive.indices;

      if (posAccessorIdx === undefined) continue;

      // Read position data
      const positions = readAccessorData(gltf, bin, posAccessorIdx);
      if (!(positions instanceof Float32Array)) {
        throw new Error('Position data must be Float32');
      }

      // Surface the node's composed world translation as `MeshData.origin`
      // (world = origin + position) rather than baking it into the f32 vertices.
      // The exporter keeps vertices scene-centre-relative precisely so a
      // georeferenced placement (a root translation of ~1e6 m) stays out of the
      // f32 buffer; baking it back in would re-snap every vertex to a ~0.5 m grid
      // and collapse fine detail (the GLB-roundtrip corruption). The renderer and
      // all world-space consumers fold `origin` (#1114), so positions stay small
      // and full-precision while the element still lands at its world position.
      const wt = nodeWorldT.get(nodeIdx);
      const origin: [number, number, number] | undefined =
        wt && (wt[0] !== 0 || wt[1] !== 0 || wt[2] !== 0) ? wt : undefined;

      // Read normal data (optional, generate if missing)
      let normals: Float32Array;
      if (normAccessorIdx !== undefined) {
        const normData = readAccessorData(gltf, bin, normAccessorIdx);
        if (!(normData instanceof Float32Array)) {
          throw new Error('Normal data must be Float32');
        }
        normals = normData;
      } else {
        // Generate flat normals if none provided
        normals = new Float32Array(positions.length);
      }

      // Read index data (optional for non-indexed geometry)
      let indices: Uint32Array;
      if (idxAccessorIdx !== undefined) {
        const idxData = readAccessorData(gltf, bin, idxAccessorIdx);
        if (idxData instanceof Float32Array) {
          throw new Error('Index data cannot be Float32');
        }
        // Convert to Uint32Array if needed
        indices =
          idxData instanceof Uint32Array ? idxData : new Uint32Array(idxData);
      } else {
        // Non-indexed: generate sequential indices
        indices = new Uint32Array(positions.length / 3);
        for (let i = 0; i < indices.length; i++) {
          indices[i] = i;
        }
      }

      meshes.push({
        expressId,
        positions,
        normals,
        indices,
        color: resolveMaterialColor(primitive.material),
        ...(origin ? { origin } : {}),
      });
    }
  }

  return meshes;
}

/**
 * Convenience function to parse GLB directly to MeshData
 *
 * @param data - GLB file as Uint8Array
 * @returns Array of MeshData objects
 */
export function loadGLBToMeshData(data: Uint8Array): MeshData[] {
  const { json, bin } = parseGLB(data);
  if (!bin) {
    throw new Error('GLB has no binary buffer');
  }
  return parseGLBToMeshData(json, bin);
}
