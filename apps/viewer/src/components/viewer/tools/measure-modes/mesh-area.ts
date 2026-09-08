/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sum a `MeshData`'s triangulated surface area — the "mesh analysis reachable
 * from TypeScript" prerequisite issue #2199 names for element surface area,
 * geometry-face area and coplanar-face area alike.
 *
 * `positions`/`indices` are already on every `MeshData` (`packages/geometry/
 * src/types.ts`); what was missing was a reusable triangle-area primitive —
 * `triangleArea` existed only inside `@ifc-lite/clash`'s contact solver and
 * was not re-exported from that package's public surface (packages/clash/src/
 * index.ts). This module is the other half: read one mesh's positions in
 * triples, hand each to the now-exported `triangleArea`, sum.
 *
 * WebGL Y-up metres, same frame as `MeshData.positions` — so the result is
 * already SI square metres, exactly like `MeshData.geometryVolume` is already
 * SI cubic metres. No unit conversion happens here; callers still run the
 * total through `resolveQuantityDisplay`/`convertValue` for display, same as
 * every other quantity in this panel.
 */

import { triangleArea, type Triangle } from '@ifc-lite/clash';

export interface MeshLike {
  /**
   * Absent for a mesh record that carries no render geometry (e.g. a test
   * double, or a future metadata-only piece) — treated as "no triangles to
   * measure", never as a crash. A real `MeshData` off the wasm pipeline
   * always has both.
   */
  readonly positions?: ArrayLike<number>;
  readonly indices?: ArrayLike<number>;
}

function readVertex(positions: ArrayLike<number>, index: number): [number, number, number] {
  const b = index * 3;
  return [positions[b] as number, positions[b + 1] as number, positions[b + 2] as number];
}

/** Whether `index` addresses a real vertex in a `positions` array of `vertexCount` vertices. */
function isValidVertexIndex(index: number, vertexCount: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < vertexCount;
}

/**
 * {@link meshSurfaceArea}'s result, distinguishing a fully-summed area from
 * one assembled out of only the triangles that were safe to read.
 */
export interface MeshSurfaceAreaResult {
  /** Sum of every triangle whose three vertex indices were in bounds. */
  area: number;
  /**
   * `false` when at least one triangle referenced a vertex index outside
   * `positions` and was skipped. `area` is then a partial total (a lower
   * bound assembled from the mesh's other, valid triangles) rather than the
   * piece's true surface area — callers must not present it as complete.
   */
  complete: boolean;
}

/**
 * Sum of every triangle's area in one mesh piece, bounds-checked per vertex
 * index.
 *
 * This is the TOTAL triangulated surface of the piece — every face, not one
 * side — so it must never be presented as a `NetSideArea`/`GrossSideArea`
 * equivalent. Degenerate triangles (duplicate/collinear vertices) contribute
 * ~0 by construction (`triangleArea` = half the cross-product magnitude), so
 * they need no special-casing here.
 *
 * A triangle whose vertex index falls outside `positions` (malformed mesh
 * data) is skipped rather than read out of bounds — an out-of-range read on a
 * plain array returns `undefined`, and `undefined - undefined` is `NaN`,
 * which would silently poison every other triangle's contribution to this
 * piece's total (and, one level up, every sibling submesh's contribution to
 * the whole occurrence's total — see `collectMeshAreas`). `complete` reports
 * whether that happened so a caller can decide how to present a partial sum,
 * instead of the caller only ever seeing a single opaque number.
 */
export function meshSurfaceAreaDetailed(mesh: MeshLike): MeshSurfaceAreaResult {
  const indices = mesh.indices;
  if (!indices || !mesh.positions) return { area: 0, complete: true };
  const vertexCount = mesh.positions.length / 3;
  const triCount = Math.floor(indices.length / 3);
  let total = 0;
  let complete = true;
  for (let i = 0; i < triCount; i++) {
    const i0 = indices[i * 3] as number;
    const i1 = indices[i * 3 + 1] as number;
    const i2 = indices[i * 3 + 2] as number;
    if (
      !isValidVertexIndex(i0, vertexCount)
      || !isValidVertexIndex(i1, vertexCount)
      || !isValidVertexIndex(i2, vertexCount)
    ) {
      complete = false;
      continue;
    }
    const t: Triangle = {
      v0: readVertex(mesh.positions, i0),
      v1: readVertex(mesh.positions, i1),
      v2: readVertex(mesh.positions, i2),
    };
    total += triangleArea(t);
  }
  return { area: total, complete };
}

/**
 * Sum of every triangle's area in one mesh piece — the plain-number
 * convenience wrapper around {@link meshSurfaceAreaDetailed} for callers that
 * only need the value, not the completeness flag.
 */
export function meshSurfaceArea(mesh: MeshLike): number {
  return meshSurfaceAreaDetailed(mesh).area;
}

/** One `MeshData` piece as `collectMeshAreas` needs to see it. */
export interface MeshAreaRecord extends MeshLike {
  readonly expressId: number;
  readonly occurrenceKey?: string;
}

/** One occurrence's (or, absent `occurrenceKey`, one entity's) summed mesh area. */
export interface MeshAreaEntry {
  /**
   * Sum of the occurrence's submesh areas. A partial total when
   * `incomplete` is `true` — the good submeshes' contribution, not
   * discarded, but not the whole story either.
   */
  area: number;
  /**
   * `true` when at least one submesh in this occurrence had an
   * out-of-range vertex index and was only partially summed
   * (`meshSurfaceAreaDetailed`'s `complete: false`). The occurrence's siblings
   * still contribute their full area — one corrupt piece does not zero the
   * group — but the total is not to be presented as a complete measurement.
   */
  incomplete: boolean;
}

/**
 * Group a model's mesh pieces by occurrence and sum each occurrence's
 * triangulated area — issue #2199's mesh-area collection, extracted here so
 * it is a pure function of mesh data alone. It takes no `IfcDataStore` and no
 * store-derived state, which is not an implementation detail: mesh area has
 * no store dependency (unlike declared quantities), and keeping the function
 * signature store-free makes it structurally impossible for a future
 * store-related early return elsewhere to end up gating this collection, the
 * way the mesh-area *lookup* in `MeasureQuantities.tsx` once did (adversarial
 * review of 85ebf7d1).
 *
 * One entity can be split across several `MeshData` pieces (materials,
 * instanced occurrences). Pieces are grouped by `occurrenceKey` (falling back
 * to `expressId` when absent, per that field's own cache-key contract) and
 * summed WITHIN a group — that is genuinely one occurrence's area split
 * across pieces. Area is placement-invariant, so every occurrence of the same
 * `expressId` has the identical total; only the first group seen per
 * `expressId` is kept.
 *
 * A mesh record with fewer than 3 indices (including the empty-array case,
 * `indices: []`) never attempted a real triangulation and is skipped before a
 * group is even created for it — it must not read as "measured, 0 m²",
 * which would claim a triangulated result where none was produced. A record
 * whose indices DO triangulate to a genuine zero-area result (e.g. every
 * triangle degenerate) still reports that zero as measured, which is a
 * different, true claim.
 */
export function collectMeshAreas(
  meshLists: Iterable<ReadonlyArray<MeshAreaRecord> | undefined>,
  target: Map<number, MeshAreaEntry> = new Map(),
): Map<number, MeshAreaEntry> {
  for (const meshes of meshLists) {
    if (!meshes) continue;
    const groupAreas = new Map<string, { expressId: number; area: number; incomplete: boolean }>();
    for (const mesh of meshes) {
      // A mesh record with no render geometry (metadata-only piece, or a test
      // double built for a different field) or fewer than one triangle's
      // worth of indices has nothing to sum — skip it entirely rather than
      // seed a false "measured, 0 m²" group for an entity whose OTHER pieces
      // might still carry real geometry, or whose only piece never
      // triangulated at all.
      if (!mesh.positions || !mesh.indices || mesh.indices.length < 3) continue;
      const groupKey = mesh.occurrenceKey ?? `e:${mesh.expressId}`;
      let group = groupAreas.get(groupKey);
      if (!group) {
        group = { expressId: mesh.expressId, area: 0, incomplete: false };
        groupAreas.set(groupKey, group);
      }
      const result = meshSurfaceAreaDetailed(mesh);
      group.area += result.area;
      if (!result.complete) group.incomplete = true;
    }
    for (const group of groupAreas.values()) {
      if (!target.has(group.expressId)) {
        target.set(group.expressId, { area: group.area, incomplete: group.incomplete });
      }
    }
  }
  return target;
}
