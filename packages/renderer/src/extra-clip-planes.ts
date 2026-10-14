/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clip planes beyond the first (#7545).
 *
 * `RenderOptions.sectionPlane` stays the primary plane: it drives the gizmo,
 * the cap and the cardinal range, and every consumer packs it exactly as it
 * always has. A scene with several cutting planes hands the rest over as
 * `RenderOptions.extraSectionPlanes`; those are pure half-space tests with no
 * gizmo, cap or range of their own. A fragment survives only if EVERY plane
 * keeps it, the rule `sectionClipped` already applies to the plane and the clip
 * box.
 *
 * One block layout serves every consumer (the mesh uniform, the pick passes,
 * the shadow pass, the point-cloud pass), so a pass cannot grow its own reading
 * of it and drift from the others:
 *
 *   planeInfo vec4<u32>     x = plane count (0..7), y = flipped bit mask
 * (not `meta`: that is a reserved WGSL keyword)
 *   planes array<vec4<f32>, 7>  xyz = unit normal, w = distance
 *
 * 32 floats / 128 bytes. A count of zero is the "no extra planes" case and is
 * the only thing the shader reads, so a single-plane scene costs one integer
 * compare per fragment and its other lanes may hold anything.
 */

import { rtePlaneDistance } from './rte-clip-space.js';
import type { ExtraClipPlane } from './clip-types.js';
import type { WorldPoint } from './relative-to-eye.js';

/** Planes the block can carry; with the primary plane that is eight cuts. */
export const MAX_EXTRA_CLIP_PLANES = 7;
/** Floats in one packed block. */
export const EXTRA_CLIP_FLOATS = 4 + MAX_EXTRA_CLIP_PLANES * 4;
/** Bytes in one packed block. */
export const EXTRA_CLIP_BYTES = EXTRA_CLIP_FLOATS * Float32Array.BYTES_PER_ELEMENT;

/**
 * One u32 written into a Float32Array slot as its bit pattern, with no typed-array view built per call
 * (this runs for every mesh every frame). Small integers are float32 denormals: they cross the
 * double round trip bit-exact, which a NaN pattern would not.
 */
const bitsF32 = new Float32Array(1);
const bitsU32 = new Uint32Array(bitsF32.buffer);
function putU32(out: Float32Array, index: number, value: number): void {
  bitsU32[0] = value;
  out[index] = bitsF32[0]!;
}

/**
 * Write the block into `out` at `floatOffset`. `cameraWorld` re-expresses each
 * distance in the eye-relative frame the pass shades in (f64 subtraction before
 * the f32 write, as `rtePlaneDistance` does for the primary plane); `null`
 * writes world-space distances. Planes past the capacity are dropped, never
 * wrapped: a half-applied cut would show geometry the user removed.
 */
export function packExtraClip(
  planes: readonly ExtraClipPlane[] | null | undefined,
  cameraWorld: WorldPoint | null,
  out: Float32Array,
  floatOffset: number,
): void {
  const count = Math.min(planes?.length ?? 0, MAX_EXTRA_CLIP_PLANES);
  if (!planes || count === 0) {
    // +0.0 has the bit pattern of u32 0: the common (no extra plane) case needs no integer view.
    out[floatOffset] = 0;
    out[floatOffset + 1] = 0;
    return;
  }
  putU32(out, floatOffset, count);
  let flippedMask = 0;
  for (let i = 0; i < count; i++) {
    const plane = planes[i]!;
    const base = floatOffset + 4 + i * 4;
    out[base] = plane.normal[0];
    out[base + 1] = plane.normal[1];
    out[base + 2] = plane.normal[2];
    out[base + 3] = cameraWorld ? rtePlaneDistance(plane.distance, plane.normal, cameraWorld) : plane.distance;
    if (plane.flipped) flippedMask |= 1 << i;
  }
  putU32(out, floatOffset + 1, flippedMask);
}

/**
 * The WGSL half: the block's struct and a clip test over it. Concatenate into
 * any shader whose uniform struct carries an `ExtraClip` field, then call
 * `extraClipClipped(uniforms.<field>, p)` with `p` in the same frame the block
 * was packed for.
 */
export const extraClipWgsl = `
        struct ExtraClip {
          planeInfo: vec4<u32>,            // x = plane count, y = flipped bit mask
          planes: array<vec4<f32>, ${MAX_EXTRA_CLIP_PLANES}>, // xyz = normal, w = distance
        }

        // True when p is on the removed side of ANY extra plane.
        fn extraClipClipped(clip: ExtraClip, p: vec3<f32>) -> bool {
          for (var i = 0u; i < clip.planeInfo.x; i = i + 1u) {
            let side = select(1.0, -1.0, ((clip.planeInfo.y >> i) & 1u) == 1u);
            if ((dot(p, clip.planes[i].xyz) - clip.planes[i].w) * side > 0.0) { return true; }
          }
          return false;
        }
`;

/**
 * CPU mirror of `extraClipClipped` for a world-space point, shared by the
 * raycaster and the tests that pin shader/CPU agreement.
 */
export function extraPlanesClip(
  planes: readonly ExtraClipPlane[] | null | undefined,
  x: number,
  y: number,
  z: number,
): boolean {
  if (!planes) return false;
  const count = Math.min(planes.length, MAX_EXTRA_CLIP_PLANES);
  for (let i = 0; i < count; i++) {
    const p = planes[i]!;
    const side = p.flipped ? -1 : 1;
    if ((x * p.normal[0] + y * p.normal[1] + z * p.normal[2] - p.distance) * side > 0) return true;
  }
  return false;
}

type Vec3 = { x: number; y: number; z: number };
type Plane = { normal: readonly [number, number, number]; distance: number; flipped: boolean };

/** True when every corner of `box` is on the removed side of `plane`. */
export function boxBehindPlane(box: { min: Vec3; max: Vec3 }, plane: Plane): boolean {
  const side = plane.flipped ? -1 : 1;
  const [nx, ny, nz] = plane.normal;
  // Corner that minimises (dot(p,n) - dist)*side: per axis pick min/max by sign.
  const px = nx * side >= 0 ? box.min.x : box.max.x;
  const py = ny * side >= 0 ? box.min.y : box.max.y;
  const pz = nz * side >= 0 ? box.min.z : box.max.z;
  return (px * nx + py * ny + pz * nz - plane.distance) * side > 0;
}

/**
 * Narrow the ray interval [tmin, tmax] to where the ray is visible past the
 * primary section plane and every extra plane: visible where
 * f(t) = (dot(P(t), n) - distance) * side <= 0. Null when nothing remains.
 */
export function clipRayByPlanes(
  clip: { sectionPlane?: Plane | null; extraPlanes?: readonly Plane[] | null } | null | undefined,
  origin: Vec3,
  dir: Vec3,
  tmin: number,
  tmax: number,
): { tmin: number; tmax: number } | null {
  const planes: Plane[] = [];
  if (clip?.sectionPlane) planes.push(clip.sectionPlane);
  if (clip?.extraPlanes) planes.push(...clip.extraPlanes.slice(0, MAX_EXTRA_CLIP_PLANES));
  for (const plane of planes) {
    const side = plane.flipped ? -1 : 1;
    const [nx, ny, nz] = plane.normal;
    const f0 = (origin.x * nx + origin.y * ny + origin.z * nz - plane.distance) * side;
    const slope = (dir.x * nx + dir.y * ny + dir.z * nz) * side;
    if (Math.abs(slope) < 1e-12) {
      if (f0 > 0) return null; // ray runs parallel on the cut-away side
    } else {
      const tCross = -f0 / slope;
      if (slope > 0) {
        if (tmin > tCross) return null;       // whole interval cut away
        if (tmax > tCross) tmax = tCross;      // visible only up to the plane
      } else {
        if (tmax < tCross) return null;
        if (tmin < tCross) tmin = tCross;      // visible only beyond the plane
      }
    }
    if (tmax < tmin) return null;
  }
  return { tmin, tmax };
}
