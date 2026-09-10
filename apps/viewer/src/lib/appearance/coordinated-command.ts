/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureAppearanceDependencies } from '@ifc-lite/export';
import { StoreEditor } from '@ifc-lite/mutations';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { AppearanceCommitOptions } from './command.js';
import { appearanceAssets, modelAppearanceAssets } from './model-assets.js';
import { trackAppearanceCommandResources } from './command-resources.js';
import { AppearancePreviewSession, type AppearancePreviewParts } from './preview.js';
import { prepareCoordinatedAppearanceHistory } from './coordinated-history.js';
import { coordinatedAppearancePublication, failCoordinatedAppearance, replayCoordinatedAppearance, type CoordinatedAppearanceRecord } from './coordinated-replay.js';
import { prepareAppearanceEntitySequence } from './assignments/entity-sequence.js';
import type { prepareAppearanceAssignments } from './assignments/prepare.js';

/** One IFC/GPU/history publication for every explicitly prepared model. */
export async function commitAppearanceAssignments(
  preparation: Awaited<ReturnType<typeof prepareAppearanceAssignments>>, renderer: Renderer,
  preview: AppearancePreviewSession, groups: ReadonlyMap<string, readonly AppearancePreviewParts[]>, options: AppearanceCommitOptions = {},
) {
  const initial = useViewerStore.getState(), models = [...preparation.snapshots];
  const allGroups = [...groups.values()].flat(), owners = new Map<number, string>();
  const commandId = crypto.randomUUID(), historyOwner = { kind: 'history' as const, id: commandId };
  const sequences: Array<{ modelId: string; value: Awaited<ReturnType<typeof prepareAppearanceEntitySequence>> }> = [];
  const records: CoordinatedAppearanceRecord[] = [];
  let releaseSources = () => {}, published = false;
  const changes: ReturnType<AppearancePreviewSession['commit']> = [];
  const validate = () => {
    options.signal?.throwIfAborted(); preparation.validate();
    const state = useViewerStore.getState();
    if (state.collabRoomId) throw new Error('Leave the shared room before applying appearance assignments.');
    for (const [modelId] of models) {
      if (state.models.get(modelId) !== initial.models.get(modelId) || state.mutationViews.get(modelId) !== initial.mutationViews.get(modelId)) {
        throw new Error('An appearance target changed while preparing the coordinated application.');
      }
    }
  };
  try {
    validate();
    if (groups.size !== models.length) throw new Error('The preview does not contain every assigned model.');
    for (const [modelId, snapshot] of models) {
      const parts = groups.get(modelId);
      const expected = new Set(preparation.steps.filter(step => step.modelId === modelId)
        .flatMap(step => step.plan.items.map(item => initial.toGlobalId(modelId, item.productId))));
      if (!parts || parts.length !== expected.size || parts.some(part => !expected.delete(part.globalId))) throw new Error('The preview membership differs from the prepared assignments.');
      for (const part of parts) {
        if (owners.has(part.globalId)) throw new Error('Appearance preview owners collide across models.');
        owners.set(part.globalId, modelId);
      }
      const model = initial.models.get(modelId)!, view = initial.mutationViews.get(modelId);
      if (!model.ifcDataStore || !view) throw new Error('An assigned model is no longer editable.');
      const steps = preparation.steps.filter(step => step.modelId === modelId), plans = steps.map(step => step.plan);
      options.onProgress?.('preparing');
      const value = await prepareAppearanceEntitySequence(initial.storeEditors.get(modelId) ?? new StoreEditor(model.ifcDataStore, view),
        view, plans, snapshot.revision, options);
      sequences.push({ modelId, value }); validate();
      const roots = new Set(plans.flatMap(plan => [...plan.items.flatMap(item => [item.productId, item.geometryItemId]),
        ...((plan.conversions ?? []).flatMap(conversion => (conversion.sourceRemovedMeshes ?? []).flatMap(mesh => [mesh.express_id, mesh.geometry_item_id]))),
    ...plan.edits.map(edit => edit.expressId), ...plan.removed, ...plan.created.map(entity => entity.expressId)]));
      const beforeGuard = captureAppearanceDependencies(model.ifcDataStore, view, roots);
      records.push({ modelId, view, dataStore: model.ifcDataStore, assetIds: [...new Set(steps.flatMap(step => step.assetIds))],
        mutations: value.mutations, replayIfc: value.replay, beforeGuard, afterGuard: beforeGuard });
    }
    options.onProgress?.('validating'); validate();
    const publication = coordinatedAppearancePublication(groups, renderer);
    releaseSources = preview.retainSources();
    options.onProgress?.('publishing'); validate();
    for (const { value } of sequences) value.prepared.validate();
    // No await or external progress callback after this fence. Every IFC install
    // remains reversible until the combined GPU tokens and history are prepared.
    for (const { value } of sequences) value.prepared.commit();
    for (const record of records) {
      const plans = preparation.steps.filter(step => step.modelId === record.modelId).map(step => step.plan);
      const roots = new Set(plans.flatMap(plan => [...plan.items.flatMap(item => [item.productId, item.geometryItemId]),
        ...((plan.conversions ?? []).flatMap(conversion => (conversion.sourceRemovedMeshes ?? []).flatMap(mesh => [mesh.express_id, mesh.geometry_item_id]))),
    ...plan.edits.map(edit => edit.expressId), ...plan.removed, ...plan.created.map(entity => entity.expressId)]));
      record.afterGuard = captureAppearanceDependencies(record.dataStore, record.view, roots);
      for (const id of record.assetIds) appearanceAssets.retain(id, historyOwner);
      modelAppearanceAssets.registerAuthored(record.modelId, commandId, record.assetIds);
      const sequence = sequences.find(item => item.modelId === record.modelId)!.value;
      trackAppearanceCommandResources(record.modelId, commandId, record.dataStore, record.view, sequence.created, sequence.references);
    }
    const recordHistory = prepareCoordinatedAppearanceHistory(useViewerStore, records, {
      replay: direction => replayCoordinatedAppearance(records, commandId, renderer, changes, owners, direction),
      dispose() {
        const errors: unknown[] = [];
        const cleanup = [releaseSources, () => appearanceAssets.releaseOwner(historyOwner),
          ...records.map(record => () => modelAppearanceAssets.authoredLifecycle.retire(record.modelId, commandId))];
        for (const release of cleanup) { try { release(); } catch (error) { errors.push(error); } }
        if (errors.length) throw new AggregateError(errors, 'Could not release all coordinated appearance resources.');
      },
    });
    const state = useViewerStore.getState();
    for (const record of records) if (state.models.get(record.modelId) !== initial.models.get(record.modelId)
      || state.mutationViews.get(record.modelId) !== record.view) throw new Error('An appearance target changed before publication.');
    // Preview installation already finished. Token commit only consumes tokens
    // and releases renderer-owned resources; the real Scene adapter emits no
    // install/store callbacks between this membership fence and publication.
    const commitGpu = preview.prepareCommit(allGroups);
    for (const change of commitGpu()) changes.push(change);
    published = true;
    try { recordHistory(publication); }
    catch (error) {
      const current = useViewerStore.getState();
      if (!records.every(record => current.undoStacks.get(record.modelId)?.at(-1)?.id === record.mutations.at(-1)?.id)) throw error;
      console.error('Appearance was committed, but a state observer failed', error);
      return { observerFailed: true };
    }
    return { observerFailed: false };
  } catch (error) {
    if (published) throw error;
    failCoordinatedAppearance(error, [
      ...[...sequences].reverse().map(({ value }) => () => value.prepared.rollback()),
      ...models.flatMap(([modelId]) => [() => modelAppearanceAssets.unregisterAuthored(modelId, commandId),
        () => modelAppearanceAssets.authoredLifecycle.forget(modelId, commandId)]),
      () => appearanceAssets.releaseOwner(historyOwner), () => releaseSources(), () => preview.cancel(),
    ]);
  } finally { for (const { value } of sequences) value.prepared.dispose(); }
}
