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
 *   drawableMinusCamera = deltaHigh + deltaLow
 *   eyeRelative = (local + deltaHigh) + deltaLow
 *
 * The delta is formed in CPU f64 before either lane is rounded. This avoids
 * losing a source residual when two independently rounded large origins are
 * subtracted in f32.
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
/** Translation-free `mat4x4 viewProj`; camera position stays CPU f64 only. */
export const RTE_FRAME_FLOATS = 16;
/** Largest supported source/world coordinate component, in canonical Y-up metres. */
export const MAX_RTE_SOURCE_ABS_METRES = 1_000_000_000;
/** Largest source-origin delta accepted by a single camera RTE frame. */
export const MAX_RTE_EYE_RELATIVE_METRES = 1_000_000;

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
  ] as const satisfies readonly UniformFieldLayout[],
  drawable: [
    { name: 'drawableDeltaHigh', type: 'vec4<f32>', byteOffset: 0, byteSize: 16 },
    { name: 'drawableDeltaLow', type: 'vec4<f32>', byteOffset: 16, byteSize: 16 },
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
  if (Math.abs(value) > MAX_RTE_SOURCE_ABS_METRES) {
    throw new RangeError(`RTE origin ${value} exceeds the supported ±${MAX_RTE_SOURCE_ABS_METRES} m source envelope.`);
  }
  const high = Math.fround(value);
  if (!Number.isFinite(high)) {
    throw new RangeError(`RTE origin ${value} exceeds the finite f32 GPU range.`);
  }
  return [high, Math.fround(value - high)];
}

/** Validate a source/world f64 point before any subtraction changes its meaning. */
function validateRteSourcePoint(point: WorldPoint): void {
  for (let axis = 0; axis < 3; axis++) splitFloat64ForRte(point[axis]);
}

function packDrawableDelta(
  origin: WorldPoint,
  cameraWorld: WorldPoint,
  out: Float32Array,
  floatOffset: number,
): void {
  validateRteSourcePoint(origin);
  const delta: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    delta[axis] = origin[axis] - cameraWorld[axis];
    if (!Number.isFinite(delta[axis]) || Math.abs(delta[axis]) > MAX_RTE_EYE_RELATIVE_METRES) {
      throw new RangeError(
        `RTE drawable origin exceeds the ±${MAX_RTE_EYE_RELATIVE_METRES} m camera-relative envelope on axis ${axis}.`,
      );
    }
  }
  packRteOrigin(delta, out, floatOffset);
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
 * The one camera-owned RTE frame. It carries f64 camera source coordinates and
 * a translation-free view-projection that consumes eye-relative positions. It
 * intentionally has no model/drawable state: each
 * draw packs an f64 camera-relative delta through `packDrawableOrigin`.
 */
export class RelativeToEyeFrame {
  private cameraWorld: [number, number, number] = [0, 0, 0];
  private viewProj: Mat4 = MathUtils.identity();
  private renderEpoch = 0;

  /** Update the frame from the f64 camera pose and the normal camera matrices. */
  update(camera: Vec3, projection: Mat4, view: Mat4): void {
    this.cameraWorld = [camera.x, camera.y, camera.z];
    validateRteSourcePoint(this.cameraWorld);
    this.viewProj = translationFreeViewProjection(projection, view);
    this.renderEpoch++;
  }

  /** f64 source camera position; copied so an external caller cannot mutate it. */
  getCameraWorld(): [number, number, number] {
    return [...this.cameraWorld];
  }

  /** The projection to use after WGSL has made a vertex relative to this eye. */
  getViewProjection(): Mat4 {
    return this.viewProj;
  }

  /** Monotonic snapshot identity for asynchronous GPU work and readback. */
  getRenderEpoch(): number {
    return this.renderEpoch;
  }

  /**
   * Capture immutable frame inputs before queuing asynchronous GPU work.
   * A later camera update mutates this frame but cannot rewrite the captured
   * camera origin or matrix used to decode that work's readback.
   */
  snapshot(): RelativeToEyeSnapshot {
    return new RelativeToEyeSnapshot(this.renderEpoch, this.cameraWorld, this.viewProj);
  }

  /**
   * Pack the translation-free `viewProj`, matching `RteFrameUniform` in WGSL.
   * The camera stays CPU f64 only; each drawable supplies its already-split
   * f64 camera-relative delta through the separate per-draw uniform.
   */
  packUniforms(out: Float32Array, floatOffset = 0): void {
    if (out.length < floatOffset + RTE_FRAME_FLOATS) {
      throw new RangeError(`RTE frame needs ${RTE_FRAME_FLOATS} floats at offset ${floatOffset}.`);
    }
    out.set(this.viewProj.m, floatOffset + RTE_UNIFORM_LAYOUT.frame[0].byteOffset / 4);
  }

  /**
   * Pack a drawable's f64 camera-relative origin into the per-draw layout.
   * The GPU must never subtract independently rounded absolute origins again.
   * This payload is camera-dependent and is invalid after any camera reframe.
   */
  packDrawableOrigin(origin: WorldPoint, out: Float32Array, floatOffset = 0): void {
    // Validate the original source origin before subtraction: a camera at the
    // boundary could otherwise make an out-of-range drawable look harmless.
    packDrawableDelta(origin, this.cameraWorld, out, floatOffset);
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

/** An immutable RTE frame captured for one render submission/readback. */
export class RelativeToEyeSnapshot {
  private readonly cameraWorld: readonly [number, number, number];
  private readonly viewProj: Mat4;

  constructor(
    readonly renderEpoch: number,
    cameraWorld: WorldPoint,
    viewProj: Mat4,
  ) {
    this.cameraWorld = [...cameraWorld];
    this.viewProj = { m: new Float32Array(viewProj.m) };
  }

  getCameraWorld(): [number, number, number] {
    return [...this.cameraWorld];
  }

  getViewProjection(): Mat4 {
    return { m: new Float32Array(this.viewProj.m) };
  }

  packDrawableOrigin(origin: WorldPoint, out: Float32Array, floatOffset = 0): void {
    packDrawableDelta(origin, this.cameraWorld, out, floatOffset);
  }

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
  drawableDeltaPacked: Float32Array,
): [number, number, number] {
  if (drawableDeltaPacked.length < RTE_ORIGIN_FLOATS) {
    throw new RangeError('RTE relative position requires one packed drawable-camera delta.');
  }
  const result: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const highDelta = drawableDeltaPacked[axis];
    const lowDelta = drawableDeltaPacked[axis + 4];
    // Match WGSL exactly: a local template may span kilometres, so folding
    // low into high before adding local can lose the low residual.
    result[axis] = Math.fround(Math.fround(Math.fround(local[axis]) + highDelta) + lowDelta);
  }
  return result;
}
