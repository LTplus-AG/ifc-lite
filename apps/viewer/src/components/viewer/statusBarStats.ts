/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StatusBar's "N elements" stat: count actual entities, where a color-merged
 * mesh's `entityIds` may fold several IFC entities into one draw call — count
 * the UNIQUE entity ids within that mesh (not 1 per mesh), and a mesh with no
 * `entityIds` (unmerged / non-entity geometry) counts as 1.
 *
 * Deduplication is PER MESH, not global: if the same entity id appears in two
 * different meshes, each mesh's local `Set` counts it once, so it is counted
 * twice in the total. This mirrors the original implementation exactly —
 * there is no cross-mesh identity tracking to preserve or violate.
 *
 * `computeStatsFull` is the reference full-rescan implementation (kept for
 * equivalence tests). `createStatusBarStatsAccumulator` is the incremental
 * version used by StatusBar: during streaming, `geometryResult` is a NEW
 * object on every batch commit but `geometryResult.meshes` is the SAME array
 * reference mutated in place (`appendGeometryBatch` in dataSlice.ts pushes
 * onto the existing array) — except on the very first batch, and on any
 * operation that legitimately rebuilds the array (a full file (re)load, or
 * `updateMeshColors`, which `.map()`s to a new array). The accumulator keys
 * off that array identity plus a scanned-length counter, so it only visits
 * meshes appended since the last call — see `ViewportContainer.tsx`'s
 * `hasTypeGeometry` / `filteredGeometry` for the same established pattern.
 */

export interface StatusBarStats {
  elements: number;
  triangles: number;
}

export interface StatusBarGeometryResult {
  meshes?: readonly { entityIds?: Uint32Array } [] | null;
  totalTriangles?: number;
}

/** Reference implementation: full O(meshes + Σ entityIds) rescan on every call. */
export function computeStatsFull(geometryResult: StatusBarGeometryResult | null): StatusBarStats {
  if (!geometryResult) {
    return { elements: 0, triangles: 0 };
  }
  let elements = 0;
  const meshes = geometryResult.meshes;
  if (meshes) {
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (m.entityIds && m.entityIds.length > 0) {
        const seen = new Set<number>();
        for (let j = 0; j < m.entityIds.length; j++) seen.add(m.entityIds[j]);
        elements += seen.size;
      } else {
        elements += 1;
      }
    }
  }
  return {
    elements,
    triangles: geometryResult.totalTriangles ?? 0,
  };
}

export interface StatusBarStatsAccumulator {
  /** Fold any meshes appended since the last call (by array identity + length)
   *  into the running element count, then return the current stats. */
  update(geometryResult: StatusBarGeometryResult | null): StatusBarStats;
  /** Drop cached state. `update()` also self-resets on array-identity or
   *  length-shrink changes, so this is not required for correctness. */
  reset(): void;
}

export function createStatusBarStatsAccumulator(): StatusBarStatsAccumulator {
  let sourceRef: StatusBarGeometryResult['meshes'] | null = null;
  let scannedLen = 0;
  let elements = 0;

  function resetState(): void {
    sourceRef = null;
    scannedLen = 0;
    elements = 0;
  }

  function update(geometryResult: StatusBarGeometryResult | null): StatusBarStats {
    if (!geometryResult) {
      resetState();
      return { elements: 0, triangles: 0 };
    }
    const meshes = geometryResult.meshes;
    if (!meshes) {
      resetState();
      return { elements: 0, triangles: geometryResult.totalTriangles ?? 0 };
    }

    // New source array, or it shrank (new file / replace / recolor rebuild)
    // → recount from scratch.
    if (sourceRef !== meshes || meshes.length < scannedLen) {
      resetState();
      sourceRef = meshes;
    }

    for (let i = scannedLen; i < meshes.length; i++) {
      const m = meshes[i];
      if (m.entityIds && m.entityIds.length > 0) {
        const seen = new Set<number>();
        for (let j = 0; j < m.entityIds.length; j++) seen.add(m.entityIds[j]);
        elements += seen.size;
      } else {
        elements += 1;
      }
    }
    scannedLen = meshes.length;

    return { elements, triangles: geometryResult.totalTriangles ?? 0 };
  }

  return { update, reset: resetState };
}
