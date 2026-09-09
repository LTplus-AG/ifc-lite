/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureAppearanceDependencies, planAuthoredResourceCleanup } from '@ifc-lite/export';
import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { replayAppearanceEntitiesInDraft } from './apply-plan.js';
import { prepareAppearanceEntities } from './prepare-plan.js';
import type { EntityPreparationOptions } from '@ifc-lite/mutations';
import { appearanceAssets, modelAppearanceAssets } from './model-assets.js';
import { prepareAppearanceHistory } from './history.js';
import type { AppearanceHistoryPublication } from './history.js';
import { appearanceHistoryParts, AppearancePreviewSession, type AppearancePreviewParts } from './preview.js';
import type { AppearancePlan } from './planner-types.js';

function failWithCleanup(error: unknown, cleanup: readonly (() => void)[]): never {
  const errors = [error];
  for (const release of cleanup) {
    try { release(); } catch (failure) { errors.push(failure); }
  }
  if (errors.length === 1) throw error;
  throw new AggregateError(errors, 'Appearance failed; one or more resources also failed to restore. Reload the model.');
}

export function captureAppearanceSource(view: MutablePropertyView): { validate(current: MutablePropertyView | undefined): void } {
  const { validate } = view.prepareAtomic(() => undefined);
  return { validate(current) {
    if (current !== view) throw new Error('The appearance model was replaced. Refresh the preview.');
    validate();
  } };
}

/** The revision changes on existing viewer commands, model swaps, undo and redo. */
export function appearanceRevision(modelId: string): string {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  return `${modelId}:${model?.loadedAt ?? 'removed'}:${state.mutationVersion}`;
}

function geometryWithAppearance(modelId: string, groups: readonly AppearancePreviewParts[]) {
  const model = useViewerStore.getState().models.get(modelId);
  if (!model?.geometryResult) throw new Error('The target model is no longer loaded.');
  const byOwner = new Map(groups.map(group => [group.globalId, group.parts]));
  const found = new Set<number>();
  let triangleDelta = 0, vertexDelta = 0;
  const meshes = model.geometryResult.meshes.flatMap(mesh => {
    if (mesh.entityIds?.some(id => byOwner.has(id))) {
      throw new Error('This combined geometry needs to be separated before applying appearance.');
    }
    const parts = byOwner.get(mesh.expressId);
    if (!parts) return [mesh];
    triangleDelta -= mesh.indices.length / 3;
    vertexDelta -= mesh.positions.length / 3;
    if (found.has(mesh.expressId)) return [];
    found.add(mesh.expressId);
    for (const part of parts) {
      triangleDelta += part.indices.length / 3;
      vertexDelta += part.positions.length / 3;
    }
    // History wrappers are frozen snapshots; live model meshes must remain
    // mutable for the existing CPU release/transform paths.
    return parts.map(part => ({ ...part }));
  });
  if (found.size !== byOwner.size) throw new Error('Some target geometry is no longer in the model. Refresh the appearance preview.');
  return { ...model.geometryResult, meshes,
    totalTriangles: model.geometryResult.totalTriangles + triangleDelta,
    totalVertices: model.geometryResult.totalVertices + vertexDelta };
}

function geometryPublication(modelId: string, geometryResult: ReturnType<typeof geometryWithAppearance>): AppearanceHistoryPublication {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  if (!model) throw new Error('The target model was removed during appearance publication.');
  return { models: new Map(state.models).set(modelId, { ...model, geometryResult }),
    ...(state.activeModelId === modelId ? { geometryResult } : {}) };
}

export interface AppearanceCommitOptions extends EntityPreparationOptions {
  onProgress?: (phase: 'preparing' | 'validating' | 'publishing') => void;
}

/** Prepared resources become one IFC edit and one existing viewer history command. */
export async function commitAppearance(
  modelId: string, assetId: string | readonly string[], plan: AppearancePlan,
  renderer: Renderer, preview: AppearancePreviewSession, groups: readonly AppearancePreviewParts[],
  source: ReturnType<typeof captureAppearanceSource>,
  options: AppearanceCommitOptions = {},
): Promise<void> {
  const assetIds = [...new Set(typeof assetId === 'string' ? [assetId] : assetId)];
  if (!assetIds.length) throw new Error('Appearance needs at least one retained image.');
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  const view = state.mutationViews.get(modelId);
  if (!model?.ifcDataStore || !view) throw new Error('This model is not ready for appearance editing.');
  if (state.collabRoomId) throw new Error('Leave the shared room before editing appearance, then share the finished model.');
  try { source.validate(view); }
  catch (error) { failWithCleanup(error, [() => preview.cancel()]); }
  const geometry = geometryWithAppearance(modelId, groups);
  const commandId = crypto.randomUUID();
  const historyOwner = { kind: 'history' as const, id: commandId };
  // Cooperative work stays detached; the final synchronous install remains
  // reversible until all assets, history and GPU tokens pass preparation.
  const roots = new Set([...plan.items.flatMap(item => [item.productId, item.geometryItemId]),
    ...plan.edits.map(edit => edit.expressId), ...plan.removed, ...plan.created.map(entity => entity.expressId)]);
  const sourceRevision = plan.sourceRevision;
  const abort = () => {
    if (options.signal?.aborted) throw new DOMException('Appearance application was cancelled.', 'AbortError');
  };
  let preparation: Awaited<ReturnType<typeof prepareAppearanceEntities>>;
  try {
    abort();
    options.onProgress?.('preparing');
    preparation = await prepareAppearanceEntities(state.storeEditors.get(modelId) ?? new StoreEditor(model.ifcDataStore, view), view, plan, appearanceRevision(modelId), options);
  } catch (error) { failWithCleanup(error, [() => preview.cancel()]); }
  const { prepared, applied } = preparation;
  // Frozen effective dependency records catch direct SDK edits that leave the
  // renderer buffers and the viewer's mutationVersion unchanged.
  const changes: ReturnType<AppearancePreviewSession['commit']> = [];
  let published = false;
  try {
    options.onProgress?.('validating');
    abort();
    source.validate(view);
    const beforeGuard = captureAppearanceDependencies(model.ifcDataStore, view, roots);
    // All callbacks happen before the exact fence and synchronous publication.
    options.onProgress?.('publishing');
    abort();
    if (useViewerStore.getState().models.get(modelId) !== model
      || useViewerStore.getState().mutationViews.get(modelId) !== view
      || useViewerStore.getState().collabRoomId
      || appearanceRevision(modelId) !== sourceRevision) {
      throw new Error('The model changed while preparing appearance. Refresh the preview.');
    }
    source.validate(view);
    prepared.commit();
    // No await or store publication may occur between this temporary IFC install
    // and GPU/history publication. Any guard/resource failure restores the overlay.
    const afterGuard = captureAppearanceDependencies(model.ifcDataStore, view, roots);
    for (const id of assetIds) appearanceAssets.retain(id, historyOwner);
    modelAppearanceAssets.registerAuthored(modelId, commandId, assetIds);
    modelAppearanceAssets.authoredLifecycle.track(modelId, commandId, {
      dataStore: model.ifcDataStore, view,
      isCurrent: () => useViewerStore.getState().mutationViews.get(modelId) === view
        && useViewerStore.getState().models.get(modelId)?.ifcDataStore === model.ifcDataStore,
      changed: () => useViewerStore.getState().bumpMutationVersion(),
      subscribe: changed => useViewerStore.subscribe((current, previous) => {
        if (current.mutationVersion !== previous.mutationVersion || current.mutationViews !== previous.mutationViews
          || current.models.has(modelId) !== previous.models.has(modelId)) changed();
      }),
    }, applied.created, [
      ...applied.created.flatMap(entity => entity.attributes),
      ...applied.before.map(attribute => attribute.value),
      ...applied.removed.flatMap(removed => [`#${removed.expressId}`, ...(removed.entity?.attributes ?? [])]),
    ]);
    const record = prepareAppearanceHistory(useViewerStore, modelId, {
      mutations: applied.mutations,
      replay(direction) {
        (direction === 'undo' ? afterGuard : beforeGuard).validate(view);
        const parts = appearanceHistoryParts(renderer, changes, direction);
        const nextGeometry = geometryWithAppearance(modelId, parts);
        const replay = new AppearancePreviewSession(renderer);
        const transaction = view.prepareAtomic(target => { replayAppearanceEntitiesInDraft(target, applied, direction); return target; });
        const hadRegistration = modelAppearanceAssets.hasAuthoredRegistration(modelId, commandId);
        const currentModel = useViewerStore.getState().models.get(modelId);
        try {
          const imageUris = direction === 'undo'
            ? planAuthoredResourceCleanup(model.ifcDataStore!, transaction.result, new Set()).retainedImageUris : undefined;
          replay.stage(parts);
          if (direction === 'redo') modelAppearanceAssets.registerAuthored(modelId, commandId, assetIds);
          if (useViewerStore.getState().models.get(modelId) !== currentModel
            || useViewerStore.getState().mutationViews.get(modelId) !== view) {
            throw new Error('The target model changed during appearance replay.');
          }
          const publication = geometryPublication(modelId, nextGeometry);
          const commitGpu = replay.prepareCommit(parts);
          transaction.commit();
          commitGpu();
          if (imageUris) modelAppearanceAssets.releaseAuthoredIfUnreferenced(modelId, commandId, imageUris);
          return publication;
        } catch (error) {
          failWithCleanup(error, [() => transaction.rollback(),
            () => { if (direction === 'redo' && !hadRegistration) modelAppearanceAssets.unregisterAuthored(modelId, commandId); },
            () => replay.cancel()]);
        }
      },
      dispose() {
        appearanceAssets.releaseOwner(historyOwner);
        modelAppearanceAssets.authoredLifecycle.retire(modelId, commandId);
      },
    });
    if (useViewerStore.getState().models.get(modelId) !== model
      || useViewerStore.getState().mutationViews.get(modelId) !== view
      || appearanceRevision(modelId) !== sourceRevision) {
      throw new Error('The model changed while preparing appearance. Refresh the preview.');
    }
    const publication = geometryPublication(modelId, geometry);
    const commitGpu = preview.prepareCommit(groups);
    changes.push(...commitGpu());
    // IFC + GPU are ready. Publish the geometry and history entry together so
    // observers never see new IFC history paired with the old render buffers.
    published = true;
    record(publication);
  } catch (error) {
    if (!published) {
      failWithCleanup(error, [() => prepared.rollback(),
        () => modelAppearanceAssets.unregisterAuthored(modelId, commandId),
        () => modelAppearanceAssets.authoredLifecycle.forget(modelId, commandId),
        () => appearanceAssets.releaseOwner(historyOwner), () => preview.cancel()]);
    }
    throw error;
  } finally { prepared.dispose(); }
}
