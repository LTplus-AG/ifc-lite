/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Routing predicates for the opaque/transparent pipeline split.
 *
 * Lens / Pset colour overrides are drawn by a second "overlay paint" pass
 * whose pipeline uses `depthCompare: 'equal'` so it only paints where the
 * base draw already wrote depth. The transparent pipeline runs with
 * `depthWriteEnabled: false`, so a colour override on an entity whose base
 * draw is transparent (IfcSpace, IfcOpeningElement, glass, …) silently
 * fails — the equality test never matches.
 *
 * To fix that, the renderer promotes any mesh or batch carrying a colour
 * override to the opaque pipeline, regardless of its native alpha. The
 * base draw then writes depth and the overlay paint succeeds.
 *
 * These helpers express that decision as pure functions so they can be
 * unit-tested without a GPU device. See issue #677 for the bug they fix.
 */

const OPAQUE_ALPHA_CUTOFF = 0.99;

/**
 * Minimum override alpha that triggers opaque-pipeline promotion.
 *
 * Lens "ghost" colours used to fade unmatched entities sit at alpha 0.15
 * (see `packages/lens/src/colors.ts`). Promoting a ghost overlay would
 * cause a previously-near-invisible IfcSpace to render as an opaque
 * cyan box with a faint gray tint — a regression for users running lens
 * rules that don't target IfcSpace. Anything at this threshold or above
 * was clearly a deliberate colour choice (colorize, transparent action,
 * IDS pass/fail) and gets promoted; ghost-tier overlays are left in the
 * native transparent path (where they remain invisible, same as today).
 */
const OVERRIDE_PROMOTION_MIN_ALPHA = 0.2;

/**
 * Decide whether a mesh should render through the transparent pipeline.
 *
 * @param alpha          Resolved alpha for the mesh (post `transparencyOverrides`).
 * @param transparency   Optional PBR transparency (IfcSurfaceStyleRendering).
 * @param expressId      The mesh's expressId, used to consult `colorOverrides`.
 * @param colorOverrides Active lens / Pset override map, or null when none.
 *
 * @returns `true` if the mesh should route to the transparent pipeline.
 *          `false` means route to the opaque pipeline (writes depth).
 */
export function shouldRouteMeshTransparent(
  alpha: number,
  transparency: number,
  expressId: number,
  colorOverrides: Map<number, [number, number, number, number]> | null,
): boolean {
  const nativelyTransparent = alpha < OPAQUE_ALPHA_CUTOFF || transparency > 0.01;
  if (!nativelyTransparent) return false;
  // Lens / Pset override above the ghost threshold → promote to opaque
  // so the overlay paint (depthCompare 'equal') has matching depth.
  if (colorOverrides != null) {
    const override = colorOverrides.get(expressId);
    if (override != null && override[3] >= OVERRIDE_PROMOTION_MIN_ALPHA) return false;
  }
  return true;
}

/**
 * Decide whether a batch (or sub-batch) should render through the transparent
 * pipeline. A batch is promoted to opaque if *any* of its expressIds carries
 * a colour override — the overlay paint pass only paints the overridden ids,
 * and non-overridden ids in the same batch render with their batch colour
 * through the opaque pipeline.
 *
 * @param alpha          Resolved batch alpha (post `transparencyOverrides`).
 * @param expressIds     The batch's expressIds.
 * @param colorOverrides Active lens / Pset override map, or null when none.
 */
export function shouldRouteBatchTransparent(
  alpha: number,
  expressIds: ReadonlyArray<number>,
  colorOverrides: Map<number, [number, number, number, number]> | null,
): boolean {
  if (alpha >= OPAQUE_ALPHA_CUTOFF) return false;
  if (colorOverrides != null && colorOverrides.size > 0) {
    for (const eid of expressIds) {
      const override = colorOverrides.get(eid);
      if (override != null && override[3] >= OVERRIDE_PROMOTION_MIN_ALPHA) return false;
    }
  }
  return true;
}
