/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Moving already-loaded models onto the federation's RTC anchor (#4897).
 *
 * A model with small coordinates gets no `wasmRtcOffset` at load and is meshed
 * raw. When a model that needs a real RTC anchor joins the federation, that
 * anchor becomes the shared frame (`chooseSharedRtcOffset`, `world-frame.ts`),
 * so every model meshed before it — and any model that finished loading in
 * parallel against a different frame — has to move onto it, or it renders in a
 * frame nothing else shares.
 *
 * This is a plain axis-aligned translation, not a CRS reprojection: both
 * anchors are metres in the same IFC axes, so there is no rotation or unit
 * conversion to apply.
 *
 * PRECISION. The translation goes into each mesh's f64 `origin`, never into its
 * f32 `positions`. The delta is the anchor itself when a raw model moves, i.e.
 * map-coordinate magnitude (Swiss LV95 ~2.6e6 m, UTM northings ~5e6 m), where
 * one f32 ULP is 0.25-0.5 m: baking it into the vertices collapses millimetre
 * detail to zero. Moving the origin keeps `positions` bit-identical and leaves
 * the mesh in exactly the shape the wasm mesher produces when the anchor was
 * already known at load (f64 origin = element centre minus the RTC, small f32
 * local detail), so both load orders render from the same kind of data.
 */

import type { AABB, CoordinateInfo, Vec3 } from './coordinate-types.js';
import { GEOM_CLASS_INSTANCED_TYPE, geometryClassOf } from './geometry-class.js';
import { ifcToViewerAxes } from './world-frame.js';

const ZERO: Readonly<Vec3> = { x: 0, y: 0, z: 0 };

type Origin = [number, number, number];

/**
 * The render-frame (Y-up) translation that turns a mesh produced against
 * `fromOffset` (IFC Z-up; absent means the raw frame) into one produced
 * against `toOffset`. Render-frame coordinates are `world - offset`, so the
 * mesh moves by `-delta`.
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

function isZero(delta: Readonly<Vec3>): boolean {
  return delta.x === 0 && delta.y === 0 && delta.z === 0;
}

/**
 * A mesh origin moved by `-delta`, as a NEW array (origins may be shared
 * between pieces, so never write through the old one). An absent origin means
 * the positions are absolute render-frame values, which is origin `[0,0,0]`.
 */
export function rebaseOriginByRtcDelta(origin: Readonly<Origin> | null | undefined, delta: Readonly<Vec3>): Origin {
  const base = origin ?? [0, 0, 0];
  return [base[0] - delta.x, base[1] - delta.y, base[2] - delta.z];
}

/**
 * Shifting the two corners is sound only because this is a pure translation:
 * every corner moves by the same vector, so the minimum corner stays minimum.
 */
function shiftBounds(bounds: AABB, delta: Readonly<Vec3>): AABB {
  return {
    min: { x: bounds.min.x - delta.x, y: bounds.min.y - delta.y, z: bounds.min.z - delta.z },
    max: { x: bounds.max.x - delta.x, y: bounds.max.y - delta.y, z: bounds.max.z - delta.z },
  };
}

/** {@link rtcRebaseDeltaYup} from the frame `info` records to `anchor`. */
export function rtcRebaseDeltaFor(info: CoordinateInfo, anchor: Readonly<Vec3>): Vec3 {
  return rtcRebaseDeltaYup(info.wasmRtcOffset, anchor);
}

/** Whether `info` is already drawn against `anchor` (same IFC offset, exactly). */
export function isOnRtcAnchor(info: CoordinateInfo, anchor: Readonly<Vec3>): boolean {
  return isZero(rtcRebaseDeltaFor(info, anchor));
}

/**
 * `info` re-expressed against `anchor`: both render-frame boxes move with the
 * geometry, `wasmRtcOffset` records the new anchor, and `wasmRtcFrame` is
 * replaced by the frame the geometry is now actually in. Keeping the old
 * `wasmRtcFrame` would leave `needsShift: false` beside a set `wasmRtcOffset`,
 * which the cache serialiser rejects and auxiliary parsers would trust.
 *
 * `originShift` is copied through: every render-frame value here is relative
 * to `originShift + ifcToViewerAxes(wasmRtcOffset)` and only the second term
 * changes, so the change in the total is exactly the RTC delta.
 *
 * Absolute-world fields are NOT in `CoordinateInfo` and are not touched by
 * the caller either: `MeshData.geometryAabb` has the RTC folded back in and
 * `MeshData.localToWorld` is the pre-RTC placement chain, both RTC-invariant.
 */
export function rebaseCoordinateInfoOntoRtcAnchor(info: CoordinateInfo, anchor: Readonly<Vec3>): CoordinateInfo {
  const delta = rtcRebaseDeltaFor(info, anchor);
  return {
    ...info,
    originalBounds: shiftBounds(info.originalBounds, delta),
    shiftedBounds: shiftBounds(info.shiftedBounds, delta),
    wasmRtcOffset: { ...anchor },
    wasmRtcFrame: { x: anchor.x, y: anchor.y, z: anchor.z, needsShift: true },
  };
}

/** What {@link convergeGeometryOntoRtcAnchor} reads and rewrites per model. */
export interface RtcRebaseGeometry {
  coordinateInfo: CoordinateInfo;
  meshes: ReadonlyArray<{ origin?: Origin; geometryClass?: number }>;
  /** Present on a `GeometryResult`; read only by {@link carriesGpuInstancedGeometry}. */
  instancedGeometryAabbs?: ReadonlyMap<number, unknown> | null;
  /** Streamed point clouds: GPU-resident, never meshed against an RTC anchor. */
  pointClouds?: ReadonlyArray<unknown> | null;
}

/**
 * Whether a model carries GPU-instanced geometry, which this module cannot
 * move: instanced occurrences are a class-2 template plus per-occurrence
 * transforms decoded straight into renderer-owned instance buffers, and the
 * content-version rebuild keeps the templates of a model that is still
 * present. Moving the flat meshes anyway would split one model across two
 * frames. Two signals, because `instancedGeometryAabbs` is absent when
 * hashing is off and a class-2 template can be absent when hashing is on.
 */
export function carriesGpuInstancedGeometry(geometry: RtcRebaseGeometry): boolean {
  if (geometry.instancedGeometryAabbs != null && geometry.instancedGeometryAabbs.size > 0) return true;
  return geometry.meshes.some((mesh) => geometryClassOf(mesh) === GEOM_CLASS_INSTANCED_TYPE);
}

/**
 * Point clouds never take part in the RTC frame: the ingest registers them
 * raw in every load order (the georeference alignment is their only frame
 * move), so they are neither moved nor refused.
 */
function isPointCloudOnly(geometry: RtcRebaseGeometry): boolean {
  return (geometry.pointClouds?.length ?? 0) > 0 && geometry.meshes.length === 0;
}

export interface RtcConvergeResult<T> {
  /** Geometries moved onto the anchor (need a GPU rebuild and a spatial reindex). */
  moved: T[];
  /** Geometries NOT on the anchor that could not be moved (GPU-instanced). */
  refused: T[];
}

/**
 * Move every geometry that is not yet drawn against `anchor` onto it, in
 * place: each mesh's `origin` and the `CoordinateInfo` frame fields change,
 * `positions` never do. Geometries already on the anchor and point clouds are
 * left alone; GPU-instanced geometries are reported in `refused` and left
 * untouched, so the caller can tell the user which models stay split.
 *
 * Idempotent: a second call with the same anchor moves nothing.
 */
export function convergeGeometryOntoRtcAnchor<T extends RtcRebaseGeometry>(
  geometries: readonly T[],
  anchor: Readonly<Vec3>,
): RtcConvergeResult<T> {
  const moved: T[] = [];
  const refused: T[] = [];
  const seenMeshes = new Set<object>();
  for (const geometry of new Set(geometries)) {
    if (isPointCloudOnly(geometry) || isOnRtcAnchor(geometry.coordinateInfo, anchor)) continue;
    if (carriesGpuInstancedGeometry(geometry)) {
      refused.push(geometry);
      continue;
    }
    const delta = rtcRebaseDeltaFor(geometry.coordinateInfo, anchor);
    for (const mesh of geometry.meshes) {
      // A MeshData object shared between two results must move once.
      if (seenMeshes.has(mesh)) continue;
      seenMeshes.add(mesh);
      mesh.origin = rebaseOriginByRtcDelta(mesh.origin, delta);
    }
    geometry.coordinateInfo = rebaseCoordinateInfoOntoRtcAnchor(geometry.coordinateInfo, anchor);
    moved.push(geometry);
  }
  return { moved, refused };
}
