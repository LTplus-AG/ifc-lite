/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceTag, UploadResult, UploadTarget, WriteBackMode } from '@ifc-lite/plugin-api';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { clearSourceCatalogCache, recordDownloadedSourceFile } from '@/lib/sources/persistence';
import { notifySourceWriteBackSaved } from './source-writeback-command';
import type { SourceHost } from './source-host';
import { sanitizeFilename } from '@/lib/export/download';

/** A dialog binds to this exact loaded store and revision, never a filename. #9522 */
export interface WriteBackBinding {
  readonly modelId: string;
  readonly name: string;
  readonly store: IfcDataStore;
  readonly tag: SourceTag;
}

export function bindSourceModel(modelId: string): WriteBackBinding | null {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId), tag = state.sourceTags.get(modelId);
  if (!model?.ifcDataStore || !tag?.revisionId || !/\.ifc$/i.test(model.sourceFile?.name ?? model.name)) return null;
  return { modelId, name: model.name, store: model.ifcDataStore, tag: { ...tag } };
}

export function isSourceBindingCurrent(binding: WriteBackBinding): boolean {
  const state = useViewerStore.getState(), tag = state.sourceTags.get(binding.modelId);
  return state.models.get(binding.modelId)?.ifcDataStore === binding.store && !!tag &&
    tag.provider === binding.tag.provider && tag.projectId === binding.tag.projectId &&
    tag.containerId === binding.tag.containerId && tag.fileId === binding.tag.fileId &&
    tag.revisionId === binding.tag.revisionId && tag.loadedAt === binding.tag.loadedAt;
}

export function sourceWriteBackModes(host: SourceHost, binding: WriteBackBinding): readonly WriteBackMode[] {
  const provider = host.get(binding.tag.provider);
  return provider?.uploadFile ? provider.manifest.capabilities.writeBack ?? [] : [];
}

export type SaveSourceOutcome =
  | { readonly kind: 'unavailable' | 'model-changed' | 'invalid-destination' }
  | { readonly kind: 'conflict'; readonly conflict: Extract<UploadResult, { ok: false }>['conflict'] }
  | { readonly kind: 'saved'; readonly result: Extract<UploadResult, { ok: true }>; readonly linked: boolean };

/** Runs once after explicit confirmation. Conflicts never trigger an automatic retry. */
export async function saveSourceModel(
  host: SourceHost,
  binding: WriteBackBinding,
  destination: { mode: WriteBackMode; fileName: string; containerId: string },
): Promise<SaveSourceOutcome> {
  if (!isSourceBindingCurrent(binding)) return { kind: 'model-changed' };
  const provider = host.get(binding.tag.provider);
  if (!provider?.uploadFile || !sourceWriteBackModes(host, binding).includes(destination.mode)) return { kind: 'unavailable' };
  if (destination.mode !== 'new-version' && (!destination.fileName.trim() ||
      sanitizeFilename(destination.fileName) !== destination.fileName || !/\.ifc$/i.test(destination.fileName) ||
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
  const result = await provider.uploadFile(ctx, target, bytes, { mimeType: 'application/x-step' });
  if (!result.ok) return { kind: 'conflict', conflict: result.conflict };
  const linked = isSourceBindingCurrent(binding);
  if (linked) {
    const nextTag: SourceTag = { ...tag, containerId: result.file.containerId, fileId: result.file.id,
      revisionId: result.revision.id, loadedAt: Date.now() };
    useViewerStore.getState().setSourceTag(binding.modelId, nextTag);
    recordDownloadedSourceFile(nextTag, result.file);
  }
  clearSourceCatalogCache(tag.provider);
  notifySourceWriteBackSaved(tag.provider, tag.projectId);
  return { kind: 'saved', result, linked };
}
