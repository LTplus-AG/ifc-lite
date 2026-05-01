/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compute shader for BIM ↔ scan deviation.
 *
 * For each scan point, walk a per-triangle BVH and compute the signed
 * distance to the nearest mesh surface. Sign is positive on the side
 * the triangle's outward normal points to.
 *
 * Bind group layout:
 *   @binding(0) bvhNodes: array<vec4<f32>, 2>   — 32-byte nodes (read)
 *                                                 packed: [aabbMin, leafOrLeft]
 *                                                         [aabbMax, leafOrRight]
 *   @binding(1) triangles: array<f32>           — 12 floats per triangle
 *   @binding(2) positions: array<f32>           — 6 floats per point
 *                                                 (matches POINT_VERTEX_BYTES
 *                                                  layout: vec3 + colorPacked)
 *   @binding(3) deviations: array<f32>          — output, one float per point
 *   @binding(4) params: DeviationParams
 *
 * Workgroup size 64 (one wavefront / warp on most desktop GPUs).
 * Each invocation processes one point.
 */

export const deviationShaderSource = /* wgsl */ `
struct BvhNode {
  aabbMinX: f32, aabbMinY: f32, aabbMinZ: f32,
  // High bit: leaf flag. Low 31 bits: leaf=triStart, internal=leftChildIdx.
  leafOrLeft: u32,
  aabbMaxX: f32, aabbMaxY: f32, aabbMaxZ: f32,
  // Leaf=triCount, internal=rightChildIdx.
  countOrRight: u32,
}

struct DeviationParams {
  pointCount: u32,
  pointStrideF32: u32,    // floats between successive points in positions buffer
  positionOffsetF32: u32, // float offset of vec3 position within a point
  // Optional clip range — when nonzero, signs above + below are kept
  // but values past ±maxRange are clamped (saves shader work for
  // points far outside the model).
  maxRange: f32,
  // Reserved padding to keep the struct 16-byte aligned for std140.
  _pad0: u32, _pad1: u32, _pad2: u32, _pad3: u32,
}

@group(0) @binding(0) var<storage, read> bvhNodes: array<BvhNode>;
@group(0) @binding(1) var<storage, read> triangles: array<f32>;
@group(0) @binding(2) var<storage, read> positions: array<f32>;
@group(0) @binding(3) var<storage, read_write> deviations: array<f32>;
@group(0) @binding(4) var<uniform> params: DeviationParams;

const LEAF_FLAG: u32 = 0x80000000u;
const STACK_SIZE: u32 = 64u;

// Squared distance from point p to AABB [aabbMin, aabbMax].
// Returns 0 if p is inside the box.
fn distSqPointAabb(
  px: f32, py: f32, pz: f32,
  ax: f32, ay: f32, az: f32,
  bx: f32, by: f32, bz: f32,
) -> f32 {
  let dx = max(max(ax - px, 0.0), px - bx);
  let dy = max(max(ay - py, 0.0), py - by);
  let dz = max(max(az - pz, 0.0), pz - bz);
  return dx * dx + dy * dy + dz * dz;
}

struct ClosestResult {
  point: vec3<f32>,
  distSq: f32,
}

// Ericson, Real-Time Collision Detection §5.1.5: closest point on
// a triangle to an arbitrary point in space. Branches over the
// Voronoi regions of the triangle (3 verts, 3 edges, interior).
fn closestPointOnTriangle(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> ClosestResult {
  let ab = b - a;
  let ac = c - a;
  let ap = p - a;
  let d1 = dot(ab, ap);
  let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) {
    let diff = p - a;
    return ClosestResult(a, dot(diff, diff));
  }
  let bp = p - b;
  let d3 = dot(ab, bp);
  let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) {
    let diff = p - b;
    return ClosestResult(b, dot(diff, diff));
  }
  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    let v = d1 / (d1 - d3);
    let q = a + v * ab;
    let diff = p - q;
    return ClosestResult(q, dot(diff, diff));
  }
  let cp = p - c;
  let d5 = dot(ab, cp);
  let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) {
    let diff = p - c;
    return ClosestResult(c, dot(diff, diff));
  }
  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    let w = d2 / (d2 - d6);
    let q = a + w * ac;
    let diff = p - q;
    return ClosestResult(q, dot(diff, diff));
  }
  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
    let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    let q = b + w * (c - b);
    let diff = p - q;
    return ClosestResult(q, dot(diff, diff));
  }
  // Inside the face: barycentric (v, w).
  let denom = 1.0 / (va + vb + vc);
  let v = vb * denom;
  let w = vc * denom;
  let q = a + ab * v + ac * w;
  let diff = p - q;
  return ClosestResult(q, dot(diff, diff));
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pi = gid.x;
  if (pi >= params.pointCount) {
    return;
  }
  let posOff = pi * params.pointStrideF32 + params.positionOffsetF32;
  let p = vec3<f32>(positions[posOff], positions[posOff + 1u], positions[posOff + 2u]);

  // Best squared distance across all triangles. Stored squared so
  // we can prune AABBs without taking sqrt every step.
  var bestDistSq: f32 = 1.0e30;
  var bestPoint: vec3<f32> = vec3<f32>(0.0);
  var bestNormal: vec3<f32> = vec3<f32>(0.0, 1.0, 0.0);

  // Stack-based BVH descent. Workgroup-uniform stack would let
  // siblings cooperate; for v1 a per-thread stack in private memory
  // is simpler and fast enough.
  var stack: array<u32, STACK_SIZE>;
  var sp: u32 = 0u;
  stack[sp] = 0u;
  sp = sp + 1u;

  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let nodeIdx = stack[sp];
    let node = bvhNodes[nodeIdx];

    let aabbDistSq = distSqPointAabb(
      p.x, p.y, p.z,
      node.aabbMinX, node.aabbMinY, node.aabbMinZ,
      node.aabbMaxX, node.aabbMaxY, node.aabbMaxZ,
    );
    if (aabbDistSq >= bestDistSq) {
      continue;
    }

    let leafFlag = node.leafOrLeft & LEAF_FLAG;
    if (leafFlag != 0u) {
      let triStart = node.leafOrLeft & (~LEAF_FLAG);
      let triCount = node.countOrRight;
      var i: u32 = 0u;
      loop {
        if (i >= triCount) { break; }
        let triOff = (triStart + i) * 12u;
        let v0 = vec3<f32>(triangles[triOff],      triangles[triOff + 1u],  triangles[triOff + 2u]);
        let v1 = vec3<f32>(triangles[triOff + 3u], triangles[triOff + 4u],  triangles[triOff + 5u]);
        let v2 = vec3<f32>(triangles[triOff + 6u], triangles[triOff + 7u],  triangles[triOff + 8u]);
        let n  = vec3<f32>(triangles[triOff + 9u], triangles[triOff + 10u], triangles[triOff + 11u]);
        let res = closestPointOnTriangle(p, v0, v1, v2);
        if (res.distSq < bestDistSq) {
          bestDistSq = res.distSq;
          bestPoint = res.point;
          bestNormal = n;
        }
        i = i + 1u;
      }
    } else {
      // Internal node: push both children. Sibling that's closer to
      // p first (top of stack) so we hit the tighter bound earlier.
      let leftIdx = node.leafOrLeft;
      let rightIdx = node.countOrRight;
      let lNode = bvhNodes[leftIdx];
      let rNode = bvhNodes[rightIdx];
      let lDist = distSqPointAabb(
        p.x, p.y, p.z,
        lNode.aabbMinX, lNode.aabbMinY, lNode.aabbMinZ,
        lNode.aabbMaxX, lNode.aabbMaxY, lNode.aabbMaxZ,
      );
      let rDist = distSqPointAabb(
        p.x, p.y, p.z,
        rNode.aabbMinX, rNode.aabbMinY, rNode.aabbMinZ,
        rNode.aabbMaxX, rNode.aabbMaxY, rNode.aabbMaxZ,
      );
      // Push the farther child first → closer popped first.
      if (sp + 2u <= STACK_SIZE) {
        if (lDist < rDist) {
          stack[sp] = rightIdx; sp = sp + 1u;
          stack[sp] = leftIdx;  sp = sp + 1u;
        } else {
          stack[sp] = leftIdx;  sp = sp + 1u;
          stack[sp] = rightIdx; sp = sp + 1u;
        }
      }
    }
  }

  // Signed distance: project (p - closestPoint) onto the closest
  // triangle's normal. Positive ⇒ p is on the outward side.
  let toPoint = p - bestPoint;
  let dist = sqrt(bestDistSq);
  let s = sign(dot(toPoint, bestNormal));
  var signed: f32 = s * dist;

  // Optional clip: keeps the histogram + ramp focused on near-surface
  // points. Past ±maxRange the value pegs at the edge.
  if (params.maxRange > 0.0) {
    let mr = params.maxRange;
    if (signed > mr) { signed = mr; }
    if (signed < -mr) { signed = -mr; }
  }

  deviations[pi] = signed;
}
`;
