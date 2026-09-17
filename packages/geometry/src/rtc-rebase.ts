/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-basing an already-loaded model's meshes onto a different RTC anchor
 * (#4897).
 *
 * A model with small coordinates gets no `wasmRtcOffset` at load, and is
 * meshed raw (render frame == world frame, IFC axes swapped to Y-up). When a
 * LATER model in the same federation turns out to need a real RTC anchor,
 * that anchor becomes the federation's shared frame (`chooseSharedRtcOffset`,
 * `world-frame.ts`) — so every model meshed before it arrived, in the raw
 * frame, has to move into that anchor too, or it renders in a frame nothing
 * else shares.
 *
 * This is a plain axis-aligned translation, not a CRS reprojection: both
 * anchors are metres in the same IFC axes, so there is no rotation or unit
 * conversion to apply — unlike `federationAlign.ts`'s georeference
 * re-basing, which the models here may have neither of (this repo's own
 * repro has no `IfcMapConversion` at all).
 */

import type { AABB, CoordinateInfo, Vec3 } from './coordinate-types.js';
import { GEOM_CLASS_INSTANCED_TYPE, geometryClassOf } from './geometry-class.js';
import { ifcToViewerAxes } from './world-frame.js';

const ZERO: Readonly<Vec3> = { x: 0, y: 0, z: 0 };

/**
 * The render-frame (Y-up) translation to apply to a mesh already produced
 * against `fromOffset` (IFC Z-up, absent means the zero/raw frame) so it
 * reads as if it had been produced against `toOffset` instead.
 *
 * Render-frame positions are `world - offset` (Y-up), so moving the anchor
 * from `fromOffset` to `toOffset` requires SUBTRACTING the increase, i.e.
 * translating positions by `-(toYup - fromYup)` — see
 * {@link rebasePositionsToRtcOffset}, which applies this in place.
 */
export function rtcRebaseDeltaYup(
  fromOffset: Readonly<Vec3> | null | undefined,
  toOffset: Readonly<Vec3>,
): Vec3 {
  const fromYup = ifcToViewerAxes(fromOffset ?? ZERO);
  const toYup = ifcToViewerAxes(toOffset);
  return {
    x: toYup.x - fromYup.x,
    y: toYup.y - fromYup.y,
    z: toYup.z - fromYup.z,
  };
}

/**
 * Re-base one mesh's positions, in place, from `fromOffset`'s render frame
 * to `toOffset`'s. A no-op (still iterates, but subtracts zero) when the two
 * anchors resolve to the same render-frame delta.
 */
export function rebasePositionsToRtcOffset(
  positions: Float32Array,
  fromOffset: Readonly<Vec3> | null | undefined,
  toOffset: Readonly<Vec3>,
): void {
  const delta = rtcRebaseDeltaYup(fromOffset, toOffset);
  if (delta.x === 0 && delta.y === 0 && delta.z === 0) return;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    positions[i] -= delta.x;
    positions[i + 1] -= delta.y;
    positions[i + 2] -= delta.z;
  }
}

/**
 * The same translation {@link rebasePositionsToRtcOffset} applies to
 * positions, applied to one render-frame box: `min` and `max` each move by
 * `-delta`.
 *
 * Shifting the two corners component-wise is sound ONLY because this is a
 * pure axis-aligned translation — every corner of the box moves by the same
 * vector, so the corner that was the minimum along an axis still is. The
 * general rule for re-framing a box is to transform its EIGHT corners and
 * re-derive min/max (`swap_zup_to_yup_aabb` in the wasm bindings does that,
 * and so does the model-rotation path), because a rotation or an axis
 * negation can make a different corner the extreme one. There is no rotation
 * and no axis change here: both anchors are metres in the same axes, which
 * is the premise this whole module rests on.
 */
function shiftRenderBoundsByRtcDelta(bounds: AABB, delta: Readonly<Vec3>): AABB {
  return {
    min: { x: bounds.min.x - delta.x, y: bounds.min.y - delta.y, z: bounds.min.z - delta.z },
    max: { x: bounds.max.x - delta.x, y: bounds.max.y - delta.y, z: bounds.max.z - delta.z },
  };
}

/** What {@link rebaseGeometryOntoFirstRealAnchor} reads and rewrites per model. */
export interface RtcRebaseGeometry {
  coordinateInfo: CoordinateInfo;
  meshes: ReadonlyArray<{ positions: Float32Array; geometryClass?: number }>;
  /** Present on a `GeometryResult`; read here only by
   *  {@link carriesGpuInstancedGeometry}. */
  instancedGeometryAabbs?: ReadonlyMap<number, unknown> | null;
}

/**
 * Whether a model carries GPU-instanced geometry, which this re-basing
 * CANNOT move — the reason {@link rebaseGeometryOntoFirstRealAnchor} refuses
 * such a federation outright instead of half-moving it.
 *
 * An instanced-only entity's geometry never appears in `meshes` as a placed
 * occurrence: what crosses the boundary is a class-2 template plus a shard of
 * per-occurrence transforms, and those transforms carry the occurrence's
 * world position in the frame it was meshed in. They are decoded straight
 * into renderer-owned instance buffers, and the content-version bump this
 * re-base relies on deliberately KEEPS the instanced templates of a model
 * that is still present (`geometry-rebuild.ts`,
 * `reshapeSceneKeepingPresentInstanced`) — so nothing reachable from a
 * `GeometryResult` can move them. Translating this model's meshes (and its
 * `instancedGeometryAabbs`) anyway would split ONE model across two frames
 * and make its instanced boxes describe geometry that is not there, which is
 * strictly worse than the load-order dependence of #4897 that this whole
 * file exists to remove.
 *
 * Two signals, because neither alone is sufficient: `instancedGeometryAabbs`
 * is absent when geometry hashing is off (`types.ts`), and a class-2
 * template is absent when the wasm build emitted no template for a shard
 * this build understands. Either one present means "instanced".
 */
function carriesGpuInstancedGeometry(geometry: RtcRebaseGeometry): boolean {
  if (geometry.instancedGeometryAabbs != null && geometry.instancedGeometryAabbs.size > 0) return true;
  return geometry.meshes.some((mesh) => geometryClassOf(mesh) === GEOM_CLASS_INSTANCED_TYPE);
}

/**
 * Whether {@link rebaseGeometryOntoFirstRealAnchor} will refuse THIS call
 * because of {@link carriesGpuInstancedGeometry} — as opposed to the other
 * two reasons it can return an empty array, which are ordinary no-ops and
 * mean nothing needed to move.
 *
 * The refusal decision lives here, in one function, called both by the
 * re-base itself and by the viewer wiring that has to tell the user their
 * models are staying in separate frames. A caller re-deriving the condition
 * could drift out of step with the re-base and report the wrong thing.
 */
export function rtcRebaseRefusedForInstancedGeometry(
  existingGeometries: readonly RtcRebaseGeometry[],
  justLoadedOffset: Readonly<Vec3> | null | undefined,
): boolean {
  if (justLoadedOffset == null) return false;
  if (existingGeometries.some((geometry) => geometry.coordinateInfo.wasmRtcOffset != null)) return false;
  return existingGeometries.some(carriesGpuInstancedGeometry);
}

/**
 * The core of the #4897 fix. Call this right after a model finishes loading,
 * passing every OTHER already-loaded model's geometry and the just-loaded
 * model's resolved `wasmRtcOffset` (or `null`/`undefined` if it has none).
 *
 * A no-op unless the just-loaded model introduced the federation's FIRST
 * real anchor: `justLoadedOffset` is non-null AND no `existingGeometries`
 * entry has a `wasmRtcOffset` of its own yet. In that one case, every entry
 * (all of them raw, by that same condition) is mutated in place — mesh
 * positions translated, the render-frame boxes translated with them and
 * `coordinateInfo.wasmRtcOffset` replaced — so the
 * WHOLE federation, old models included, ends up in the one frame the new
 * model defined. Returns the geometries actually touched, so the caller
 * knows which models need `bumpGeometryContentVersion()` and a spatial
 * reindex (mutating `meshes[].positions` does not itself invalidate either).
 *
 * When an earlier model already has a real anchor, this is a no-op: the
 * loader already gave the new model that SAME anchor as its
 * `sharedRtcOffset` (`chooseSharedRtcOffset`), so nothing here needs to move.
 *
 * Also a no-op — a deliberate REFUSAL — when any existing model carries
 * GPU-instanced geometry, which this cannot reach: see
 * {@link carriesGpuInstancedGeometry}. The caller is expected to tell the
 * user, because those models then keep the frame they loaded in.
 *
 * WHAT MOVES, AND WHAT MUST NOT. A re-base changes the render frame only —
 * where the model's numbers are measured FROM — never where the model is in
 * the world. So exactly the render-frame data moves: `mesh.positions` and the
 * two `CoordinateInfo` boxes (`originalBounds`, `shiftedBounds`), with
 * `wasmRtcOffset` recording the new anchor.
 *
 * Three neighbouring fields are ABSOLUTE WORLD and are deliberately left
 * alone — translating them would be the bug, not the fix:
 *
 *  - `MeshData.geometryAabb` (and the `instancedGeometryAabbs` side channel):
 *    the hasher folds the file's RTC back in, so "two revisions that chose
 *    different RTC offsets report the same box"
 *    (`MeshCollection::geometry_aabb_values`, pinned by the Rust test
 *    `reported_aabb_is_rtc_invariant`). `geometrySummary.ts` compares it
 *    against vertices only after lifting them with
 *    `render + rtc + originShift`, which the new `wasmRtcOffset` already
 *    accounts for.
 *  - `MeshData.localToWorld`: the resolved placement chain as captured, with
 *    no RTC subtracted (`transform_mesh_world` assigns the transform before
 *    it subtracts the offset from the vertices) — "the placement's
 *    translation in the *original* (pre-RTC) coordinate frame"
 *    (`Scene.getEntityTransform`). The demesher's reconstruction is
 *    `true_world = origin + position + rtc` then `inv(localToWorld) *
 *    true_world` (`simplify_session.rs`), which stays exact across a re-base
 *    precisely because `localToWorld` does not move with `rtc`.
 *  - `MeshData.origin`: render-frame, but the per-vertex delta already landed
 *    in `positions`, so `origin + position` has moved once. Shifting `origin`
 *    too would double it.
 */
export function rebaseGeometryOntoFirstRealAnchor<T extends RtcRebaseGeometry>(
  existingGeometries: readonly T[],
  justLoadedOffset: Readonly<Vec3> | null | undefined,
): T[] {
  if (justLoadedOffset == null) return [];
  if (existingGeometries.some((geometry) => geometry.coordinateInfo.wasmRtcOffset != null)) return [];
  // Refuse before mutating anything: a partial move is worse than none.
  if (rtcRebaseRefusedForInstancedGeometry(existingGeometries, justLoadedOffset)) return [];

  const moved: T[] = [];
  for (const geometry of existingGeometries) {
    // `delta` deliberately reads only `wasmRtcOffset`, not
    // `coordinateInfo.originShift` — even though a "still raw" model here
    // (no `wasmRtcOffset`) CAN carry a non-zero `originShift`:
    // `CoordinateHandler`'s >10km JS-side fallback sets it when WASM did NOT
    // apply RTC (#4906 review). That's not a gap: every render-frame value
    // this function reads or writes (`positions`, `originalBounds`,
    // `shiftedBounds`) is defined relative to the model's TOTAL offset,
    // `originShift + ifcToViewerAxes(wasmRtcOffset ?? 0)` (`totalYupOffset`,
    // `world-frame.ts`), and this call only ever changes the `wasmRtcOffset`
    // term — `originShift` is copied through unchanged below. So the correct
    // per-vertex/per-box translation is exactly the CHANGE in that total,
    // which is exactly the change in `wasmRtcOffset` alone: `originShift`
    // cancels out of the subtraction because it is the same on both sides.
    // (Axis note: `originShift` is already Y-up, `wasmRtcOffset` is IFC
    // Z-up — the two are never added directly, only through
    // `ifcToViewerAxes`, which is exactly what `rtcRebaseDeltaYup` does.)
    const fromOffset = geometry.coordinateInfo.wasmRtcOffset;
    const delta = rtcRebaseDeltaYup(fromOffset, justLoadedOffset);
    for (const mesh of geometry.meshes) {
      rebasePositionsToRtcOffset(mesh.positions, fromOffset, justLoadedOffset);
    }
    // The two boxes move WITH the positions, in the same pass, because both
    // are render-frame: `originalBounds` is the raw mesh bounds the producer
    // measured (`CoordinateHandler.calculateBounds` sums `origin + position`)
    // and `shiftedBounds` is that minus `originShift`. Consumers lift them
    // back to world by ADDING the offsets — `computeFootprintGeoJSON` does
    // `bounds + originShift + ifcToViewerAxes(wasmRtcOffset)`, `modelMinZMeters`
    // does `originalBounds.min.y + rtcYup.y` — so a box left behind while
    // `wasmRtcOffset` gains the anchor reports a position off by exactly this
    // delta, and the camera fit / section-plane range read straight off
    // `shiftedBounds` would frame empty space. Shifting BOTH by the same delta
    // also preserves `originalBounds - shiftedBounds === originShift`.
    geometry.coordinateInfo = {
      ...geometry.coordinateInfo,
      originalBounds: shiftRenderBoundsByRtcDelta(geometry.coordinateInfo.originalBounds, delta),
      shiftedBounds: shiftRenderBoundsByRtcDelta(geometry.coordinateInfo.shiftedBounds, delta),
      wasmRtcOffset: { ...justLoadedOffset },
    };
    moved.push(geometry);
  }
  return moved;
}
