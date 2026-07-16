/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceFile, SourceTag } from '@ifc-lite/plugin-api';
import type { FederatedModel } from '@/store';
import type { SourceHost } from '@/services/sources/source-host';
import { recordDownloadedSourceFile } from './persistence';
import { loadSavedSourcePrefs } from './preferences';

const IFC_NAME_PATTERNS = ['*.ifc', '*.ifcx', '*.ifc5'];

interface ReloadModelOptions {
  readonly name?: string;
  readonly modelId?: string;
  readonly loadedAt?: number;
  readonly visible?: boolean;
  readonly collapsed?: boolean;
}

interface SyncSourceModelOptions {
  readonly modelId: string;
  readonly model: FederatedModel;
  readonly tag: SourceTag;
  readonly models: ReadonlyMap<string, FederatedModel>;
  readonly activeModelId: string | null;
  readonly sourceHost: SourceHost;
  readonly addModel: (file: File, options?: ReloadModelOptions) => Promise<string | null | undefined>;
  readonly removeModel: (modelId: string) => void;
  readonly setModelCollapsed: (modelId: string, collapsed: boolean) => void;
  readonly setActiveModel: (modelId: string) => void;
  readonly setSourceTag: (modelId: string, tag: SourceTag) => void;
}

interface SyncSourceModelResult {
  readonly reloadedModelId: string;
  readonly latestFile: SourceFile;
  readonly sourceTag: SourceTag;
}

export async function syncSourceModel({
  modelId,
  model,
  tag,
  models,
  activeModelId,
  sourceHost,
  addModel,
  removeModel,
  setModelCollapsed,
  setActiveModel,
  setSourceTag,
}: SyncSourceModelOptions): Promise<SyncSourceModelResult> {
  if (!tag.projectId.trim()) {
    throw new Error('This source model predates project tracking. Reload it from Cloud Sources once to enable sync.');
  }

  const provider = sourceHost.get(tag.provider);
  if (!provider) {
    throw new Error(`Source provider "${tag.provider}" is not available.`);
  }

  const ctx = sourceHost.createContext(
    provider.manifest,
    loadSavedSourcePrefs(tag.provider),
  );
  const latestFiles = await provider.listFiles(ctx, tag.containerId, {
    namePatterns: IFC_NAME_PATTERNS,
  });
  const latestFile = latestFiles.find((file) => file.id === tag.fileId);
  if (!latestFile) {
    throw new Error('Source file is no longer available in its original folder.');
  }

  const buffer = await provider.download(
    ctx,
    latestFile.id,
    latestFile.currentRevisionId,
  );
  const replacement = new File([buffer], latestFile.name);
  const otherCollapseStates = Array.from(models.entries())
    .filter(([id]) => id !== modelId)
    .map(([id, current]) => ({ id, collapsed: current.collapsed }));
  const wasActive = activeModelId === modelId;

  removeModel(modelId);
  const reloadedModelId = await addModel(replacement, {
    modelId,
    name: latestFile.name,
    loadedAt: model.loadedAt,
    visible: model.visible,
    collapsed: model.collapsed,
  });
  if (!reloadedModelId) {
    throw new Error(`Failed to reload ${latestFile.name}`);
  }

  for (const state of otherCollapseStates) {
    setModelCollapsed(state.id, state.collapsed);
  }
  if (wasActive) {
    setActiveModel(reloadedModelId);
  }

  const nextTag = sourceHost.createSourceTag(
    tag.provider,
    tag.projectId,
    latestFile.containerId,
    latestFile.id,
    latestFile.currentRevisionId,
  );
  setSourceTag(reloadedModelId, nextTag);
  recordDownloadedSourceFile(nextTag, latestFile);

  return {
    reloadedModelId,
    latestFile,
    sourceTag: nextTag,
  };
}
