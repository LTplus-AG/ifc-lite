/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceTag, UploadResult, UploadTarget, WriteBackMode } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { clearSourceCatalogCache, recordDownloadedSourceFile } from '@/lib/sources/persistence';
import type { SourceHost } from './source-host';
import { isSourceBindingCurrent, writeBackModes, type WriteBackBinding } from './model-writeback-binding';

export type SaveSourceOutcome =
  | { readonly kind: 'unavailable' | 'model-changed' | 'invalid-destination' }
  | { readonly kind: 'conflict'; readonly conflict: Extract<UploadResult, { ok: false }>['conflict'] }
  | { readonly kind: 'saved'; readonly result: Extract<UploadResult, { ok: true }>; readonly linked: boolean };

/** A name the host will send: a bare `.ifc` file name. Length and other
 * character rules belong to the provider, which knows its own limits. */
function isUploadFileName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.trim() === name && /\.ifc$/i.test(name) && name.length > 4 && !/[\\/\u0000-\u001f]/.test(name);
}

/** Runs once after explicit confirmation. Conflicts never trigger an automatic retry. */
export async function saveSourceModel(
  host: SourceHost,
  binding: WriteBackBinding,
  destination: { mode: WriteBackMode; fileName: string; containerId: string },
  signal?: AbortSignal,
): Promise<SaveSourceOutcome> {
  if (!isSourceBindingCurrent(binding)) return { kind: 'model-changed' };
  const provider = host.get(binding.tag.provider);
  if (!provider?.uploadFile || !writeBackModes(provider).includes(destination.mode)) return { kind: 'unavailable' };
  if (destination.mode !== 'new-version' && (!isUploadFileName(destination.fileName) ||
      (destination.mode === 'new-location' && !destination.containerId))) return { kind: 'invalid-destination' };
  const { tag } = binding;
  const target: UploadTarget = destination.mode === 'new-version'
    ? { mode: 'new-version', ref: { projectId: tag.projectId, containerId: tag.containerId, fileId: tag.fileId }, baseRevisionId: tag.revisionId }
    : { mode: destination.mode, projectId: tag.projectId,
        containerId: destination.mode === 'new-file' ? tag.containerId : destination.containerId,
        fileName: destination.fileName };
  // Snapshot current edits synchronously at confirmation. Later edits stay in the
  // mutation view; a successful upload must never clear someone else's new work.
  const state = useViewerStore.getState();
  const bytes = editedModelBytes(binding.store, state.mutationViews.get(binding.modelId) ?? null).slice().buffer;
  const ctx = host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
  let result: UploadResult;
  try {
    result = await provider.uploadFile(ctx, target, bytes, { mimeType: 'application/x-step', signal });
  } finally {
    // The listing may be stale even after a failure: a cancel or a lost response can follow a committed
    // write. Who signed in is unchanged; favourites filter on that owner stamp.
    clearSourceCatalogCache(tag.provider, { keepOwner: true });
  }
  if (!result.ok) return { kind: 'conflict', conflict: result.conflict };
  // Never relink to an identity the provider did not give back.
  const linked = !!result.file.id && !!result.revision.id && isSourceBindingCurrent(binding);
  if (linked) {
    const file = { ...result.file, containerId: result.file.containerId || (target.mode === 'new-version' ? target.ref.containerId : target.containerId) };
    const nextTag: SourceTag = { ...tag, containerId: file.containerId, fileId: file.id,
      revisionId: result.revision.id, loadedAt: Date.now() };
    const store = useViewerStore.getState();
    store.setSourceTag(binding.modelId, nextTag);
    // Following a different file: name the model after it, so the next save names the file it writes to.
    if (result.file.id !== tag.fileId) store.setModelName(binding.modelId, result.file.name);
    recordDownloadedSourceFile(nextTag, file);
  }
  return { kind: 'saved', result, linked };
}
