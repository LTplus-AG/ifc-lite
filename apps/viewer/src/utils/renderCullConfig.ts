/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contribution-culling configuration for the viewport render loop
 * (issue #1682).
 *
 * Defaults are deliberately conservative: a colour batch is only skipped when
 * its ENTIRE world AABB projects to under half a device pixel at rest (2 px
 * while the camera moves). With today's model-wide colour batches this fires
 * only when a whole colour group is far off in the distance; it becomes the
 * real draw-call/vertex-load lever once batches are spatially chunked
 * (phase 2 of the residency plan).
 *
 * Override / kill switch (benchmark A/B + console debugging), read once per
 * viewer session:
 *   globalThis.__IFC_LITE_CONTRIB_CULL = 0                     // disable
 *   globalThis.__IFC_LITE_CONTRIB_CULL = 1.5                   // rest px (interacting = 4x)
 *   globalThis.__IFC_LITE_CONTRIB_CULL = { pixelRadius: 1, interactingPixelRadius: 3 }
 */

import type { ContributionCullOptions } from '@ifc-lite/renderer';

export const DEFAULT_CONTRIBUTION_CULL: ContributionCullOptions = {
  pixelRadius: 0.5,
  interactingPixelRadius: 2,
};

/** Multiplier applied to a bare-number override to derive the interacting threshold. */
const INTERACTING_FACTOR = 4;

/**
 * Resolve the session's contribution-cull options from the optional
 * `__IFC_LITE_CONTRIB_CULL` global. Returns `undefined` when culling is
 * disabled (renderer treats absent options as off).
 */
export function getContributionCullConfig(): ContributionCullOptions | undefined {
  const raw = (globalThis as { __IFC_LITE_CONTRIB_CULL?: unknown }).__IFC_LITE_CONTRIB_CULL;
  if (raw === undefined || raw === null) return DEFAULT_CONTRIBUTION_CULL;
  if (raw === false || raw === 0) return undefined;
  // Only finite positive thresholds are meaningful — Infinity/NaN would cull
  // everything (or nothing deterministically), so they disable instead.
  const finitePositive = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (typeof raw === 'number') {
    if (!finitePositive(raw)) return undefined;
    return { pixelRadius: raw, interactingPixelRadius: raw * INTERACTING_FACTOR };
  }
  if (typeof raw === 'object') {
    const cfg = raw as Partial<ContributionCullOptions>;
    if (finitePositive(cfg.pixelRadius)) {
      return {
        pixelRadius: cfg.pixelRadius,
        interactingPixelRadius: finitePositive(cfg.interactingPixelRadius)
          ? cfg.interactingPixelRadius
          : cfg.pixelRadius * INTERACTING_FACTOR,
      };
    }
    return undefined;
  }
  console.warn('[renderCullConfig] ignoring invalid __IFC_LITE_CONTRIB_CULL:', raw);
  return DEFAULT_CONTRIBUTION_CULL;
}
