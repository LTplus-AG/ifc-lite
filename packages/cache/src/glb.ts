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
import { primitiveTexture, validateGLBImages } from './glb-images.js';
import { linearToSrgb } from './glb-color.js';

// glTF 2.0 constants
const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

import { readAccessorData } from './glb-accessor.js';
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

import type { GLTFDocument, GLTFMesh } from './glb-types.js';
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

import { type Mat4, MAT4_IDENTITY, mat4Mul, nodeLocalMat4, linearIsIdentity, normalMatrix, mirrored } from './glb-transform.js';
/**
 * Parse GLB geometry into MeshData format
 *
 * @param gltf - Parsed glTF document
 * @param bin - Binary buffer from GLB
 * @returns Array of MeshData objects
 */
export function parseGLBToMeshData(gltf: GLTFDocument, bin: Uint8Array): MeshData[] {
  const meshes: MeshData[] = [];
  for (const extension of gltf.extensionsRequired ?? []) {
    if (!['KHR_texture_transform', 'KHR_materials_unlit'].includes(extension)) throw new Error(`GLB: unsupported required extension ${extension}`);
  }
  validateGLBImages(gltf, bin);
  const mapping = extractGLBMapping(gltf);

  if (!gltf.nodes || !gltf.meshes) {
    return meshes;
  }

  // Compose each node's world transform down the hierarchy as a column-major 4x4.
  // The exporter parents every element node under one translated root (placement
  // rides that root; vertices are scene-centre-relative). The from-meshes path uses
  // pure node TRANSLATIONS; the from-bytes INSTANCED path places each shared-template
  // occurrence with a node MATRIX (rotation + translation). We compose the full 4x4
  // so both round-trip: the translation rides each mesh as `MeshData.origin` (kept
  // out of the f32 buffer for georef precision) and any rotation/scale is baked into
  // the small, local imported vertices below.
  const nodeWorldM = new Map<number, Mat4>();
  {
    const seen = new Set<number>();
    const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes.map((_, i) => i);
    const walk = (idx: number, parent: Mat4): void => {
      const pending: Array<[number, Mat4]> = [[idx, parent]];
      while (pending.length) {
      const [idx, parent] = pending.pop()!;
      const nd = gltf.nodes?.[idx];
      if (!nd || seen.has(idx)) continue; // finite iterative walk
      if (nd.skin !== undefined) throw new Error('GLB: skinned capture meshes are not supported');
      seen.add(idx);
      const world = mat4Mul(parent, nodeLocalMat4(nd));
      nodeWorldM.set(idx, world);
      for (const c of nd.children ?? []) pending.push([c, world]);
      }
    };
    for (const r of roots) walk(r, MAT4_IDENTITY);
    // Extraction below iterates ALL nodes, not just scene-reachable ones. Walk any
    // node the scene roots didn't reach (disconnected components) as its own root so
    // every mesh node gets a composed transform — never silently emitted in local space.
    for (let i = 0; i < gltf.nodes.length; i++) {
      if (!seen.has(i)) walk(i, MAT4_IDENTITY);
    }
  }

  const DEFAULT_COLOR: [number, number, number, number] = [0.8, 0.8, 0.8, 1.0];

  const resolveMaterialColor = (
    materialIdx: number | undefined,
  ): [number, number, number, number] => {
    if (materialIdx === undefined) return [...DEFAULT_COLOR];
    const material = gltf.materials?.[materialIdx];
    const factor = material?.pbrMetallicRoughness?.baseColorFactor;
    if (!Array.isArray(factor) || factor.length < 3) return material?.pbrMetallicRoughness?.baseColorTexture ? [1, 1, 1, 1] : [...DEFAULT_COLOR];
    const r = factor[0], g = factor[1], b = factor[2], a = factor.length >= 4 ? factor[3] : 1.0;
    if (
      typeof r !== 'number' || !Number.isFinite(r) ||
      typeof g !== 'number' || !Number.isFinite(g) ||
      typeof b !== 'number' || !Number.isFinite(b) ||
      typeof a !== 'number' || !Number.isFinite(a)
    ) {
      return [...DEFAULT_COLOR];
    }
    return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b), material?.pbrMetallicRoughness?.baseColorTexture ? 1 : a];
  };

  for (let nodeIdx = 0; nodeIdx < gltf.nodes.length; nodeIdx++) {
    const node = gltf.nodes[nodeIdx];
    if (node.mesh === undefined) continue;

    const mesh: GLTFMesh | undefined = gltf.meshes[node.mesh];
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
      const positions = readAccessorData(gltf, bin, posAccessorIdx, 'VEC3');
      if (!(positions instanceof Float32Array)) {
        throw new Error('Position data must be Float32');
      }

      // Read normal data (optional, generate if missing)
      let normals: Float32Array;
      if (normAccessorIdx !== undefined) {
        const normData = readAccessorData(gltf, bin, normAccessorIdx, 'VEC3');
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
        const idxData = readAccessorData(gltf, bin, idxAccessorIdx, 'SCALAR');
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

      if (positions.length % 3 || indices.length % 3 || normals.length !== positions.length || !positions.every(Number.isFinite) || !normals.every(Number.isFinite) || indices.some(index => index >= positions.length / 3)) throw new Error('GLB: invalid triangle geometry');
      if (normAccessorIdx === undefined) {
        for (let i = 0; i < indices.length; i += 3) {
          const a=indices[i]*3, b=indices[i+1]*3, c=indices[i+2]*3;
          const ux=positions[b]-positions[a], uy=positions[b+1]-positions[a+1], uz=positions[b+2]-positions[a+2];
          const vx=positions[c]-positions[a], vy=positions[c+1]-positions[a+1], vz=positions[c+2]-positions[a+2];
          for (const index of [a,b,c]) { normals[index]+=uy*vz-uz*vy; normals[index+1]+=uz*vx-ux*vz; normals[index+2]+=ux*vy-uy*vx; }
        }
        for (let i=0;i<normals.length;i+=3) { const length=Math.hypot(normals[i],normals[i+1],normals[i+2])||1; normals[i]/=length; normals[i+1]/=length; normals[i+2]/=length; }
      }
      // Apply the node's composed world transform. The TRANSLATION rides each mesh
      // as `MeshData.origin` (world = origin + position) and is kept OUT of the f32
      // vertex buffer: the exporter emits scene-centre-relative vertices precisely so
      // a georeferenced placement (~1e6 m) does not re-snap every vertex to a ~0.5 m
      // grid (the #1446 round-trip corruption); the renderer folds `origin` (#1114).
      // Any ROTATION/SCALE (a from-bytes instanced occurrence's node MATRIX) is baked
      // into the small, local vertices + normals here — MeshData has a translation
      // origin channel but no rotation channel, so honoring the matrix means rotating
      // the imported geometry, which stays f32-precise because the vertices are local.
      const m = nodeWorldM.get(nodeIdx) ?? MAT4_IDENTITY;
      const t: [number, number, number] = [m[12], m[13], m[14]];
      let outPositions = positions;
      let outNormals = normals;
      if (!linearIsIdentity(m)) {
        outPositions = new Float32Array(positions.length);
        for (let i = 0; i + 2 < positions.length; i += 3) {
          const x = positions[i], y = positions[i + 1], z = positions[i + 2];
          outPositions[i] = m[0] * x + m[4] * y + m[8] * z;
          outPositions[i + 1] = m[1] * x + m[5] * y + m[9] * z;
          outPositions[i + 2] = m[2] * x + m[6] * y + m[10] * z;
        }
        const n = normalMatrix(m);
        outNormals = new Float32Array(normals.length);
        for (let i = 0; i + 2 < normals.length; i += 3) {
          const x = normals[i], y = normals[i + 1], z = normals[i + 2];
          const nx = n[0] * x + n[3] * y + n[6] * z;
          const ny = n[1] * x + n[4] * y + n[7] * z;
          const nz = n[2] * x + n[5] * y + n[8] * z;
          const len = Math.hypot(nx, ny, nz) || 1;
          outNormals[i] = nx / len;
          outNormals[i + 1] = ny / len;
          outNormals[i + 2] = nz / len;
        }
      }
      if (mirrored(m)) {
        for (let i=0;i<indices.length;i+=3) [indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]];
      }
      const origin: [number, number, number] | undefined =
        t[0] !== 0 || t[1] !== 0 || t[2] !== 0 ? t : undefined;

      const texture = primitiveTexture(gltf, bin, primitive, positions.length / 3);
      meshes.push({
        ...texture,
        expressId,
        positions: outPositions,
        normals: outNormals,
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
