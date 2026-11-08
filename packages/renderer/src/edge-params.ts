/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU side of the edge pass (#5385): quality presets and the uniform layout
 * shared with `shaders/edges.wgsl.ts`. Pure functions, so the numbers the
 * GPU sees are unit-tested. Reuses `depth-reconstruct.ts` for the projection
 * params the shader needs to rebuild view-space position and normals from
 * depth, the same way `ao-params.ts` does (#5384).
 *
 * The old separation-line pass fired only on an entity-id change, read raw
 * (non-linear, reverse-Z) depth a fixed 1-3 px apart, and thresholded that
 * difference as a hard boolean, which is why storey joints on a flat facade
 * flickered into dashes (the per-pixel slope crosses the threshold, not the
 * geometry). This pass instead:
 *  - also fires on a normal crease (a real angle, not a coplanar seam) and a
 *    depth silhouette, both in linear view-space units;
 *  - tests every MSAA sample and darkens by the fraction of samples on a
 *    line (any tap direction across an edge), so a line antialiases with
 *    the geometry instead of dashing or stepping.
 */

import { depthReconstructParams } from './depth-reconstruct.js';
import type { Mat4, SeparationLinesQuality } from './types.js';

export type EdgeQuality = Exclude<SeparationLinesQuality, 'off'>;

export interface EdgeQualityPreset {
  /** Tap directions: 4 (cardinal) at low, 8 (+ diagonals) at high. */
  directions: 4 | 8;
}

export const EDGE_QUALITY_PRESETS: Readonly<Record<EdgeQuality, EdgeQualityPreset>> = {
  low: { directions: 4 },
  high: { directions: 8 },
};

/** Crease angle (degrees) above which two adjacent face normals draw an edge. */
export const EDGE_CREASE_ANGLE_DEG = 25;
export const EDGE_CREASE_COS = Math.cos((EDGE_CREASE_ANGLE_DEG * Math.PI) / 180);

/**
 * Relative view-space depth jump (fraction of the nearer depth) above which
 * a step reads as a silhouette rather than a coplanar seam. Linear (view
 * space), unlike the old pass's threshold over raw reverse-Z depth, so it
 * does not need a slope-aware fallback to avoid grazing-angle false edges.
 */
export const EDGE_SILHOUETTE_REL_THRESHOLD = 0.01;

/** Darkening never exceeds this, matching the old separation-line cap. */
export const EDGE_MAX_DARKEN = 0.35;

/**
 * MSAA samples the pass tests per pixel on a multisampled target: the
 * renderer's sample count (`pipeline.ts` caps it at 4, the only multisample
 * count WebGPU guarantees). A single-sampled target tests its one sample.
 */
export const EDGE_SAMPLE_COUNT = 4;

/**
 * Darkening of a fully covered line pixel, per unit of intensity.
 *
 * The pass once darkened by the mean of its directions' 0/1 votes: 1 of 4 (or
 * 3 of 8 at `high`) beside an axis-aligned edge, but on a sloped edge the
 * stair-step pixels took a second vote and a one-sided normal fit misread
 * pixels near the crease, so sloped lines, most lines in a perspective view,
 * drew about four times darker than axis-aligned ones. Half the intensity
 * (three quarters at `high`, the old 1.5 ratio) puts every line, at any
 * angle, between the two: axis-aligned lines twice the old weight, sloped
 * lines half their old average, and uniform along their length.
 */
export const EDGE_LINE_WEIGHT: Readonly<Record<EdgeQuality, number>> = {
  low: 1 / 2,
  high: 3 / 4,
};

/** Float offsets of the `EdgeParams` struct fields in `shaders/edges.wgsl.ts`. */
export const EDGE_UNIFORM_LAYOUT = {
  depthParams: 0,
  xyParams: 4,
  shearParams: 8,
  viewport: 12,
  edge: 16,
} as const;

/** Byte size of `EdgeParams` (5 vec4s). */
export const EDGE_UNIFORM_BYTES = (EDGE_UNIFORM_LAYOUT.edge + 4) * 4;

export interface EdgeFrameParams {
  /** Camera projection the frame was drawn with (reverse-Z). */
  projection: Mat4;
  /** Drawing-buffer size in pixels. */
  width: number;
  height: number;
  quality: EdgeQuality;
  /** Tap distance in pixels, already scaled by device pixel ratio. */
  radiusPx: number;
  /** Darkening strength, already clamped to [0, 1]. */
  intensity: number;
}

/** Pack one frame's `EdgeParams` into `out` (`EDGE_UNIFORM_BYTES / 4` floats). */
export function packEdgeUniforms(out: Float32Array, frame: EdgeFrameParams): void {
  const recon = depthReconstructParams(frame.projection);
  const L = EDGE_UNIFORM_LAYOUT;
  out.set(recon.depth, L.depthParams);
  out.set(recon.xy, L.xyParams);
  out.set(recon.shear, L.shearParams);
  out[L.viewport] = frame.width;
  out[L.viewport + 1] = frame.height;
  out[L.viewport + 2] = 1 / frame.width;
  out[L.viewport + 3] = 1 / frame.height;
  out[L.edge] = Math.max(1, frame.radiusPx);
  out[L.edge + 1] = frame.intensity;
  out[L.edge + 2] = EDGE_QUALITY_PRESETS[frame.quality].directions === 8 ? 1 : 0;
  out[L.edge + 3] = 0;
}
