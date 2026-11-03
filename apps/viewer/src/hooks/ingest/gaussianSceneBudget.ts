/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel } from '@/store';
import { GAUSSIAN_LAUNCH_LIMITS } from './gaussianLaunchLimits.js';
import { gaussianModelState, gaussianNeedsReload } from './gaussianAssets.js';

/** Splats of loads that passed the budget but are not yet published and adopted. */
let reserved = 0;

/**
 * Splats the scene holds now: published captures whose renderer asset is
 * still live (resident, or pending re-upload after a device loss). A failed or
 * orphaned capture holds no renderer rows, so reloading it is not double-counted.
 */
export function residentSceneSplats(models: ReadonlyMap<string, FederatedModel>): number {
  let total = 0;
  for (const model of models.values()) {
    if (model.gaussianSplat && !gaussianNeedsReload(gaussianModelState(model))) total += model.gaussianSplat.count;
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
export function reserveSceneSplats(count: number, models: ReadonlyMap<string, FederatedModel>): SceneSplatReservation {
  const total = residentSceneSplats(models) + reserved + count;
  if (total > GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats) return { ok: false, total, limit: GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats };
  reserved += count;
  let held = true;
  return { ok: true, release() { if (held) { held = false; reserved -= count; } } };
}
