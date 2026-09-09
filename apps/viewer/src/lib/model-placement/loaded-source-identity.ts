/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { placementSourceIdentity } from './source-identity';

/** Called after scan finalization, so first paint and load completion never wait
 * for a second full-file pass. Removal/replacement stops at the next chunk. */
export async function identifyLoadedPlacementSource(modelId: string, file: File): Promise<void> {
  const current = () => useViewerStore.getState().models.get(modelId)?.sourceFile === file;
  const hash = await placementSourceIdentity(file, () => !current());
  if (hash && current()) useViewerStore.getState().updateModel(modelId, { sourceContentHash: hash });
}
