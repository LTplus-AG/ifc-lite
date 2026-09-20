/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer's relative-to-eye (RTE) coordinate contract.
 *
 * IFC source coordinates are JavaScript numbers (IEEE-754 f64).  They must
 * stay that way through placement, bounds, picking and measurement.  A GPU
 * vertex, however, is f32; at a national-grid offset its least significant
 * bit is much larger than an edge or a cursor snap tolerance.  The only
 * f32 conversion allowed at the render boundary is therefore this split:
 *
 *   world = high + low
 *   eyeRelative = local + (drawable.high - camera.high)
 *                       + (drawable.low  - camera.low)
 *
 * High values are rounded independently before subtraction.  Nearby large
 * origins consequently cancel before the small residual is added, instead of
 * first adding a small local vertex to a multi-million-metre number.
 *
 * This module deliberately owns both the CPU packing layout and the matching
 * WGSL declarations (in `shaders/relative-to-eye.wgsl.ts`).  Pass migrations
 * must consume this frame; no render path may create a competing camera
 * rebase.  `worldToRelative` is also the CPU counterpart for ray, snap and
 * measure code: it uses f64 subtraction and never round-trips through a GPU
 * buffer.
 */

import { MathUtils } from './math.js';
import type { Mat4, Vec3 } from './types.js';

/** A point or translation in the source/world f64 coordinate system. */
export type WorldPoint = readonly [number, number, number];

/** Two f32 vec4 lanes holding one f64-like origin.  The w components are 0. */
export const RTE_ORIGIN_FLOATS = 8;
/** `mat4x4 viewProj`, then camera-origin high and low vec4 lanes. */
export const RTE_FRAME_FLOATS = 16 + RTE_ORIGIN_FLOATS;

/**
 * Split one finite f64 coordinate into two f32 values.  The residual is also
 * rounded to f32 because it is consumed by WGSL, and the pair is returned as
 * ordinary numbers so callers cannot accidentally retain a mutable buffer.
 */
export function splitFloat64ForRte(value: number): readonly [number, number] {
  if (!Number.isFinite(value)) {
    throw new RangeError(`RTE origins must be finite f64 coordinates; received ${value}.`);
  }
  const high = Math.fround(value);
  if (!Number.isFinite(high)) {
    throw new RangeError(`RTE origin ${value} exceeds the finite f32 GPU range.`);
  }
  return [high, Math.fround(value - high)];
}

/**
 * Pack an f64 world origin as two vec4<f32>s at `floatOffset`.  The empty w
 * lanes are explicitly cleared so a reused uniform scratch buffer cannot
 * leak unrelated data into a future WGSL struct revision.
 */
export function packRteOrigin(
  origin: WorldPoint,
  out: Float32Array,
  floatOffset = 0,
): void {
  if (out.length < floatOffset + RTE_ORIGIN_FLOATS) {
    throw new RangeError(`RTE origin needs ${RTE_ORIGIN_FLOATS} floats at offset ${floatOffset}.`);
  }
  for (let axis = 0; axis < 3; axis++) {
    const [high, low] = splitFloat64ForRte(origin[axis]);
    out[floatOffset + axis] = high;
    out[floatOffset + 4 + axis] = low;
  }
  out[floatOffset + 3] = 0;
  out[floatOffset + 7] = 0;
}

/** Read back the exact f64-ish source value represented by an RTE origin. */
export function unpackRteOrigin(
  packed: Float32Array,
  floatOffset = 0,
): [number, number, number] {
  if (packed.length < floatOffset + RTE_ORIGIN_FLOATS) {
    throw new RangeError(`RTE origin needs ${RTE_ORIGIN_FLOATS} floats at offset ${floatOffset}.`);
  }
  return [
    packed[floatOffset] + packed[floatOffset + 4],
    packed[floatOffset + 1] + packed[floatOffset + 5],
    packed[floatOffset + 2] + packed[floatOffset + 6],
  ];
}

/**
 * Remove only the camera translation from a view matrix.  Projection remains
 * untouched (including its depth translation); "translation-free" means no
 * world/eye translation is baked into `viewProj`, not a projection with its
 * near-plane term removed.
 */
export function translationFreeViewProjection(projection: Mat4, view: Mat4): Mat4 {
  const orientationOnly = new Float32Array(view.m);
  orientationOnly[12] = 0;
  orientationOnly[13] = 0;
  orientationOnly[14] = 0;
  return MathUtils.multiply(projection, { m: orientationOnly });
}

/**
 * The one camera-owned RTE frame.  It carries f64 camera source coordinates,
 * their high/low GPU representation, and a view-projection that consumes
 * eye-relative positions.  It intentionally has no model/drawable state:
 * that state is packed per draw through `packDrawableOrigin`.
 */
export class RelativeToEyeFrame {
  private readonly cameraPacked = new Float32Array(RTE_ORIGIN_FLOATS);
  private cameraWorld: [number, number, number] = [0, 0, 0];
  private viewProj: Mat4 = MathUtils.identity();

  /** Update the frame from the f64 camera pose and the normal camera matrices. */
  update(camera: Vec3, projection: Mat4, view: Mat4): void {
    this.cameraWorld = [camera.x, camera.y, camera.z];
    packRteOrigin(this.cameraWorld, this.cameraPacked);
    this.viewProj = translationFreeViewProjection(projection, view);
  }

  /** f64 source camera position; copied so an external caller cannot mutate it. */
  getCameraWorld(): [number, number, number] {
    return [...this.cameraWorld];
  }

  /** The projection to use after WGSL has made a vertex relative to this eye. */
  getViewProjection(): Mat4 {
    return this.viewProj;
  }

  /**
   * Pack `viewProj + cameraHigh + cameraLow`, matching `RteFrameUniform` in
   * WGSL.  An explicit writer keeps dynamic-uniform callers from drifting
   * field offsets independently.
   */
  packUniforms(out: Float32Array, floatOffset = 0): void {
    if (out.length < floatOffset + RTE_FRAME_FLOATS) {
      throw new RangeError(`RTE frame needs ${RTE_FRAME_FLOATS} floats at offset ${floatOffset}.`);
    }
    out.set(this.viewProj.m, floatOffset);
    out.set(this.cameraPacked, floatOffset + 16);
  }

  /** Pack a drawable's f64 world origin into the matching per-draw layout. */
  packDrawableOrigin(origin: WorldPoint, out: Float32Array, floatOffset = 0): void {
    packRteOrigin(origin, out, floatOffset);
  }

  /**
   * CPU side of the contract for ray casting, snapping and measurement.
   * Keep this f64 subtraction separate from the f32 emulation helper below:
   * callers that are not writing a GPU uniform should retain all source
   * precision.
   */
  worldToRelative(world: WorldPoint): [number, number, number] {
    return [
      world[0] - this.cameraWorld[0],
      world[1] - this.cameraWorld[1],
      world[2] - this.cameraWorld[2],
    ];
  }
}

/**
 * f32-faithful reference for the WGSL origin subtraction.  Tests use it to
 * prove the actual GPU arithmetic order rather than merely checking that the
 * high/low arrays contain plausible values.
 */
export function rteRelativePositionF32(
  local: WorldPoint,
  drawablePacked: Float32Array,
  cameraPacked: Float32Array,
): [number, number, number] {
  if (drawablePacked.length < RTE_ORIGIN_FLOATS || cameraPacked.length < RTE_ORIGIN_FLOATS) {
    throw new RangeError('RTE relative position requires two packed origins.');
  }
  const result: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const highDelta = Math.fround(drawablePacked[axis] - cameraPacked[axis]);
    const lowDelta = Math.fround(drawablePacked[axis + 4] - cameraPacked[axis + 4]);
    result[axis] = Math.fround(Math.fround(local[axis]) + Math.fround(highDelta + lowDelta));
  }
  return result;
}
