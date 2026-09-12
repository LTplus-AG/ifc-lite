/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { modelAppearanceAssets } from '@/lib/appearance/model-assets';

/** Cancel unpublished resource leases, then remove every published room model. */
export function cleanupRoomModels(
  pending: ReadonlySet<string>,
  states: Iterable<{ modelId: string; created: boolean }>,
  removeModel: (modelId: string) => void,
): void {
  for (const modelId of pending) modelAppearanceAssets.remove(modelId);
  for (const state of states) {
    if (!state.created) continue;
    try {
      removeModel(state.modelId);
    } catch (error) {
      console.warn(`[collab] could not remove room model ${state.modelId}:`, error);
    }
  }
}
