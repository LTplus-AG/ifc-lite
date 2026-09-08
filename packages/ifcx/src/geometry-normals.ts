/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compute the normal-transform matrix for a local-to-world affine
 * transform: the inverse-transpose of its upper-left 3x3 linear part.
 *
 * Positions transform as `v' = v * M` (row vector, M row-major — see
 * `applyTransform`/`combineTransforms` in geometry-extractor.ts). Under
 * that convention, a vector `e` tangent to the surface (an edge)
 * transforms as `e' = e * M`, and the transformed normal `n'` must satisfy
 * `n' . e' = 0` whenever `n . e = 0`. Substituting shows
 * `n' = n * inverse(M)^T`, which reduces to `n' = n * M` only when M is
 * orthogonal (M^-1 = M^T) — true for pure rotation, false under
 * non-uniform scale or shear (a real `usd::xformop` shape: see
 * `tests/models/ifc5/Tunnel_Excavation_07_Invert.ifcx`).
 *
 * `inverse(M)^T` equals `cofactor(M) / det(M)` (the adjugate is
 * `cofactor(M)^T`, so its transpose is `cofactor(M)` again), so this
 * returns the cofactor matrix scaled by `1/det`, flattened row-major.
 * Returns null for a singular or non-finite linear part (degenerate
 * transform; callers fall back to the untransformed normal).
 */
export function computeNormalMatrix(m: Float32Array): Float32Array | null {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];

  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);

  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;

  const result = new Float32Array(9);
  result[0] = (a11 * a22 - a12 * a21) * invDet;
  result[1] = -(a10 * a22 - a12 * a20) * invDet;
  result[2] = (a10 * a21 - a11 * a20) * invDet;
  result[3] = -(a01 * a22 - a02 * a21) * invDet;
  result[4] = (a00 * a22 - a02 * a20) * invDet;
  result[5] = -(a00 * a21 - a01 * a20) * invDet;
  result[6] = (a01 * a12 - a02 * a11) * invDet;
  result[7] = -(a00 * a12 - a02 * a10) * invDet;
  result[8] = (a00 * a11 - a01 * a10) * invDet;
  return result;
}

/**
 * Compute per-vertex normals from a triangle mesh by accumulating each
 * triangle's face normal (cross product of its edges) at its three
 * vertices, then normalizing. Used when a `usd::usdgeom::mesh` node omits
 * explicit `normals`.
 */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
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
