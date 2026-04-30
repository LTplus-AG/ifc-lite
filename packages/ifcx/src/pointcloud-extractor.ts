/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud extractor for IFCX.
 *
 * Reads the three buildingSMART point cloud schemas:
 *   - `pcd::base64`     — full PCD file embedded as base64
 *   - `points::array`   — inline JSON arrays of [x,y,z] (and optional rgb)
 *   - `points::base64`  — base64-Float32 buffers
 *
 * Coordinates: positions are extracted in IFCx-native Z-up space, with any
 * `usd::xformop` lineage transform applied. The extractor swaps Y/Z to
 * match the viewer's Y-up convention — same convention as the mesh
 * extractor (see geometry-extractor.ts).
 */

import { decodeIfcxPointAttribute, POINTCLOUD_ATTR_KEYS } from '@ifc-lite/pointcloud';
import type { ComposedNode, UsdTransform } from './types.js';
import { ATTR } from './types.js';
import { getNodeLineage, type TraversalFrame, walkComposedFrames } from './traversal.js';

export interface PointCloudExtraction {
  expressId: number;
  ifcType?: string;
  positions: Float32Array;
  colors?: Float32Array;
  pointCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export function extractPointClouds(
  composed: Map<string, ComposedNode>,
  pathToId: Map<string, number>
): PointCloudExtraction[] {
  const out: PointCloudExtraction[] = [];
  const contextByFrame = new WeakMap<TraversalFrame, PcContext | null>();
  const transformByFrame = new WeakMap<TraversalFrame, Float32Array | null>();

  walkComposedFrames(composed, (frame) => {
    const inheritedContext = frame.parent ? contextByFrame.get(frame.parent) ?? null : null;
    const parentTransform = frame.parent ? transformByFrame.get(frame.parent) ?? null : null;
    const context = resolveContext(frame.node, inheritedContext, pathToId);
    const transform = combineTransforms(getNodeTransform(frame.node), parentTransform);
    contextByFrame.set(frame, context);
    transformByFrame.set(frame, transform);

    if (!context || context.isTypeDefinition) return;
    if (!hasAnyPointAttr(frame.node.attributes)) return;
    if (isInvisible(getNodeLineage(frame))) return;

    const chunk = decodeIfcxPointAttribute(frame.node.attributes);
    if (!chunk) return;

    transformPositionsZUpToYUp(chunk.positions, transform);
    out.push({
      expressId: context.expressId,
      ifcType: context.ifcType,
      positions: chunk.positions,
      colors: chunk.colors,
      pointCount: chunk.pointCount,
      bbox: recomputeBBox(chunk.positions),
    });
  });

  return out;
}

// ─── shared traversal helpers ───────────────────────────────────────────────
// Kept local to this module rather than depending on geometry-extractor's
// internals. The duplication is small (≈25 lines) and the alternative —
// exporting private helpers — would tightly couple the two modules.

interface PcContext {
  expressId: number;
  ifcType?: string;
  isTypeDefinition: boolean;
}

function resolveContext(
  node: ComposedNode,
  parent: PcContext | null,
  pathToId: Map<string, number>
): PcContext | null {
  const ifcClass = node.attributes.get(ATTR.CLASS) as { code?: string } | undefined;
  const expressId = pathToId.get(node.path);
  if (expressId === undefined) return parent;
  return {
    expressId,
    ifcType: ifcClass?.code,
    isTypeDefinition: (parent?.isTypeDefinition ?? false) || isIfcTypeDefinition(node),
  };
}

function hasAnyPointAttr(attrs: ReadonlyMap<string, unknown>): boolean {
  for (const key of POINTCLOUD_ATTR_KEYS) {
    if (attrs.has(key)) return true;
  }
  return false;
}

function getNodeTransform(node: ComposedNode): Float32Array | null {
  const xform = node.attributes.get(ATTR.TRANSFORM) as UsdTransform | undefined;
  return xform?.transform ? flattenMatrix(xform.transform) : null;
}

function combineTransforms(
  nodeTransform: Float32Array | null,
  parentTransform: Float32Array | null
): Float32Array | null {
  if (!nodeTransform) return parentTransform;
  if (!parentTransform) return nodeTransform;
  return multiplyMatrices(nodeTransform, parentTransform);
}

function flattenMatrix(m: number[][]): Float32Array {
  // USD `xformop` matrices use ROW-major layout with the convention
  // `point' = point × M` — translation lives in row 3 (m[3][0..2]).
  // Flattened as result[row*4+col], that puts tx/ty/tz at indices
  // 12/13/14, which is exactly what transformPositionsZUpToYUp reads
  // (`transform[12]` etc.). Don't transpose this — it would break the
  // S1 buildingSMART sample which has its translation specifically in
  // row 3.
  const result = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      result[row * 4 + col] = m[row]?.[col] ?? (row === col ? 1 : 0);
    }
  }
  return result;
}

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

function isIfcTypeDefinition(node: ComposedNode): boolean {
  const customData = node.attributes.get('customdata') as { originalStepInstance?: string } | undefined;
  const originalStepInstance = customData?.originalStepInstance;
  if (typeof originalStepInstance !== 'string') return false;
  return /=[A-Za-z0-9_]*Type\(/i.test(originalStepInstance);
}

function isInvisible(lineage: ComposedNode[]): boolean {
  for (let i = lineage.length - 1; i >= 0; i--) {
    const visibility = lineage[i].attributes.get(ATTR.VISIBILITY) as { visibility?: string } | undefined;
    if (typeof visibility?.visibility === 'string') {
      return visibility.visibility.toLowerCase() === 'invisible';
    }
  }
  return false;
}

// ─── geometry math (z-up → y-up, in-place on the decoded positions) ─────────

function transformPositionsZUpToYUp(positions: Float32Array, transform: Float32Array | null): void {
  // Pre-validate the homogeneous denominator using a representative point
  // (the first one). USD `xformop` matrices are typically affine — w is
  // either 1 (identity-bottom-row) or a rigid-body homogeneous coord — so
  // checking the first point is sufficient to catch a malformed file.
  // Without the guard, a zero-w matrix produces ±Infinity / NaN
  // coordinates and a poisoned bbox.
  if (transform && positions.length >= 3) {
    const x0 = positions[0], y0 = positions[1], z0 = positions[2];
    const w = transform[3] * x0 + transform[7] * y0 + transform[11] * z0 + transform[15];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
      throw new Error(
        'IFCx pointcloud: usd::xformop produces non-finite homogeneous w; ' +
        'matrix is malformed or singular',
      );
    }
  }
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    let wx: number, wy: number, wz: number;
    if (transform) {
      const w = transform[3] * x + transform[7] * y + transform[11] * z + transform[15];
      const invW = 1 / w;
      wx = (transform[0] * x + transform[4] * y + transform[8] * z + transform[12]) * invW;
      wy = (transform[1] * x + transform[5] * y + transform[9] * z + transform[13]) * invW;
      wz = (transform[2] * x + transform[6] * y + transform[10] * z + transform[14]) * invW;
    } else {
      wx = x; wy = y; wz = z;
    }
    positions[i] = wx;
    positions[i + 1] = wz;     // Y-up = Z from Z-up
    positions[i + 2] = -wy;    // Z-back = -Y from Z-up
  }
}

function recomputeBBox(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
