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

import type { CoordinateInfo, Vec3 } from './coordinate-types.js';
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

/** What {@link rebaseGeometryOntoFirstRealAnchor} reads and rewrites per model. */
export interface RtcRebaseGeometry {
  coordinateInfo: CoordinateInfo;
  meshes: ReadonlyArray<{ positions: Float32Array }>;
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
 * positions translated, `coordinateInfo.wasmRtcOffset` replaced — so the
 * WHOLE federation, old models included, ends up in the one frame the new
 * model defined. Returns the geometries actually touched, so the caller
 * knows which models need `bumpGeometryContentVersion()` and a spatial
 * reindex (mutating `meshes[].positions` does not itself invalidate either).
 *
 * When an earlier model already has a real anchor, this is a no-op: the
 * loader already gave the new model that SAME anchor as its
 * `sharedRtcOffset` (`chooseSharedRtcOffset`), so nothing here needs to move.
 */
export function rebaseGeometryOntoFirstRealAnchor<T extends RtcRebaseGeometry>(
  existingGeometries: readonly T[],
  justLoadedOffset: Readonly<Vec3> | null | undefined,
): T[] {
  if (justLoadedOffset == null) return [];
  if (existingGeometries.some((geometry) => geometry.coordinateInfo.wasmRtcOffset != null)) return [];

  const moved: T[] = [];
  for (const geometry of existingGeometries) {
    for (const mesh of geometry.meshes) {
      rebasePositionsToRtcOffset(mesh.positions, geometry.coordinateInfo.wasmRtcOffset, justLoadedOffset);
    }
    geometry.coordinateInfo = { ...geometry.coordinateInfo, wasmRtcOffset: { ...justLoadedOffset } };
    moved.push(geometry);
  }
  return moved;
}
