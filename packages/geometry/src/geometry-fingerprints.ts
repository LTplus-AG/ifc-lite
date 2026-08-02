/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read the per-entity geometry fingerprints off a WASM `MeshCollection`
 * (issues #924 / #1891).
 *
 * ONE reader for both mesh-extraction paths — the single-threaded converter in
 * `geometry-coordinate.ts` and the worker's `collectMeshes` — because the
 * arrays are index-parallel and a second copy of the indexing arithmetic is a
 * second place for the box and the hash to drift onto different entities.
 *
 * The wasm contract (`rust/wasm-bindings/src/zero_copy/mesh_fingerprint.rs`):
 * `geometryHashIds[i]` ↔ `geometryHashValues[i]` ↔
 * `geometryAabbValues[6*i .. 6*i+6)`. Every array is empty unless hashing was
 * enabled via `IfcAPI.setComputeGeometryHashes`, and a build predating a getter
 * simply omits it — both degrade to "less information", never to a throw.
 */

import type { EntityWorldAabb } from './types.js';

/** Number of `f64` per box in `geometryAabbValues`: min xyz then max xyz. */
const AABB_STRIDE = 6;

/**
 * The fingerprint getters, structurally. Typed here rather than taken as a
 * `MeshCollection` because the two call sites hold two different nominal types
 * for the same wasm object, and because every field is optional on an older
 * wasm build — which is precisely what this module is here to absorb.
 */
export interface GeometryFingerprintSource {
  geometryHashCount?: number;
  geometryHashIds?: Uint32Array;
  geometryHashValues?: BigUint64Array;
  geometryAabbValues?: Float64Array;
}

/** Everything one hashing pass learned about one entity. */
export interface EntityGeometryFingerprint {
  /** The RTC-invariant whole-entity shape hash (#924). */
  hash: bigint;
  /**
   * Absolute world bounding box in the renderer's Y-up frame, or `undefined`
   * when the pass produced none. The wasm side reserves six `NaN` slots for an
   * absent box so the arrays stay index-parallel; that sentinel is resolved to
   * `undefined` HERE, at the boundary, so nothing downstream ever has to ask
   * whether a box it holds is real (`@ifc-lite/diff`'s contract is that a
   * missing box is absent, not NaN-bearing).
   */
  aabb?: EntityWorldAabb;
}

/**
 * Read entry `index` of a six-values-per-id `Float64Array` as a box, or
 * `undefined` when the span is the absent sentinel (or the array is too short
 * to hold it).
 *
 * ONE guard covers both, deliberately: any non-finite component disqualifies
 * the whole box, and an out-of-range typed-array read yields `undefined`, which
 * is not finite. A separate length check would be unreachable — it can never be
 * the reason a call returns `undefined`, so nothing could ever prove it works.
 * Half a box is not a usable box anyway: `isUsableAabb` in `@ifc-lite/diff`
 * would reject it, so better to never build it.
 *
 * Exported because the same layout crosses the geometry worker boundary as
 * `instancedGeometryAabbValues` (the entities that never reach the flat mesh
 * array), and a consumer decoding that by hand is a second copy of this
 * indexing arithmetic.
 */
export function geometryAabbAt(
  values: Float64Array | undefined,
  index: number,
): EntityWorldAabb | undefined {
  if (!values) return undefined;
  const base = index * AABB_STRIDE;
  for (let k = 0; k < AABB_STRIDE; k++) {
    if (!Number.isFinite(values[base + k])) return undefined;
  }
  return {
    min: [values[base], values[base + 1], values[base + 2]],
    max: [values[base + 3], values[base + 4], values[base + 5]],
  };
}

/**
 * Inverse of {@link geometryAabbAt}: write `aabb` into entry `index` of a
 * six-values-per-id `Float64Array`.
 *
 * Paired with the reader here, in one module, because the worker encodes the
 * instanced-only side-channel and the main thread decodes it: a min/max or
 * stride disagreement between the two ends is invisible in either half alone
 * and shows up only as boxes attributed to the wrong element.
 */
export function writeGeometryAabbAt(
  values: Float64Array,
  index: number,
  aabb: EntityWorldAabb,
): void {
  const base = index * AABB_STRIDE;
  values.set(aabb.min, base);
  values.set(aabb.max, base + 3);
}

/**
 * Per-entity geometry fingerprints keyed by express id.
 *
 * Empty when hashing is off or the wasm build predates the getters. Must be
 * called BEFORE `collection.free()`. The result holds plain JS values, so it
 * outlives the collection and survives a structured-clone `postMessage`.
 */
export function extractGeometryFingerprints(
  source: GeometryFingerprintSource,
): Map<number, EntityGeometryFingerprint> {
  const map = new Map<number, EntityGeometryFingerprint>();
  // Fast path, not a correctness guard: the checks below already yield an empty
  // map when hashing is off. It is here so a load with the diff feature OFF —
  // the default — never touches the three copy-to-JS getters at all, and those
  // are read once per batch, thousands of times per model.
  if ((source.geometryHashCount ?? 0) === 0) return map;

  const ids = source.geometryHashIds;
  const values = source.geometryHashValues;
  if (!ids || !values) return map;

  // Read the copy-to-JS getter ONCE: each access copies a fresh Float64Array
  // out of wasm, so indexing the getter per entity would copy the whole array
  // once per entity. Absent on a wasm build predating #1988 → no boxes, hashes
  // still land, and the diff falls back to its documented bare `moved`.
  const aabbValues = source.geometryAabbValues;

  const n = Math.min(ids.length, values.length);
  for (let i = 0; i < n; i++) {
    const aabb = geometryAabbAt(aabbValues, i);
    map.set(ids[i], aabb ? { hash: values[i], aabb } : { hash: values[i] });
  }
  return map;
}
