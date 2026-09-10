/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureAppearanceDependencies, planAuthoredResourceCleanup } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, Mutation } from '@ifc-lite/mutations';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { AppearanceHistoryPublication } from './history.js';
import { AppearancePreviewSession, appearanceHistoryParts, type AppearancePreviewParts } from './preview.js';
import { geometryWithAppearance } from './command-geometry.js';
import { modelAppearanceAssets } from './model-assets.js';

export interface CoordinatedAppearanceRecord {
  modelId: string;
  dataStore: IfcDataStore;
  view: MutablePropertyView;
  assetIds: string[];
  mutations: readonly Mutation[];
  beforeGuard: ReturnType<typeof captureAppearanceDependencies>;
  afterGuard: ReturnType<typeof captureAppearanceDependencies>;
  replayIfc(view: MutablePropertyView, direction: 'undo' | 'redo'): void;
}
export function coordinatedAppearancePublication(groups: ReadonlyMap<string, readonly AppearancePreviewParts[]>, renderer: Renderer): AppearanceHistoryPublication {
  const state = useViewerStore.getState(), models = new Map(state.models);
  for (const [modelId, parts] of groups) {
    const model = models.get(modelId);
    if (!model) throw new Error('An appearance target was removed.');
    models.set(modelId, { ...model, geometryResult: geometryWithAppearance(modelId, parts, renderer) });
  }
  const geometryResult = state.activeModelId && groups.has(state.activeModelId) ? models.get(state.activeModelId)?.geometryResult : undefined;
  return { models, ...(geometryResult ? { geometryResult } : {}) };
}
export function failCoordinatedAppearance(error: unknown, cleanup: readonly (() => void)[]): never {
  const errors = [error];
  for (const action of cleanup) { try { action(); } catch (failure) { errors.push(failure); } }
  if (errors.length > 1) throw new AggregateError(errors, 'Appearance failed and some resources could not be restored. Reload the affected models.');
  throw error;
}

export function replayCoordinatedAppearance(records: readonly CoordinatedAppearanceRecord[], commandId: string,
  renderer: Renderer, changes: ReturnType<AppearancePreviewSession['commit']>, owners: ReadonlyMap<number, string>, direction: 'undo' | 'redo') {
  for (const record of records) (direction === 'undo' ? record.afterGuard : record.beforeGuard).validate(record.view);
  const parts = appearanceHistoryParts(renderer, changes, direction), groups = new Map<string, AppearancePreviewParts[]>();
  for (const part of parts) {
    const modelId = owners.get(part.globalId);
    if (!modelId) throw new Error('An appearance history owner is no longer bound.');
    const existing = groups.get(modelId) ?? []; existing.push(part); groups.set(modelId, existing);
  }
  const originalModels = useViewerStore.getState().models;
  const transactions = records.map(record => ({ record,
    transaction: record.view.prepareAtomic(draft => { record.replayIfc(draft, direction); return draft; }),
    hadRegistration: modelAppearanceAssets.hasAuthoredRegistration(record.modelId, commandId) }));
  const preview = new AppearancePreviewSession(renderer);
  try {
    const retained = transactions.map(({ record, transaction }) => direction === 'undo'
      ? planAuthoredResourceCleanup(record.dataStore, transaction.result, new Set()).retainedImageUris : undefined);
    const publication = coordinatedAppearancePublication(groups, renderer);
    preview.stage(parts);
    if (direction === 'redo') for (const record of records) modelAppearanceAssets.registerAuthored(record.modelId, commandId, record.assetIds);
    const state = useViewerStore.getState();
    for (const record of records) {
      if (state.models.get(record.modelId) !== originalModels.get(record.modelId) || state.mutationViews.get(record.modelId) !== record.view) {
        throw new Error('An appearance target changed during coordinated replay.');
      }
    }
    const commitGpu = preview.prepareCommit(parts);
    for (const { transaction } of transactions) transaction.validate();
    for (const { transaction } of transactions) transaction.commit();
    commitGpu();
    // Like renderer disposal, releasing no-longer-used registrations happens after
    // the commit point and cannot turn successful IFC/GPU publication into rollback.
    transactions.forEach(({ record }, index) => {
      const imageUris = retained[index];
      if (imageUris) try { modelAppearanceAssets.releaseAuthoredIfUnreferenced(record.modelId, commandId, imageUris); }
      catch (error) { console.error('Could not release an unused appearance registration', error); }
    });
    return publication;
  } catch (error) {
    failCoordinatedAppearance(error, [
      ...[...transactions].reverse().map(({ transaction }) => () => transaction.rollback()),
      ...transactions.filter(item => direction === 'redo' && !item.hadRegistration).map(({ record }) => () => modelAppearanceAssets.unregisterAuthored(record.modelId, commandId)),
      () => preview.cancel(),
    ]);
  }
}
