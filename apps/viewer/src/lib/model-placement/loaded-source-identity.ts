/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { placementSourceIdentity } from './source-identity';

const identifying = new WeakMap<File, Map<string, Promise<void>>>();

/** Called after scan finalization, so first paint and load completion never wait
 * for a second full-file pass. Removal/replacement stops at the next chunk.
 * Callers for the same model and file share one pass (#7035): the drawing
 * persistence asks for a loaded model's identity when the record has none. */
export function identifyLoadedPlacementSource(modelId: string, file: File): Promise<void> {
  const byModel = identifying.get(file) ?? new Map<string, Promise<void>>();
  identifying.set(file, byModel);
  let pending = byModel.get(modelId);
  if (!pending) {
    const current = () => useViewerStore.getState().models.get(modelId)?.sourceFile === file;
    pending = placementSourceIdentity(file, () => !current()).then((hash) => {
      if (hash && current()) useViewerStore.getState().updateModel(modelId, { sourceContentHash: hash });
      else byModel.delete(modelId); // cancelled or unavailable: a later call may try again
    });
    byModel.set(modelId, pending);
  }
  return pending;
}

/** Starts a load's one full-source pass (#7022) without holding the load up:
 * the cache lookup, engine init and geometry run beside it. The identity goes
 * onto the model record as soon as it settles, unless a newer load owns the
 * session (`isStale`) or the record no longer holds this file. Resolves to the
 * identity for the load's finalize, cache write and warm revalidation, or
 * `undefined` when stale, cancelled or unavailable. */
export function startLoadSourceIdentity(modelId: string, file: File, isStale: () => boolean, bytes?: Uint8Array): Promise<string | undefined> {
  return placementSourceIdentity(file, isStale, bytes).then((identity) => {
    if (!identity || isStale()) return undefined;
    const { models, updateModel } = useViewerStore.getState();
    if (models.get(modelId)?.sourceFile === file) updateModel(modelId, { sourceContentHash: identity });
    return identity;
  });
}
