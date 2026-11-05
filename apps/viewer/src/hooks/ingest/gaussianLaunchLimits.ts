/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The published Gaussian capture limits (#8568). This is the only place they
 * are defined: admission, the decoder, the scene budget, the user guide
 * (`docs/guide/gaussian-captures.md`) and the release doc all refer to these.
 * Each is enforced before the capture is decoded or uploaded.
 */
export const GAUSSIAN_LAUNCH_LIMITS = Object.freeze({
  /** One capture file, in bytes (500 MB, decimal). */
  maxCaptureBytes: 500_000_000,
  /** Logical scene splats: one share per capture, including in-flight loads.
   * A reload holds max(old, new) once through swap/rollback; temporary renderer
   * allocations can overlap, so this is not a simultaneous allocation bound. */
  maxSceneSplats: 1_000_000,
  /** Highest spherical-harmonics degree accepted (PLY `f_rest_*` up to 45 columns). */
  maxShDegree: 3,
});

/** Which launch limit refused a capture. Counts come from the header, never the payload. */
export type GaussianLimitBreach =
  | { limit: 'capture-bytes'; bytes: number }
  | { limit: 'capture-splats'; count: number }
  | { limit: 'sh-degree'; degree: number };

/** Spherical-harmonics degree implied by a PLY `f_rest_*` column count, or -1. */
export function shDegreeForRestColumns(columns: number): number {
  for (let degree = 0; degree <= 8; degree++) if (3 * ((degree + 1) ** 2 - 1) === columns) return degree;
  return -1;
}

/** The per-capture limit a header breaks, checked in the order a user can act on. */
export function captureLimitBreach(bytes: number, count: number, shDegree: number): GaussianLimitBreach | undefined {
  if (bytes > GAUSSIAN_LAUNCH_LIMITS.maxCaptureBytes) return { limit: 'capture-bytes', bytes };
  if (count > GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats) return { limit: 'capture-splats', count };
  if (shDegree > GAUSSIAN_LAUNCH_LIMITS.maxShDegree) return { limit: 'sh-degree', degree: shDegree };
  return undefined;
}
