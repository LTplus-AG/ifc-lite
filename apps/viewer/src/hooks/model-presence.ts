/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Primitive answers about which models are loaded, for components that only
 * need those (#6232 perf). Selecting `models` or `geometryResult` re-renders a
 * component on every geometry update: each streamed batch and each re-meshed
 * element publishes a new `models` map.
 */

import type { ViewerState } from '@/store';

/** A model is registered, or the legacy single-model slot holds meshes. */
export function selectHasModelsLoaded(s: ViewerState): boolean {
  return s.models.size > 0 || (s.geometryResult?.meshes?.length ?? 0) > 0;
}

export function selectModelCount(s: ViewerState): number {
  return s.models.size;
}

/** Every loaded model can be re-read from disk (a live File System Access handle), and nothing is loading. */
export function selectCanRefreshModels(s: ViewerState): boolean {
  if (s.loading || s.models.size === 0) return false;
  for (const model of s.models.values()) if (!model.sourceHandle) return false;
  return true;
}
