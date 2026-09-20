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
import { relativeToEyeWgsl } from './shaders/relative-to-eye.wgsl.js';
import type { Mat4, Vec3 } from './types.js';

/** A point or translation in the source/world f64 coordinate system. */
export type WorldPoint = readonly [number, number, number];

/** Two f32 vec4 lanes holding one f64-like origin.  The w components are 0. */
export const RTE_ORIGIN_FLOATS = 8;
/** `mat4x4 viewProj`, then camera-origin high and low vec4 lanes. */
export const RTE_FRAME_FLOATS = 16 + RTE_ORIGIN_FLOATS;

interface UniformFieldLayout {
  name: string;
  type: 'mat4x4<f32>' | 'vec4<f32>';
  byteOffset: number;
  byteSize: number;
}

/** Exact byte layout shared by the CPU writer and the WGSL RTE structs. */
export const RTE_UNIFORM_LAYOUT = {
  frame: [
    { name: 'viewProj', type: 'mat4x4<f32>', byteOffset: 0, byteSize: 64 },
    { name: 'cameraHigh', type: 'vec4<f32>', byteOffset: 64, byteSize: 16 },
    { name: 'cameraLow', type: 'vec4<f32>', byteOffset: 80, byteSize: 16 },
  ] as const satisfies readonly UniformFieldLayout[],
  drawable: [
    { name: 'drawableHigh', type: 'vec4<f32>', byteOffset: 0, byteSize: 16 },
    { name: 'drawableLow', type: 'vec4<f32>', byteOffset: 16, byteSize: 16 },
  ] as const satisfies readonly UniformFieldLayout[],
} as const;

/**
 * Reflect the deliberately small RTE WGSL ABI. The production source has no
 * nested structs or arrays here, so accepting either would conceal inserted
 * padding. Unsupported syntax is a contract failure, not a parser fallback.
 */
export function reflectRteUniformStruct(
  source: string,
  structName: 'RteFrameUniform' | 'RteDrawableUniform',
): UniformFieldLayout[] {
  const match = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`).exec(source);
  if (!match) throw new Error(`RTE WGSL struct ${structName} is missing.`);
  const fields: UniformFieldLayout[] = [];
  let byteOffset = 0;
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const field = /^(\w+)\s*:\s*(mat4x4<f32>|vec4<f32>)\s*,?$/.exec(line);
    if (!field) throw new Error(`Unsupported RTE WGSL field: ${line}`);
    const name = field[1];
    const type = field[2];
    if (!name || (type !== 'mat4x4<f32>' && type !== 'vec4<f32>')) {
      throw new Error(`Invalid RTE WGSL field: ${line}`);
    }
    const byteSize = type === 'mat4x4<f32>' ? 64 : 16;
    byteOffset = Math.ceil(byteOffset / 16) * 16;
    fields.push({ name, type, byteOffset, byteSize });
    byteOffset += byteSize;
  }
  return fields;
}

/** Fail loudly if source edits drift from the CPU writer's exact ABI. */
export function assertRteUniformAbi(source = relativeToEyeWgsl): void {
  for (const [structName, expected] of [
    ['RteFrameUniform', RTE_UNIFORM_LAYOUT.frame],
    ['RteDrawableUniform', RTE_UNIFORM_LAYOUT.drawable],
  ] as const) {
    const actual = reflectRteUniformStruct(source, structName);
    if (actual.length !== expected.length || actual.some((field, index) => {
      const want = expected[index];
      return field.name !== want.name || field.type !== want.type
        || field.byteOffset !== want.byteOffset || field.byteSize !== want.byteSize;
    })) {
      throw new Error(`RTE WGSL ${structName} does not match the CPU uniform ABI.`);
    }
  }
  // Layout reflection alone cannot prove floating-point association. This is
  // an executable shader-source invariant, separate from ABI reflection.
  if (!source.includes('(local + highDelta) + lowDelta')
    || source.includes('local + (highDelta + lowDelta)')) {
    throw new Error('RTE WGSL must evaluate (local + highDelta) + lowDelta.');
  }
}

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

/** Read back the f64 approximation represented by a packed RTE origin. */
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
    out.set(this.viewProj.m, floatOffset + RTE_UNIFORM_LAYOUT.frame[0].byteOffset / 4);
    out.set(this.cameraPacked, floatOffset + RTE_UNIFORM_LAYOUT.frame[1].byteOffset / 4);
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
    // Match WGSL exactly: a local template may span kilometres, so folding
    // low into high before adding local can lose the low residual.
    result[axis] = Math.fround(Math.fround(Math.fround(local[axis]) + highDelta) + lowDelta);
  }
  return result;
}
