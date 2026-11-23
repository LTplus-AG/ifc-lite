/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compute side of GPU-driven instancing (`gpu-instance-pool.ts`): the
 * occurrence state bits, the cull/compact WGSL, the error-free f64 eye split
 * it mirrors, and the packing of its per-frame uniform.
 */
import { MAX_RTE_EYE_RELATIVE_METRES } from './relative-to-eye.js';
import { INSTANCE_COLOR_OFFSET, INSTANCE_FLAGS_OFFSET, INSTANCE_STRIDE_BYTES } from './instanced-render.js';

/** State bits (low 16) and palette index (high 16) of one occurrence. */
export const POOL_STATE_SELECTED = 1;
export const POOL_STATE_HIDDEN = 2;
export const POOL_STATE_DEAD = 4;
/** Hidden by the viewer's hide set (kept apart from suppression/tombstone HIDDEN). */
export const POOL_STATE_USER_HIDDEN = 8;
/** Member of the active isolation set; with isolation on, only members draw. */
export const POOL_STATE_ISOLATED = 16;
export const POOL_STATE_PALETTE_SHIFT = 16;
export const POOL_PALETTE_MAX = 0xffff;

const RECORD_WORDS = INSTANCE_STRIDE_BYTES / 4; // 22
export const CULL_FLOATS = 8;
export const CULL_BYTES = CULL_FLOATS * 4;
export const ARGS_WORDS = 5;
export const PARAMS_BYTES = 192;
export const WORKGROUP = 64;
const MAX_WG_X = 65535;
/** Finite stand-in for "never cull" (WGSL may assume no infinities). */
export const UNBOUNDED_RADIUS = 3.0e38;

const PARAM_FLAG_FRUSTUM = 1;
const PARAM_FLAG_CONTRIB = 2;
const PARAM_FLAG_ORTHO = 4;
const PARAM_FLAG_ISOLATION = 8;

export const gpuInstanceCullWgsl = /* wgsl */ `
struct Params {
  eyeHi: vec4<f32>,
  eyeLo: vec4<f32>,
  planes: array<vec4<f32>, 6>,
  viewDir: vec4<f32>,   // xyz view direction, w projection scale (px per unit radius at unit depth)
  misc: vec4<f32>,      // x contribution threshold px, y RTE envelope, z = 1.0 (opaque to the compiler)
  counts: vec4<u32>,    // x occurrences, y groups, z flags, w palette offset (words) in meta
  dispatch: vec4<u32>,  // x workgroups along x
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> srcRecords: array<u32>;
@group(0) @binding(2) var<storage, read> srcCull: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> occState: array<u32>;
@group(0) @binding(4) var<storage, read> poolMeta: array<u32>;
@group(0) @binding(5) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> outRecords: array<u32>;
@group(0) @binding(7) var<storage, read_write> outDeltas: array<vec4<f32>>;

const STATE_SELECTED: u32 = ${POOL_STATE_SELECTED}u;
const STATE_REJECT: u32 = ${POOL_STATE_HIDDEN | POOL_STATE_DEAD | POOL_STATE_USER_HIDDEN}u;
const STATE_ISOLATED: u32 = ${POOL_STATE_ISOLATED}u;
const FLAG_ISOLATION: u32 = ${PARAM_FLAG_ISOLATION}u;
const FLAG_FRUSTUM: u32 = ${PARAM_FLAG_FRUSTUM}u;
const FLAG_CONTRIB: u32 = ${PARAM_FLAG_CONTRIB}u;
const FLAG_ORTHO: u32 = ${PARAM_FLAG_ORTHO}u;
const RECORD_WORDS: u32 = ${RECORD_WORDS}u;
const COLOR_WORD: u32 = ${INSTANCE_COLOR_OFFSET / 4}u;
const FLAGS_WORD: u32 = ${INSTANCE_FLAGS_OFFSET / 4}u;

@compute @workgroup_size(${WORKGROUP})
fn resetArgs(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < P.counts.y) {
    atomicStore(&args[id.x * ${ARGS_WORDS}u + 1u], 0u);
  }
}

// Error-free sum: s + e == a + b exactly (Knuth TwoSum, no magnitude precondition).
// The sum is scaled by a RUNTIME 1.0 (P.misc.z): a driver compiler that may
// reassociate (NVIDIA Vulkan did, measured) can otherwise prove s == a + b
// and fold the error term to zero.
fn twoSum(a0: vec3<f32>, b0: vec3<f32>) -> array<vec3<f32>, 2> {
  // Every intermediate is fenced by the runtime 1.0: no reassociation can cross a multiply by an unknown.
  let k = P.misc.z;
  let a = a0 * k;
  let b = b0 * k;
  let s = (a + b) * k;
  let bb = (s - a) * k;
  let av = (s - bb) * k;
  let e = ((a - av) * k) + ((b - bb) * k);
  return array<vec3<f32>, 2>(s, e);
}

@compute @workgroup_size(${WORKGROUP})
fn cull(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = (wg.y * P.dispatch.x + wg.x) * ${WORKGROUP}u + li;
  if (i >= P.counts.x) { return; }
  let st = occState[i];
  if ((st & STATE_REJECT) != 0u) { return; }
  if ((P.counts.z & FLAG_ISOLATION) != 0u && (st & STATE_ISOLATED) == 0u) { return; }
  let c0 = srcCull[i * 2u];
  let c1 = srcCull[i * 2u + 1u];
  // Both high parts sit on the same f32 grid near the model, so their
  // difference is exact; the low parts carry the f64 residual.
  let split = twoSum(c0.xyz - P.eyeHi.xyz, c1.xyz - P.eyeLo.xyz);
  let d = split[0];
  let radius = c0.w;
  let group = bitcast<u32>(c1.w);
  // Same eye envelope the CPU packer enforces (#6128).
  if (any(abs(d) > vec3<f32>(P.misc.y))) { return; }
  let selected = (st & STATE_SELECTED) != 0u;
  if ((P.counts.z & FLAG_FRUSTUM) != 0u) {
    for (var k = 0u; k < 6u; k = k + 1u) {
      let pl = P.planes[k];
      if (dot(pl.xyz, d) + pl.w < -radius) { return; }
    }
  }
  if ((P.counts.z & FLAG_CONTRIB) != 0u && !selected && radius < 1.0e37) {
    var px = 1.0e30;
    if ((P.counts.z & FLAG_ORTHO) != 0u) {
      px = radius * P.viewDir.w;
    } else {
      let depth = dot(d, P.viewDir.xyz);
      if (depth > radius) { px = radius / depth * P.viewDir.w; }
    }
    if (px < P.misc.x) { return; }
  }
  let slot = atomicAdd(&args[group * ${ARGS_WORDS}u + 1u], 1u);
  let dst = poolMeta[group] + slot;
  let s = i * RECORD_WORDS;
  let o = dst * RECORD_WORDS;
  for (var w = 0u; w < COLOR_WORD; w = w + 1u) { outRecords[o + w] = srcRecords[s + w]; }
  let pal = st >> ${POOL_STATE_PALETTE_SHIFT}u;
  if (pal != 0u) {
    let p = P.counts.w + pal * 4u;
    outRecords[o + COLOR_WORD] = poolMeta[p];
    outRecords[o + COLOR_WORD + 1u] = poolMeta[p + 1u];
    outRecords[o + COLOR_WORD + 2u] = poolMeta[p + 2u];
    outRecords[o + COLOR_WORD + 3u] = poolMeta[p + 3u];
  } else {
    outRecords[o + COLOR_WORD] = srcRecords[s + COLOR_WORD];
    outRecords[o + COLOR_WORD + 1u] = srcRecords[s + COLOR_WORD + 1u];
    outRecords[o + COLOR_WORD + 2u] = srcRecords[s + COLOR_WORD + 2u];
    outRecords[o + COLOR_WORD + 3u] = srcRecords[s + COLOR_WORD + 3u];
  }
  // The source flags carry only finish bits; hidden never survives compaction.
  outRecords[o + FLAGS_WORD] = (srcRecords[s + FLAGS_WORD] & ~3u) | select(0u, 1u, selected);
  outDeltas[dst * 2u] = vec4<f32>(d, 0.0);
  outDeltas[dst * 2u + 1u] = vec4<f32>(split[1], 0.0);
}
`;

/** f64 → (high, low) f32 split, the same rounding `splitFloat64ForRte` uses. */
export function splitHiLo(value: number): [number, number] {
  const hi = Math.fround(value);
  return [hi, Math.fround(value - hi)];
}


/** The camera projection the contribution cull converts a sphere radius to screen px with. */
export interface PoolCullProjection {
  viewDir: { x: number; y: number; z: number };
  ortho: boolean;
  fovYRadians: number;
  orthoHalfHeight: number;
  viewportHeightPx: number;
}

export interface PoolCullParams {
  /** f64 eye (RTE camera world): the compacted deltas are relative to it. */
  eye: readonly [number, number, number];
  /** Six normalized eye-relative planes, inside where `n·p + d >= 0`; null disables frustum culling. */
  planes: ReadonlyArray<{ normal: readonly [number, number, number]; distance: number }> | null;
  /** Contribution threshold in CSS px; 0 (or no `projection`) disables it. */
  thresholdPx: number;
  projection?: PoolCullProjection;
}

/**
 * Radius of a sphere centred on occurrence `i`'s canonical anchor that holds
 * its world box. Anchoring the sphere (not the box centre) keeps it valid
 * under any rigid placement, so a move re-uploads anchors only.
 */
export function occurrenceSphereRadius(w: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, anchors: Float64Array, i: number): number {
  const ax = anchors[i * 3]!, ay = anchors[i * 3 + 1]!, az = anchors[i * 3 + 2]!;
  const cx = (w.minX + w.maxX) * 0.5 - ax, cy = (w.minY + w.maxY) * 0.5 - ay, cz = (w.minZ + w.maxZ) * 0.5 - az;
  const hx = (w.maxX - w.minX) * 0.5, hy = (w.maxY - w.minY) * 0.5, hz = (w.maxZ - w.minZ) * 0.5;
  const r = Math.sqrt(cx * cx + cy * cy + cz * cz) + Math.sqrt(hx * hx + hy * hy + hz * hz);
  // Float32 rounding of the stored radius must not shrink it below the box.
  return Number.isFinite(r) ? r * (1 + 1e-6) + 1e-6 : Infinity;
}

/** Pack the cull uniform for camera `p`; returns the 2D dispatch size covering `count` occurrences. */
export function packCullParams(params: ArrayBuffer, p: PoolCullParams, count: number, groups: number, isolation: boolean, paletteOffsetWords: number): { wx: number; wy: number } {
  const f = new Float32Array(params);
  const u = new Uint32Array(params);
  const [exh, exl] = splitHiLo(p.eye[0]), [eyh, eyl] = splitHiLo(p.eye[1]), [ezh, ezl] = splitHiLo(p.eye[2]);
  f[0] = exh; f[1] = eyh; f[2] = ezh; f[3] = 0;
  f[4] = exl; f[5] = eyl; f[6] = ezl; f[7] = 0;
  let flags = 0;
  if (p.planes && p.planes.length === 6) {
    flags |= PARAM_FLAG_FRUSTUM;
    for (let k = 0; k < 6; k++) {
      const pl = p.planes[k]!;
      f.set([pl.normal[0], pl.normal[1], pl.normal[2], pl.distance], 8 + k * 4);
    }
  }
  const proj = p.projection;
  const halfViewport = proj ? proj.viewportHeightPx * 0.5 : 0;
  let scale = 0;
  if (proj?.ortho) {
    if (proj.orthoHalfHeight > 0) scale = halfViewport / proj.orthoHalfHeight;
    flags |= PARAM_FLAG_ORTHO;
  } else if (proj) {
    const t = Math.tan(proj.fovYRadians * 0.5);
    if (t > 0) scale = halfViewport / t;
  }
  const dir = proj?.viewDir ?? { x: 0, y: 0, z: 0 };
  const dirLen = Math.hypot(dir.x, dir.y, dir.z);
  if (isolation) flags |= PARAM_FLAG_ISOLATION;
  if (p.thresholdPx > 0 && scale > 0 && halfViewport > 0 && (proj?.ortho || dirLen > 0.5)) flags |= PARAM_FLAG_CONTRIB;
  f[32] = dir.x; f[33] = dir.y; f[34] = dir.z; f[35] = scale;
  f[36] = p.thresholdPx; f[37] = MAX_RTE_EYE_RELATIVE_METRES; f[38] = 1; f[39] = 0;
  const workgroups = Math.ceil(count / WORKGROUP);
  const wx = Math.min(workgroups, MAX_WG_X);
  const wy = Math.ceil(workgroups / wx);
  u[40] = count; u[41] = groups; u[42] = flags; u[43] = paletteOffsetWords;
  u[44] = wx; u[45] = 0; u[46] = 0; u[47] = 0;
  return { wx, wy };
}

/** The camera reads the cull needs (`Camera` satisfies it). */
export interface PoolCullCamera {
  getPosition(): { x: number; y: number; z: number };
  getTarget(): { x: number; y: number; z: number };
  getProjectionMode(): string;
  getFOV(): number;
  getOrthoSize(): number;
}

/** Cull inputs for `camera`, mirroring the CPU batch culls: `eye` is the f64 RTE camera, `planes` its eye-relative frustum. */
export function poolCullParams(camera: PoolCullCamera, eye: readonly [number, number, number], planes: PoolCullParams['planes'],
  thresholdPx: number, viewportHeightPx: number): PoolCullParams {
  const from = camera.getPosition(), to = camera.getTarget();
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    eye, planes, thresholdPx,
    projection: {
      viewDir: len > 0 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 0 },
      ortho: camera.getProjectionMode() === 'orthographic',
      fovYRadians: camera.getFOV(),
      orthoHalfHeight: camera.getOrthoSize(),
      viewportHeightPx,
    },
  };
}

/**
 * Cull views. Each has its own uniform, so several culls can be recorded into
 * one encoder (each before the pass that reads its output): the colour view's
 * camera, the sun shadow (every live occurrence casts), and a pick.
 */
export const POOL_VIEW_COLOUR = 0, POOL_VIEW_SHADOW = 1, POOL_VIEW_PICK = 2;
export type PoolCullView = typeof POOL_VIEW_COLOUR | typeof POOL_VIEW_SHADOW | typeof POOL_VIEW_PICK;
