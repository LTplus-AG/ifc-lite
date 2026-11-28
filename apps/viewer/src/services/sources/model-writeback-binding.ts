/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Which loaded model a write-back is bound to. Kept apart from the save path,
 * so the Save to source action can check eligibility without loading the
 * STEP exporter. #9522 */

import type { FileSourceProvider, SourceTag, WriteBackMode } from '@ifc-lite/plugin-api';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import type { SourceHost } from './source-host';

/** A dialog binds to this exact loaded store and revision, never a filename. */
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

/** The modes a provider can actually write: declared, and backed by `uploadFile`. */
export function writeBackModes(provider: FileSourceProvider | undefined): readonly WriteBackMode[] {
  return provider?.uploadFile ? provider.manifest.capabilities.writeBack ?? [] : [];
}

/** True when the loaded model can be bound and its provider declares at least one write-back mode. */
export function canWriteBackModel(host: SourceHost | null, modelId: string): boolean {
  const binding = host && bindSourceModel(modelId);
  return !!binding && writeBackModes(host.get(binding.tag.provider)).length > 0;
}
