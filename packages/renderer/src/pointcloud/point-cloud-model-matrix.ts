/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Its own module so CPU ray queries (part of `@ifc-lite/renderer/core`) can
// validate an asset matrix without loading the point-cloud node/GPU module.

/**
 * True when `model` is a usable 4x4: exactly 16 entries, all finite.
 *
 * Single-sourced so the two consumers of `PointCloudNode.model` — the AABB
 * fold (`transformAabb`, point-cloud-node.ts) and `writePointCloudUniforms`'
 * GPU write — accept exactly the same matrices. When they disagree, a
 * matrix one accepts and the other rejects puts the reported bounds in a
 * different frame from the rendered points, which is the precise failure this transform exists to prevent.
 * The finiteness check matters because a single NaN propagates to every
 * corner of the box (and to every point on the GPU), so a degenerate matrix
 * must fall back to identity rather than poison the result.
 */
export function isUsableModelMatrix(
  model: Float32Array | Float64Array | undefined,
): model is Float32Array | Float64Array {
  if (!model || model.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(model[i])) return false;
  }
  return true;
}
