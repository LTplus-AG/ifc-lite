/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carrying the per-entity world AABB (#1891) through federation alignment.
 *
 * `federationAlign.ts` re-bakes a model's vertices into the anchor's frame.
 * `MeshData.geometryAabb` describes those very vertices — it is what lets
 * compare report "Moved · 2.500 m" instead of a bare `Moved` — so it has to
 * make the same trip. Left behind, it feeds the diff engine a pre-alignment
 * box for one side of the comparison: every reported distance is then offset
 * by the alignment, and a wrong-but-plausible number is worse than none.
 *
 * Two things this module exists to get right:
 *
 *  1. **The box is a box, not two points.** The alignment is a rotation about
 *     the vertical axis (the two models' grid norths differ), plus a scale and
 *     a translation. An axis-aligned box cannot be mapped by transforming
 *     `min` and `max`: under rotation that does not even produce a valid box
 *     (`min > max` on the swapped axes). All eight corners go through the map
 *     and the AABB is re-derived from the results. This is the same hazard
 *     `rust/wasm-bindings/src/zero_copy/frame_swap.rs` documents for the
 *     Z-up→Y-up swap, where negating an axis reverses which corner is the min.
 *
 *  2. **The box lives in a different frame from `positions`.** `positions` are
 *     viewer-local (RTC- and shift-relative); the box is ABSOLUTE world with
 *     both folded back in (see `MeshData.geometryAabb`). The alignment maps
 *     viewer-local source → viewer-local reference, so the box's trip is
 *     `subtract the source offset → align → add the reference offset`, which
 *     is also what re-bases it onto the anchor's RTC choice — the anchor's
 *     `CoordinateInfo` is what the aligned model ends up carrying.
 *
 * Which is why an entity that HAS meshes gets its box re-MEASURED from the
 * aligned vertices rather than corner-transformed. Re-boxing a rotated box
 * inflates it — on `Building-Architecture.ifc` aligned to `Infra-Bridge.ifc`
 * (60° between the two grid norths) by up to 0.87 m, against a 1 mm
 * `reshapeTolerance` — so the aligned side would read as `reshaped` against
 * an unaligned side that never lost its tight box. The wasm box is exactly
 * the bounds of the entity's vertices (verified: they agree to 0.000000 m on
 * that model), so re-measuring reproduces the SAME construction in the new
 * frame instead of a conservative envelope of it, and the box cannot drift
 * from its mesh because it is derived from it.
 *
 * The corner transform is what remains for the instanced-only channel, which
 * has no vertices on this side to measure. Its boxes stay conservative under
 * rotation; there is nothing tighter available, and a conservative box in the
 * right frame beats an exact box in the wrong one.
 */

import type { EntityWorldAabb, MeshData } from '@ifc-lite/geometry';

/** Row-major 3×4 affine: a 3×3 linear part plus a translation. */
export interface AffineTransform3D {
  m00: number;
  m01: number;
  m02: number;
  tx: number;
  m10: number;
  m11: number;
  m12: number;
  ty: number;
  m20: number;
  m21: number;
  m22: number;
  tz: number;
}

/**
 * Maps ONE point from the source model's absolute world frame into the
 * reference model's. Returns null when the point could not be mapped (the
 * cross-CRS path's proj4 hop can fail per point).
 */
export type WorldPointMap = (x: number, y: number, z: number) => [number, number, number] | null;

/** A three-component offset in the renderer's Y-up frame. */
export interface YupOffset {
  x: number;
  y: number;
  z: number;
}

/** The subset of `GeometryResult` this module touches. */
export interface AlignableGeometry {
  meshes: MeshData[];
  instancedGeometryAabbs?: Map<number, EntityWorldAabb>;
}

/**
 * Apply an affine to one point.
 *
 * The per-vertex loops in `federationAlign.ts` inline this same arithmetic
 * rather than calling it — they run over every vertex of the model and must
 * not allocate a tuple per vertex. Any change here belongs there too; the
 * `federationAlign.test.ts` cases assert the aligned box against the bounds
 * of the aligned POSITIONS, so the two drifting apart fails the suite.
 */
export function applyAffineTransform(
  t: AffineTransform3D,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    t.m00 * x + t.m01 * y + t.m02 * z + t.tx,
    t.m10 * x + t.m11 * y + t.m12 * z + t.ty,
    t.m20 * x + t.m21 * y + t.m22 * z + t.tz,
  ];
}

/**
 * Lift a viewer-local point map into the absolute world frame the boxes use:
 * strip the source model's RTC/shift, align, then re-apply the reference
 * model's — the offset the aligned geometry inherits.
 */
export function toAbsoluteFrameMap(
  alignViewerLocal: WorldPointMap,
  sourceOffset: YupOffset,
  referenceOffset: YupOffset,
): WorldPointMap {
  return (x, y, z) => {
    const aligned = alignViewerLocal(x - sourceOffset.x, y - sourceOffset.y, z - sourceOffset.z);
    if (!aligned) return null;
    return [
      aligned[0] + referenceOffset.x,
      aligned[1] + referenceOffset.y,
      aligned[2] + referenceOffset.z,
    ];
  };
}

/**
 * Map an axis-aligned world box through `mapPoint` by its eight corners and
 * re-derive the AABB of the results.
 *
 * Returns undefined when the input is not a usable box or when no corner
 * survived the map. Undefined is the engine's documented "no box" state
 * (`EntityFingerprint.aabb`), so dropping it degrades compare to a bare
 * `Moved` — the pre-#1891 behaviour — instead of reporting a wrong distance.
 */
export function transformWorldAabb(
  aabb: EntityWorldAabb,
  mapPoint: WorldPointMap,
): EntityWorldAabb | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let found = false;

  for (let corner = 0; corner < 8; corner += 1) {
    // Bit i of `corner` picks min (0) or max (1) on axis i.
    const x = (corner & 1) === 0 ? aabb.min[0] : aabb.max[0];
    const y = (corner & 2) === 0 ? aabb.min[1] : aabb.max[1];
    const z = (corner & 4) === 0 ? aabb.min[2] : aabb.max[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;

    const mapped = mapPoint(x, y, z);
    if (!mapped) continue;
    if (!Number.isFinite(mapped[0]) || !Number.isFinite(mapped[1]) || !Number.isFinite(mapped[2])) {
      continue;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if (mapped[axis] < min[axis]) min[axis] = mapped[axis];
      if (mapped[axis] > max[axis]) max[axis] = mapped[axis];
    }
    found = true;
  }

  return found ? { min, max } : undefined;
}

/**
 * Running world bounds for one entity, accumulated across its submeshes:
 * `[minX, minY, minZ, maxX, maxY, maxZ]`. A flat array rather than an
 * `EntityWorldAabb` because it is written per vertex.
 */
export type EntityBoundsAccumulator = [number, number, number, number, number, number];

/** Get (or start) the running bounds for one entity. */
export function entityBoundsFor(
  accumulators: Map<number, EntityBoundsAccumulator>,
  expressId: number,
): EntityBoundsAccumulator {
  let box = accumulators.get(expressId);
  if (!box) {
    box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    accumulators.set(expressId, box);
  }
  return box;
}

/** Extend running bounds by one aligned vertex (viewer-local, reference frame). */
export function extendEntityBounds(
  box: EntityBoundsAccumulator,
  x: number,
  y: number,
  z: number,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < box[0]) box[0] = x;
  if (y < box[1]) box[1] = y;
  if (z < box[2]) box[2] = z;
  if (x > box[3]) box[3] = x;
  if (y > box[4]) box[4] = y;
  if (z > box[5]) box[5] = z;
}

/**
 * Close the running bounds into absolute-frame boxes by folding in the
 * reference model's offset — the frame `geometryAabb` is contracted to be in,
 * and the offset the aligned model now carries. Entities that accumulated no
 * finite vertex are dropped.
 */
export function finishEntityBounds(
  accumulators: Map<number, EntityBoundsAccumulator>,
  referenceOffset: YupOffset,
): Map<number, EntityWorldAabb> {
  const out = new Map<number, EntityWorldAabb>();
  const o = [referenceOffset.x, referenceOffset.y, referenceOffset.z];
  for (const [expressId, box] of accumulators) {
    if (box[0] > box[3]) continue;
    out.set(expressId, {
      min: [box[0] + o[0], box[1] + o[1], box[2] + o[2]],
      max: [box[3] + o[0], box[4] + o[1], box[5] + o[2]],
    });
  }
  return out;
}

/**
 * Re-frame every world box the model carries: the per-entity boxes on the
 * meshes, and the instanced-only side channel.
 *
 * A meshed entity takes its box from `measured` — the bounds of its own
 * vertices as the alignment just wrote them — or LOSES its box if it is not
 * there. It never falls back to the corner transform, which is exclusively for
 * the instanced-only channel (no vertices on this side to measure).
 *
 * That is deliberate, and it is what makes a partly-aligned entity honest. The
 * cross-CRS path maps vertex by vertex and proj4 answers `Infinity` for a point
 * outside the target projection's domain, so one outlying vertex can be left in
 * the source frame while its neighbours move. The entity's mesh then spans two
 * coordinate frames and NO box describes it: a measured box would cover only
 * the part that moved, and a corner-transformed one would assert a position for
 * geometry that is not there. Dropping it degrades the diff to its documented
 * bare `moved` — no distance rather than a confident wrong one.
 *
 * Boxes are REPLACED, never mutated: all submeshes of one entity share a
 * single box object off the wasm pass, so an in-place transform would be
 * applied once per submesh. Each distinct source box is mapped once and the
 * result shared, keyed on object identity.
 *
 * An entity that arrived without a box does not gain one — absent is the
 * engine's "the pass produced nothing here", and inventing a box from meshes
 * the hasher declined to fingerprint would be a claim this code cannot make.
 */
export function alignEntityWorldAabbs(
  geometry: AlignableGeometry,
  mapPoint: WorldPointMap,
  measured: ReadonlyMap<number, EntityWorldAabb>,
): void {
  const mapped = new Map<EntityWorldAabb, EntityWorldAabb | undefined>();
  const convert = (box: EntityWorldAabb): EntityWorldAabb | undefined => {
    if (!mapped.has(box)) mapped.set(box, transformWorldAabb(box, mapPoint));
    return mapped.get(box);
  };

  for (const mesh of geometry.meshes) {
    const box = mesh.geometryAabb;
    if (!box) continue;
    const next = measured.get(mesh.expressId);
    if (next) mesh.geometryAabb = next;
    else delete mesh.geometryAabb;
  }

  const instanced = geometry.instancedGeometryAabbs;
  if (instanced && instanced.size > 0) {
    const next = new Map<number, EntityWorldAabb>();
    for (const [expressId, box] of instanced) {
      const aligned = convert(box);
      if (aligned) next.set(expressId, aligned);
    }
    geometry.instancedGeometryAabbs = next;
  }
}
