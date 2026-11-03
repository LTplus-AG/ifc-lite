/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel } from '@/store';
import { GAUSSIAN_LAUNCH_LIMITS } from './gaussianLaunchLimits.js';
import { gaussianModelState, gaussianNeedsReload } from './gaussianAssets.js';

/** Splats of loads that passed the budget but are not yet published and adopted. */
const reservations = new Set<{ count: number; replacing?: string }>();

/**
 * Splats the scene holds now: published captures whose renderer asset is
 * still live (resident, or pending re-upload after a device loss). A failed or
 * orphaned capture holds no renderer rows, so reloading it is not double-counted.
 */
export function residentSceneSplats(models: ReadonlyMap<string, FederatedModel>, excluded = new Set<string>()): number {
  let total = 0;
  for (const model of models.values()) {
    if (!excluded.has(model.id) && model.gaussianSplat && !gaussianNeedsReload(gaussianModelState(model))) total += model.gaussianSplat.count;
  }
  return total;
}

export type SceneSplatReservation =
  | { ok: true; release(): void }
  | { ok: false; total: number; limit: number };

/**
 * Hold `count` splats of the per-scene budget for one load, before it decodes.
 * Concurrent loads each see the others' holds. `release` once the capture is
 * adopted (the store now counts it) or the load ends; it is idempotent.
 */
export function reserveSceneSplats(count: number, models: ReadonlyMap<string, FederatedModel>, replacing?: string): SceneSplatReservation {
  const excluded = new Set<string>();
  let reserved = 0;
  for (const hold of reservations) {
    reserved += hold.count;
    if (hold.replacing) excluded.add(hold.replacing);
  }
  // One reservation owns a replacement; do not grant a second discount.
  if (replacing && !excluded.has(replacing)) excluded.add(replacing);
  // Keep the original share until swap commits: a shrinking replacement may
  // fail, so concurrent loads cannot spend the rows it would eventually free.
  const original = replacing ? models.get(replacing) : undefined;
  const heldCount = Math.max(count, original?.gaussianSplat && !gaussianNeedsReload(gaussianModelState(original))
    ? original.gaussianSplat.count : 0);
  const total = residentSceneSplats(models, excluded) + reserved + heldCount;
  if (total > GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats) return { ok: false, total, limit: GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats };
  const hold = { count: heldCount, replacing };
  reservations.add(hold);
  return { ok: true, release() { reservations.delete(hold); } };
}
