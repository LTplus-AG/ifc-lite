/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { createRunSlot, IDLE_RUN } from '@/lib/runs/run-slot';
import type { ServerPropertiesOwner, ServerPropertiesRun } from '@/store/slices/serverPropertiesSlice';
import { watchLoadSupersession } from '../modelLoadCanceller.js';
import { federationRegistry } from '@ifc-lite/renderer';
import { withDeferredOverlayCapacity } from '@/store/overlay-capacity';
import { getMaxExpressId } from './viewerModelIngest.js';

/** The geometry finalizer may still overwrite its placeholder with null. */
function waitForCompletion(modelId: string, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const observe = () => {
      if (!signal.aborted && useViewerStore.getState().models.get(modelId)?.loadState !== 'complete') return;
      stop();
      signal.removeEventListener('abort', observe);
      resolve();
    };
    const stop = useViewerStore.subscribe(observe);
    signal.addEventListener('abort', observe, { once: true });
    observe();
  });
}

/** Publishes the hydrated store's ids and returns the model's ownership bound for the reverse
 *  resolvers: the store's highest id, or the published end when a later model clamps the range. */
function extendModelIdRange(modelId: string, dataStore: IfcDataStore): { maxExpressId: number } {
  const registered = useViewerStore.getState().models.get(modelId)?.maxExpressId ?? 0;
  const maxExpressId = Math.max(registered, getMaxExpressId(dataStore, []));
  // An unregistered primary keeps the single-model `globalId === expressId` fallback.
  if (!federationRegistry.hasModel(modelId)) return { maxExpressId };
  // Source-derived allocator floors do not mean any authored IDs exist.
  // Refusal leaves both the existing source and authored overlay untouched.
  let authoredMax = 0;
  for (const entity of useViewerStore.getState().mutationViews.get(modelId)?.readNewEntityKinds() ?? []) authoredMax = Math.max(authoredMax, entity.expressId);
  const published = federationRegistry.extendModel(modelId, maxExpressId, authoredMax);
  if (published < maxExpressId) console.warn(`[Server properties] Ids ${published + 1}..${maxExpressId} of model ${modelId} lie past the ids a later model owns; those entities cannot be selected or resolved, and the model cannot be edited`);
  return { maxExpressId: published };

}

function start(modelId: string | null, isStale: (() => boolean) | undefined,
  hydrate: (signal: AbortSignal) => Promise<IfcDataStore | null>): void {
  const state = useViewerStore.getState();
  const model = modelId ? state.models.get(modelId) : undefined;
  if (!model || !modelId) {
    console.warn('[Server properties] Cannot hydrate without a registered model', modelId);
    return;
  }
  const previousRun = state.serverPropertiesRuns.get(modelId) ?? IDLE_RUN;
  const owner: ServerPropertiesOwner = { model, isStale };
  const ownsModel = () => {
    const current = useViewerStore.getState().models.get(modelId);
    // The finalizer preserves these identities. Another properties/source writer
    // means replacement: its store must not be overwritten by this older poll.
    return !owner.isStale?.() && current !== undefined && current.loadState !== 'error' &&
      current.sourceFile === owner.model.sourceFile && current.ifcDataStore === owner.model.ifcDataStore;
  };
  const write = (run: ServerPropertiesRun) => useViewerStore.getState().setServerPropertiesRun(modelId, run);
  const slot = createRunSlot<void, never, ServerPropertiesOwner, string>({
    read: () => {
      const run = useViewerStore.getState().serverPropertiesRuns.get(modelId) ?? IDLE_RUN;
      return run.kind === 'running' && run.owner !== owner ? IDLE_RUN : run;
    },
    write,
    subscribe: listener => {
      const supersession = watchLoadSupersession('primary');
      const supersede = () => write(IDLE_RUN);
      supersession.signal.addEventListener('abort', supersede, { once: true });
      const stop = useViewerStore.subscribe(() => {
        const run = useViewerStore.getState().serverPropertiesRuns.get(modelId);
        if (run?.kind === 'running' && run.owner === owner && !ownsModel()) write(IDLE_RUN);
        listener();
      });
      return () => {
        stop(); supersession.stop();
        supersession.signal.removeEventListener('abort', supersede);
        const run = useViewerStore.getState().serverPropertiesRuns.get(modelId);
        if (run?.kind === 'running' && run.owner === owner) write(IDLE_RUN);
      };
    },
  }, { begin: () => ({ kind: 'load', title: 'activityTray.job.load', phase: 'Server properties (geometry remains available)' }) });
  void slot.run(owner, async lease => {
    const dataStore = await hydrate(lease.signal);
    if (!dataStore) return;
    await waitForCompletion(modelId, lease.signal);
    // The loader registered this model from its meshes. The data model also holds entities
    // without geometry (storeys, spaces, types) whose ids can lie above every meshed one, so
    // the model's id range grows with the store that brings them. The registry has no
    // transaction: immediately synchronize the ownership bound even if settlement is rejected.
    withDeferredOverlayCapacity(() => {
      if (!lease.isCurrent() || !ownsModel()) return;
      let idRange: { maxExpressId: number };
      try { idRange = extendModelIdRange(modelId, dataStore); }
      catch (error) {
        // A refused replacement does not invalidate properties and edits we already own.
        if (!owner.model.ifcDataStore) throw error;
        console.warn('[Server properties] Re-hydration refused; previous properties remain available', error);
        if (lease.succeed()) write(previousRun);
        return;
      }
      // Ownership is permanent even if extension/warning supersedes the lease.
      // Commit the hydrated store only if settlement still owns this model.
      const accepted = lease.succeed();
      useViewerStore.getState().updateModel(modelId, accepted
        ? { ifcDataStore: dataStore, ...idRange }
        : idRange);
      if (accepted && !useViewerStore.getState().models.get(modelId)?.hasOverlayCapacity) {
        console.warn(`[Server properties] Model ${modelId}: no id is left for edits in its safe range`);
      }
    });
  }, { scopeIsCurrent: ownsModel, toError: error => {
    console.warn('[Server properties] Optional hydration failed; geometry remains available', error);
    return error instanceof Error ? error.message : String(error);
  } });
}

const properties = {
  start,
  cancel: (modelId: string | null) => {
    if (modelId) useViewerStore.getState().setServerPropertiesRun(modelId, IDLE_RUN);
  },
};
/** Store-owned runs survive unmount/remount of every component using this facade. */
export function useServerModelProperties() { return properties; }
