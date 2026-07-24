/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceFile, SourceTag } from '@ifc-lite/plugin-api';
import { useViewerStore, stringToEntityRef } from '@/store';
import type { SourceHost } from '@/services/sources/source-host';
import { recordDownloadedSourceFile } from './persistence';
import { loadResolvedSourcePrefs } from './preferences';
import { sanitizeFilename } from '@/lib/export/download';

const IFC_NAME_PATTERNS = ['*.ifc', '*.ifcx', '*.ifc5'];
const LIST_PAGE_LIMIT = 200;

interface AddModelOptions {
  readonly name?: string;
  readonly modelId?: string;
  readonly loadedAt?: number;
  readonly visible?: boolean;
  readonly collapsed?: boolean;
}

interface SyncSourceModelOptions {
  readonly modelId: string;
  readonly tag: SourceTag;
  readonly sourceHost: SourceHost;
  readonly addModel: (file: File, options?: AddModelOptions) => Promise<string | null | undefined>;
  readonly removeModel: (modelId: string) => void;
  readonly signal?: AbortSignal;
}

interface SyncSourceModelResult {
  readonly reloadedModelId: string;
  readonly latestFile: SourceFile;
  readonly sourceTag: SourceTag;
}

// One sync per model at a time, shared across every UI entry point (the
// Hierarchy row button and the Sources browser row can otherwise race the
// same model). A second caller gets the first caller's promise back.
const inFlightSyncs = new Map<string, Promise<SyncSourceModelResult>>();

/** True while a sync for `modelId` is running (from any entry point). */
export function isSourceModelSyncing(modelId: string): boolean {
  return inFlightSyncs.has(modelId);
}

export function syncSourceModel(options: SyncSourceModelOptions): Promise<SyncSourceModelResult> {
  const existing = inFlightSyncs.get(options.modelId);
  if (existing) return existing;

  const run = doSyncSourceModel(options).finally(() => {
    inFlightSyncs.delete(options.modelId);
  });
  inFlightSyncs.set(options.modelId, run);
  return run;
}

async function doSyncSourceModel({
  modelId,
  tag,
  sourceHost,
  addModel,
  removeModel,
  signal,
}: SyncSourceModelOptions): Promise<SyncSourceModelResult> {
  if (!tag.projectId.trim()) {
    throw new Error('This source model predates project tracking. Reload it from Cloud Sources once to enable sync.');
  }

  const provider = sourceHost.get(tag.provider);
  if (!provider) {
    throw new Error(`Source provider "${tag.provider}" is not available.`);
  }

  const model = useViewerStore.getState().models.get(modelId);
  if (!model) {
    throw new Error('The model to sync is no longer loaded.');
  }

  const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));

  // Find the file's current metadata. v2 listing is paged, so follow the
  // cursor until the file shows up (or the container is exhausted).
  let latestFile: SourceFile | undefined;
  let cursor: string | undefined;
  do {
    const page = await provider.listFiles(
      ctx,
      tag.projectId,
      tag.containerId,
      { namePatterns: IFC_NAME_PATTERNS },
      { cursor, limit: LIST_PAGE_LIMIT, signal },
    );
    latestFile = page.items.find((file) => file.id === tag.fileId);
    cursor = page.cursor;
  } while (!latestFile && cursor);

  if (!latestFile) {
    throw new Error('Source file is no longer available in its original folder.');
  }

  // Download the latest revision (no revisionId in the ref means "latest").
  const buffer = await provider.download(ctx, {
    projectId: tag.projectId,
    containerId: latestFile.containerId,
    fileId: latestFile.id,
  }, { signal });

  const safeFileName = sanitizeFilename(latestFile.name, { fallback: 'model' });
  const replacement = new File([buffer], safeFileName);

  const preState = useViewerStore.getState();
  const otherCollapseStates = Array.from(preState.models.entries())
    .filter(([id]) => id !== modelId)
    .map(([id, current]) => ({ id, collapsed: current.collapsed }));
  const wasActive = preState.activeModelId === modelId;
  // The old model's global-id range, captured before removal — used to purge
  // stale selection/visibility ids once the swap has happened. (The registry
  // burns the range on unregister, so those ids can never be valid again.)
  const staleRange = { start: model.idOffset, end: model.idOffset + model.maxExpressId };

  // Load the replacement FIRST, under a fresh id, and only swap on success.
  // Removing before a fallible addModel deleted the user's model whenever the
  // reload failed (parse error, abort, or another federated load in flight).
  const replacementId = crypto.randomUUID();
  const addedId = await addModel(replacement, {
    modelId: replacementId,
    // Keep the user's label: `model.name` carries any rename, whereas the
    // source file name would silently overwrite it.
    name: model.name,
    loadedAt: model.loadedAt,
    visible: model.visible,
    collapsed: model.collapsed,
  });
  // addModel returns null both on real failure and when its load session was
  // superseded by a concurrent load — in the latter case the model may still
  // have registered. Check the store before declaring failure so we never
  // leak a successfully loaded replacement alongside the old model.
  const registered = useViewerStore.getState().models.has(replacementId);
  if (!addedId && !registered) {
    throw new Error(`Failed to reload ${latestFile.name}`);
  }

  // Swap: drop the old model (this also removes its source tag via the model
  // slice), purge ids that pointed into its now-burned global-id range, and
  // restore the sibling collapse states addModel just collapsed.
  removeModel(modelId);
  purgeStaleEntityState(modelId, staleRange);

  const postStore = useViewerStore.getState();
  for (const state of otherCollapseStates) {
    postStore.setModelCollapsed(state.id, state.collapsed);
  }
  if (wasActive) {
    postStore.setActiveModel(replacementId);
  }

  const nextTag = sourceHost.createSourceTag(
    tag.provider,
    tag.projectId,
    latestFile.containerId,
    latestFile.id,
    latestFile.currentRevisionId,
  );
  postStore.setSourceTag(replacementId, nextTag);
  recordDownloadedSourceFile(nextTag, latestFile);

  return {
    reloadedModelId: replacementId,
    latestFile,
    sourceTag: nextTag,
  };
}

/**
 * Drops every stored entity id that pointed into the removed model: ids in
 * its global-id range (selection, storeys, hidden/isolated/ghost sets) and
 * per-model entries keyed by its model id. The replacement model gets a new
 * offset range, so none of these can be remapped — they must go, or the
 * selection/isolation state dangles into the burned range forever.
 */
function purgeStaleEntityState(modelId: string, range: { start: number; end: number }): void {
  const inRange = (id: number) => id >= range.start && id <= range.end;
  const state = useViewerStore.getState();

  const selectedEntityIds = new Set([...state.selectedEntityIds].filter((id) => !inRange(id)));
  const selectedStoreys = new Set([...state.selectedStoreys].filter((id) => !inRange(id)));
  const hiddenEntities = new Set([...state.hiddenEntities].filter((id) => !inRange(id)));

  let isolatedEntities = state.isolatedEntities;
  if (isolatedEntities) {
    const kept = new Set([...isolatedEntities].filter((id) => !inRange(id)));
    // An isolation that only referenced the removed model must clear entirely
    // — an empty isolate set would hide everything.
    isolatedEntities = kept.size > 0 ? kept : null;
  }
  let ghostExceptEntities = state.ghostExceptEntities;
  if (ghostExceptEntities) {
    const kept = new Set([...ghostExceptEntities].filter((id) => !inRange(id)));
    ghostExceptEntities = kept.size > 0 ? kept : null;
  }

  const selectedEntitiesSet = new Set(
    [...state.selectedEntitiesSet].filter((key) => stringToEntityRef(key).modelId !== modelId),
  );
  const selectedEntities = state.selectedEntities.filter((ref) => ref.modelId !== modelId);
  const selectedEntity = state.selectedEntity?.modelId === modelId ? null : state.selectedEntity;
  const activeStorey = state.activeStorey?.modelId === modelId ? null : state.activeStorey;

  const hiddenEntitiesByModel = new Map(state.hiddenEntitiesByModel);
  hiddenEntitiesByModel.delete(modelId);
  const isolatedEntitiesByModel = new Map(state.isolatedEntitiesByModel);
  isolatedEntitiesByModel.delete(modelId);

  useViewerStore.setState({
    selectedEntityIds,
    selectedEntityId:
      state.selectedEntityId !== null && inRange(state.selectedEntityId)
        ? null
        : state.selectedEntityId,
    selectedStoreys,
    activeStorey,
    selectedEntity,
    selectedEntities,
    selectedEntitiesSet,
    selectedModelId: state.selectedModelId === modelId ? null : state.selectedModelId,
    hiddenEntities,
    isolatedEntities,
    ghostExceptEntities,
    hiddenEntitiesByModel,
    isolatedEntitiesByModel,
  });
}
