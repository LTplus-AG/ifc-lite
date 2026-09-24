/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU side of the screen-space ambient occlusion pass (#5384): quality
 * presets, the sampling kernel and the uniform layout shared with
 * `shaders/ao.wgsl.ts`. Pure functions, so the numbers the GPU sees are
 * unit-tested.
 */

import { depthReconstructParams, pixelsPerWorldUnit } from './depth-reconstruct.js';
import type { ContactShadingQuality, Mat4 } from './types.js';

export type AoQuality = Exclude<ContactShadingQuality, 'off'>;

export interface AoQualityPreset {
  /** AO target is the drawing buffer divided by this (2 = half resolution). */
  resolutionDivisor: 1 | 2;
  /** Depth taps per AO texel. */
  samples: number;
  /** Turns of the sampling spiral; coprime-ish with `samples` so taps do not line up. */
  spiralTurns: number;
}

export const AO_QUALITY_PRESETS: Readonly<Record<AoQuality, AoQualityPreset>> = {
  low: { resolutionDivisor: 2, samples: 12, spiralTurns: 5 },
  high: { resolutionDivisor: 1, samples: 16, spiralTurns: 7 },
};

/** Kernel slots in the uniform; every preset must fit. */
export const AO_MAX_SAMPLES = 16;

/**
 * Accepted `contactShading.radius`, in world units (metres for IFC models,
 * which the geometry pipeline normalises to metres).
 */
export const AO_RADIUS_RANGE = { min: 0.05, max: 10 } as const;

/**
 * Cap on the projected radius, as a fraction of the drawing-buffer height.
 * Close to the camera a 1 m radius covers most of the screen; the cap keeps
 * the taps local (and texture-cache friendly) at the cost of a smaller
 * effective radius there.
 */
export const AO_MAX_RADIUS_FRACTION = 0.15;

/**
 * Cosine bias: a tap must rise at least this far above the tangent plane to
 * occlude. Suppresses self-occlusion from depth quantisation on flat faces.
 */
export const AO_COSINE_BIAS = 0.1;

/**
 * Relative depth difference at which the bilateral blur and the upsample
 * stop mixing two AO texels (a silhouette or a step, not the same surface).
 */
export const AO_DEPTH_TOLERANCE = 0.04;

/**
 * The composite darkens by `min(occlusion * AO_GAIN * intensity,
 * AO_MAX_DARKEN)`. `occlusion` is the tap average in [0, 1]: 1 would need
 * every tap straight above the tangent plane and at zero distance, so real
 * corners read well below it and the gain lifts them into view.
 */
export const AO_GAIN = 2.0;

/** Darkening never exceeds this, so a crevice keeps its colour. */
export const AO_MAX_DARKEN = 0.85;

/** Size of the AO target for a drawing buffer at `quality`. */
export function aoTargetSize(width: number, height: number, quality: AoQuality): { width: number; height: number } {
  const d = AO_QUALITY_PRESETS[quality].resolutionDivisor;
  return { width: Math.max(1, Math.ceil(width / d)), height: Math.max(1, Math.ceil(height / d)) };
}

/**
 * Unit-disk sample offsets on a spiral (the SAO pattern): tap `i` sits at
 * radius `(i + 0.5) / samples` and angle `radius * turns * 2pi`. Radii grow
 * linearly, so taps crowd towards the centre where contact occlusion lives.
 * Returns `AO_MAX_SAMPLES` (x, y) pairs; slots past `samples` are zero.
 */
export function spiralKernel(samples: number, turns: number): Float32Array {
  if (!Number.isInteger(samples) || samples < 1 || samples > AO_MAX_SAMPLES) {
    throw new RangeError(`AO sample count must be an integer in [1, ${AO_MAX_SAMPLES}], got ${samples}`);
  }
  const out = new Float32Array(AO_MAX_SAMPLES * 2);
  for (let i = 0; i < samples; i++) {
    const r = (i + 0.5) / samples;
    const a = r * turns * 2 * Math.PI;
    out[i * 2] = r * Math.cos(a);
    out[i * 2 + 1] = r * Math.sin(a);
  }
  return out;
}

/** Each preset's kernel, built once. */
const PRESET_KERNELS: Readonly<Record<AoQuality, Float32Array>> = {
  low: spiralKernel(AO_QUALITY_PRESETS.low.samples, AO_QUALITY_PRESETS.low.spiralTurns),
  high: spiralKernel(AO_QUALITY_PRESETS.high.samples, AO_QUALITY_PRESETS.high.spiralTurns),
};

/** Float offsets of the `AoParams` struct fields in `shaders/ao.wgsl.ts`. */
export const AO_UNIFORM_LAYOUT = {
  depthParams: 0,
  xyParams: 4,
  viewport: 8,
  ao: 12,
  misc: 16,
  kernel: 20,
} as const;

/** Byte size of `AoParams` (13 vec4s: five of parameters, eight of kernel). */
export const AO_UNIFORM_BYTES = (AO_UNIFORM_LAYOUT.kernel + AO_MAX_SAMPLES * 2) * 4;

export interface AoFrameParams {
  /** Camera projection the frame was drawn with (reverse-Z). */
  projection: Mat4;
  /** Drawing-buffer size in pixels. */
  width: number;
  height: number;
  quality: AoQuality;
  /** World-space radius, already clamped to `AO_RADIUS_RANGE`. */
  radius: number;
  /** Darkening strength, already clamped to [0, 1]. */
  intensity: number;
}

/** Pack one frame's `AoParams` into `out` (`AO_UNIFORM_BYTES / 4` floats). */
export function packAoUniforms(out: Float32Array, frame: AoFrameParams): void {
  const preset = AO_QUALITY_PRESETS[frame.quality];
  const recon = depthReconstructParams(frame.projection);
  const L = AO_UNIFORM_LAYOUT;
  out.set(recon.depth, L.depthParams);
  out.set(recon.xy, L.xyParams);
  out[L.viewport] = frame.width;
  out[L.viewport + 1] = frame.height;
  out[L.viewport + 2] = 1 / frame.width;
  out[L.viewport + 3] = 1 / frame.height;
  out[L.ao] = frame.radius;
  out[L.ao + 1] = pixelsPerWorldUnit(frame.projection, frame.height);
  out[L.ao + 2] = AO_MAX_RADIUS_FRACTION * frame.height;
  out[L.ao + 3] = frame.intensity;
  out[L.misc] = preset.resolutionDivisor;
  out[L.misc + 1] = preset.samples;
  out[L.misc + 2] = AO_COSINE_BIAS;
  out[L.misc + 3] = AO_DEPTH_TOLERANCE;
  out.set(PRESET_KERNELS[frame.quality], L.kernel);
}
