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
 * To fix that, the renderer promotes the base draw of overridden entities
 * to the opaque pipeline so depth gets written and the overlay paint
 * succeeds. To avoid turning non-overridden batchmates opaque, batches
 * with mixed override membership are split into a "promoted" sub-batch
 * (all overridden) and a "remaining" sub-batch (all not), each routed
 * through its appropriate pipeline.
 *
 * These helpers express the routing decision as pure functions so they
 * can be unit-tested without a GPU device. See issue #677.
 */

export type RGBAOverrideMap = ReadonlyMap<number, readonly [number, number, number, number]>;

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
  colorOverrides: RGBAOverrideMap | null,
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
 * pipeline. A batch is promoted to opaque **only when every id in it** carries
 * a deliberate override — i.e. when promotion can't make any unrelated
 * batchmate opaque. Mixed batches must be split upstream via
 * {@link splitVisibleIdsByPromotion}; the splitter calls this helper on each
 * homogeneous sub-batch.
 *
 * @param alpha          Resolved batch alpha (post `transparencyOverrides`).
 * @param expressIds     The (sub-)batch's expressIds.
 * @param colorOverrides Active lens / Pset override map, or null when none.
 */
export function shouldRouteBatchTransparent(
  alpha: number,
  expressIds: ReadonlyArray<number>,
  colorOverrides: RGBAOverrideMap | null,
): boolean {
  if (alpha >= OPAQUE_ALPHA_CUTOFF) return false;
  if (colorOverrides == null || colorOverrides.size === 0 || expressIds.length === 0) {
    return true;
  }
  // Promote ONLY when every id carries a deliberate override. Mixed batches
  // must be split upstream — promoting them whole would turn non-overridden
  // batchmates opaque (regression flagged on PR #682).
  for (const eid of expressIds) {
    const override = colorOverrides.get(eid);
    if (override == null || override[3] < OVERRIDE_PROMOTION_MIN_ALPHA) return true;
  }
  return false;
}

/**
 * Partition a visible-id set into the subset that needs opaque-pipeline
 * promotion (deliberate colour overrides, alpha ≥ 0.2) and the rest.
 *
 * Used by the renderer's batch loop when a transparent parent batch has
 * mixed override membership: each subset becomes its own partial sub-batch
 * so non-overridden batchmates keep their native transparent routing.
 *
 * Returns `null` when no split is needed — either the override map is empty
 * or no id in `visibleIds` carries a deliberate override. The caller should
 * then route the whole input through its native pipeline.
 */
export function splitVisibleIdsByPromotion(
  visibleIds: Iterable<number>,
  colorOverrides: RGBAOverrideMap | null,
): { promoted: Set<number>; remaining: Set<number> } | null {
  if (colorOverrides == null || colorOverrides.size === 0) return null;
  const promoted = new Set<number>();
  const remaining = new Set<number>();
  for (const id of visibleIds) {
    const o = colorOverrides.get(id);
    if (o != null && o[3] >= OVERRIDE_PROMOTION_MIN_ALPHA) promoted.add(id);
    else remaining.add(id);
  }
  if (promoted.size === 0) return null;
  return { promoted, remaining };
}
