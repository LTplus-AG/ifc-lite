/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry Extractor for IFCX
 * Extracts USD-style mesh data and converts to MeshData format
 *
 * COORDINATE SYSTEM:
 * - IFCX uses Z-up (following IFC/buildingSMART convention)
 * - The ifc-lite viewer uses Y-up (standard WebGL convention)
 * - This extractor converts from Z-up to Y-up after applying transforms
 */

import type { ComposedNode, UsdMesh, UsdTransform } from './types.js';
import { ATTR } from './types.js';
import { getNodeLineage, type TraversalFrame, walkComposedFrames } from './traversal.js';

/**
 * MeshData interface compatible with @ifc-lite/geometry
 */
export interface MeshData {
  expressId: number;
  ifcType?: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
}

/**
 * Extract geometry from composed IFCX nodes.
 *
 * IFC5 geometry is pre-tessellated (unlike IFC4 parametric geometry),
 * so this is straightforward mesh extraction.
 *
 * Note: Meshes are often on child nodes (like "Body", "Axis") that don't
 * have their own bsi::ifc::class. We associate these with the closest
 * ancestor entity that has an expressId.
 *
 * Output geometry is converted to Y-up for the viewer.
 */
export function extractGeometry(
  composed: Map<string, ComposedNode>,
  pathToId: Map<string, number>
): MeshData[] {
  const meshes: MeshData[] = [];
  const contextByFrame = new WeakMap<TraversalFrame, GeometryContext | null>();
  const transformByFrame = new WeakMap<TraversalFrame, Float32Array | null>();
  // A node reachable through multiple parents (e.g. storey→wall AND
  // space→wall containment edges, as our own exporter emits) is visited
  // once per traversal path, which used to duplicate its mesh — the
  // export round-trip multiplied triangle counts by the number of
  // incoming edges. Emit once per (node path, entity context, accumulated
  // transform, resolved presentation): two frames collapse only when
  // every lineage-derived output is identical, i.e. a true alias. A
  // shared type body reached from two instances (different expressIds),
  // genuine instancing (different transforms), or differently styled
  // ancestors (different resolved color) all still emit.
  const emitted = new Set<string>();

  walkComposedFrames(composed, (frame) => {
    const inheritedContext = frame.parent ? contextByFrame.get(frame.parent) ?? null : null;
    const parentTransform = frame.parent ? transformByFrame.get(frame.parent) ?? null : null;
    const context = resolveContext(frame.node, inheritedContext, pathToId);
    // Canonicalize: an explicit identity usd::xformop and "no transform"
    // produce identical geometry and must dedupe against each other.
    const transform = canonicalizeTransform(
      combineTransforms(getNodeTransform(frame.node), parentTransform)
    );
    const lineage = getNodeLineage(frame);

    contextByFrame.set(frame, context);
    transformByFrame.set(frame, transform);

    const mesh = frame.node.attributes.get(ATTR.MESH) as UsdMesh | undefined;
    if (mesh && context && !context.isTypeDefinition && !isInvisible(lineage)) {
      const color = resolvePresentation(lineage);
      const emitKey = [
        frame.node.path,
        context.expressId,
        transform ? transform.join(',') : 'identity',
        color ? color.join(',') : 'default',
      ].join('|');
      if (!emitted.has(emitKey)) {
        emitted.add(emitKey);
        const meshData = convertUsdMesh(mesh, context.expressId, context.ifcType, transform);
        if (color) {
          meshData.color = color;
        }
        meshes.push(meshData);
      }
    }
  });

  return meshes;
}

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Map an explicit identity matrix to null so it keys/behaves like "no transform". */
function canonicalizeTransform(transform: Float32Array | null): Float32Array | null {
  if (!transform) return null;
  for (let i = 0; i < 16; i++) {
    if (transform[i] !== IDENTITY_MATRIX[i]) return transform;
  }
  return null;
}

/**
 * Resolve the nearest entity context for mesh association.
 */
type GeometryContext = {
  expressId: number;
  ifcType?: string;
  isTypeDefinition: boolean;
};

function resolveContext(
  node: ComposedNode,
  context: GeometryContext | null,
  pathToId: Map<string, number>
): GeometryContext | null {
  const ifcClass = node.attributes.get(ATTR.CLASS) as { code?: string } | undefined;
  const expressId = pathToId.get(node.path);
  if (expressId === undefined) {
    return context;
  }

  return {
    expressId,
    ifcType: ifcClass?.code,
    isTypeDefinition: (context?.isTypeDefinition ?? false) || isIfcTypeDefinition(node),
  };
}

/**
 * Convert USD mesh format to MeshData format.
 * Applies transform in Z-up space, then converts to Y-up for the viewer.
 */
function convertUsdMesh(
  usd: UsdMesh,
  expressId: number,
  ifcType: string | undefined,
  transform: Float32Array | null
): MeshData {
  // The homogeneous denominator is validated per-vertex inside applyTransform
  // (a projective matrix can produce a bad w on points other than the first).

  // Process points: apply transform in Z-up space, then convert to Y-up
  const positions = new Float32Array(usd.points.length * 3);
  for (let i = 0; i < usd.points.length; i++) {
    const [x, y, z] = usd.points[i];

    // World position in Z-up space
    let wx: number, wy: number, wz: number;
    if (transform) {
      [wx, wy, wz] = applyTransform(x, y, z, transform);
    } else {
      wx = x;
      wy = y;
      wz = z;
    }

    // Convert from Z-up to Y-up: swap Y and Z
    // Z-up: X=right, Y=forward, Z=up
    // Y-up: X=right, Y=up, Z=back (negated for right-hand rule)
    positions[i * 3] = wx;
    positions[i * 3 + 1] = wz;      // Y-up = Z from Z-up
    positions[i * 3 + 2] = -wy;     // Z-back = -Y from Z-up
  }

  // Handle face vertex counts if present (for non-triangle faces)
  let indices: Uint32Array;
  if (usd.faceVertexCounts && usd.faceVertexCounts.length > 0) {
    indices = triangulatePolygons(usd.faceVertexIndices, usd.faceVertexCounts);
  } else {
    // Already triangle indices
    indices = new Uint32Array(usd.faceVertexIndices);
  }

  // Compute or use provided normals
  const normals = usd.normals
    ? flattenNormals(usd.normals, transform)
    : computeNormals(positions, indices);

  return {
    expressId,
    ifcType,
    positions,
    indices,
    normals,
    color: [0.8, 0.8, 0.8, 1.0], // Default gray, will be overridden by presentation
  };
}

/**
 * Triangulate polygon faces into triangles.
 */
function triangulatePolygons(faceVertexIndices: number[], faceVertexCounts: number[]): Uint32Array {
  const triangles: number[] = [];
  let indexOffset = 0;

  for (const count of faceVertexCounts) {
    // Fan triangulation
    const v0 = faceVertexIndices[indexOffset];
    for (let i = 1; i < count - 1; i++) {
      triangles.push(v0);
      triangles.push(faceVertexIndices[indexOffset + i]);
      triangles.push(faceVertexIndices[indexOffset + i + 1]);
    }
    indexOffset += count;
  }

  return new Uint32Array(triangles);
}

/**
 * Get node-local transform matrix in Z-up space.
 */
function getNodeTransform(node: ComposedNode): Float32Array | null {
  const xform = node.attributes.get(ATTR.TRANSFORM) as UsdTransform | undefined;
  return xform?.transform ? flattenMatrix(xform.transform) : null;
}

/**
 * Combine transforms using row-major, right-multiply order.
 * For point * matrix math: childWorld = point * child * parent * root.
 */
function combineTransforms(
  nodeTransform: Float32Array | null,
  parentTransform: Float32Array | null
): Float32Array | null {
  if (!nodeTransform) return parentTransform;
  if (!parentTransform) return nodeTransform;
  return multiplyMatrices(nodeTransform, parentTransform);
}

/**
 * Flatten 2D matrix array to 1D Float32Array.
 */
function flattenMatrix(m: number[][]): Float32Array {
  // USD uses row-major 4x4 matrices
  const result = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      result[row * 4 + col] = m[row]?.[col] ?? (row === col ? 1 : 0);
    }
  }
  return result;
}

/**
 * Apply 4x4 transform matrix to a point.
 */
function applyTransform(x: number, y: number, z: number, m: Float32Array): [number, number, number] {
  // Row-major matrix multiplication with perspective divide. `w` is computed
  // per-vertex, so a projective/malformed usd::xformop can yield a zero or
  // non-finite denominator on *any* point — validate each, not just the first,
  // or the divide silently produces ±Infinity / NaN positions that poison the mesh.
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
    throw new Error('IFCx geometry: usd::xformop produces non-finite homogeneous w; matrix is malformed or singular');
  }
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}


function isIfcTypeDefinition(node: ComposedNode): boolean {
  const customData = node.attributes.get('customdata') as { originalStepInstance?: string } | undefined;
  const originalStepInstance = customData?.originalStepInstance;
  if (typeof originalStepInstance !== 'string') return false;
  return /=[A-Za-z0-9_]*Type\(/i.test(originalStepInstance);
}

function isInvisible(lineage: ComposedNode[]): boolean {
  for (let i = lineage.length - 1; i >= 0; i--) {
    const current = lineage[i];
    const visibility = current.attributes.get(ATTR.VISIBILITY) as { visibility?: string } | undefined;
    if (typeof visibility?.visibility === 'string') {
      return visibility.visibility.toLowerCase() === 'invisible';
    }
  }
  return false;
}

/**
 * Resolve presentation attributes (color, opacity) from the lineage.
 * Returns null when no ancestor carries a diffuse color (caller keeps
 * the default). Resolved BEFORE mesh conversion so the dedupe key can
 * distinguish differently-styled traversal paths.
 */
function resolvePresentation(lineage: ComposedNode[]): [number, number, number, number] | null {
  // Check this node and its ancestors for presentation attributes
  for (let i = lineage.length - 1; i >= 0; i--) {
    const current = lineage[i];
    const diffuse = current.attributes.get(ATTR.DIFFUSE_COLOR) as number[] | undefined;
    const opacity = current.attributes.get(ATTR.OPACITY) as number | undefined;

    if (diffuse) {
      const [r, g, b] = diffuse;
      const a = opacity ?? 1.0;
      return [r, g, b, a];
    }
  }
  return null;
}

/**
 * Compute normals from triangle mesh.
 */
function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    // Triangle vertices
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];

    // Edge vectors
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    // Cross product
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    // Accumulate (will normalize later)
    normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz;
    normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz;
    normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz;
  }

  // Normalize
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.sqrt(normals[i] ** 2 + normals[i + 1] ** 2 + normals[i + 2] ** 2);
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
  }

  return normals;
}

/**
 * Flatten 2D normals array to 1D, transform, and convert to Y-up.
 */
function flattenNormals(normals: number[][], transform: Float32Array | null): Float32Array {
  const result = new Float32Array(normals.length * 3);

  const hasTransform = transform !== null;

  for (let i = 0; i < normals.length; i++) {
    // Normal in Z-up space
    let [nx, ny, nz] = normals[i];

    if (hasTransform && transform) {
      // Transform normal by upper 3x3 of matrix (rotation only)
      const tnx = transform[0] * nx + transform[4] * ny + transform[8] * nz;
      const tny = transform[1] * nx + transform[5] * ny + transform[9] * nz;
      const tnz = transform[2] * nx + transform[6] * ny + transform[10] * nz;

      // Renormalize
      const len = Math.sqrt(tnx ** 2 + tny ** 2 + tnz ** 2);
      if (len > 0) {
        nx = tnx / len;
        ny = tny / len;
        nz = tnz / len;
      } else {
        nx = tnx;
        ny = tny;
        nz = tnz;
      }
    }

    // Convert from Z-up to Y-up (same as positions)
    result[i * 3] = nx;
    result[i * 3 + 1] = nz;      // Y = Z
    result[i * 3 + 2] = -ny;     // Z = -Y
  }

  return result;
}

/**
 * Multiply two 4x4 matrices (row-major).
 */
function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[row * 4 + k] * b[k * 4 + col];
      }
      result[row * 4 + col] = sum;
    }
  }
  return result;
}
