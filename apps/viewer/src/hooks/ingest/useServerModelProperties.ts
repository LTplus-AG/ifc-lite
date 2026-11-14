/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { isAbortError } from '@/lib/runs/abort';
import { createRunSlot, IDLE_RUN } from '@/lib/runs/run-slot';
import type { ServerPropertiesOwner, ServerPropertiesRun } from '@/store/slices/serverPropertiesSlice';
import { watchLoadSupersession } from '../modelLoadCanceller.js';
import { federationRegistry, ModelRangeExtensionRefusedError } from '@ifc-lite/renderer';
import { withDeferredOverlayCapacity } from '@/store/overlay-capacity';
import { discardOverlappingRetainedEdits } from '@/utils/model-mutation-view';
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
function extendModelIdRange(modelId: string, dataStore: IfcDataStore, firstHydration: boolean, beforeExtend: () => void): { maxExpressId: number } {
  const registered = useViewerStore.getState().models.get(modelId)?.maxExpressId ?? 0;
  const maxExpressId = Math.max(registered, getMaxExpressId(dataStore, []));
  // An unregistered primary keeps the single-model `globalId === expressId` fallback.
  if (!federationRegistry.hasModel(modelId)) return { maxExpressId };
  // A first hydration discards kept creations the source overlaps, like a local reload.
  // A refresh refuses instead, leaving the source and the edits made against it untouched.
  const state = useViewerStore.getState();
  const firstCreated = firstHydration
    ? discardOverlappingRetainedEdits(state, modelId, maxExpressId)
    : state.mutationViews.get(modelId)?.getCreatedExpressIdBounds().lowest ?? 0;
  beforeExtend();
  const published = federationRegistry.extendModel(modelId, maxExpressId, firstCreated);
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
  let expectedStore = owner.model.ifcDataStore;
  const ownsModel = () => {
    const current = useViewerStore.getState().models.get(modelId);
    // The finalizer preserves these identities. Another properties/source writer
    // means replacement: its store must not be overwritten by this older poll.
    return !owner.isStale?.() && current !== undefined && current.loadState !== 'error' &&
      current.sourceFile === owner.model.sourceFile && current.ifcDataStore === expectedStore;
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
      };
    },
  }, { begin: () => ({ kind: 'load', title: 'activityTray.job.load', phase: 'Server properties (geometry remains available)' }) });
  void slot.run(owner, async lease => {
    let ownershipMayHaveChanged = false;
    try {
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
        try { idRange = extendModelIdRange(modelId, dataStore, !owner.model.ifcDataStore, () => { ownershipMayHaveChanged = true; }); }
        catch (error) {
          if (!(error instanceof ModelRangeExtensionRefusedError)) throw error;
          ownershipMayHaveChanged = false;
          const phase = owner.model.ifcDataStore ? 're-hydration' : 'hydration';
          throw new Error(`Server properties ${phase} refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        // Ownership is permanent even if extension/warning supersedes the lease.
        // Commit the hydrated store only if settlement still owns this model.
        const accepted = lease.isCurrent() && ownsModel();
        // Set before the commit so its own notification keeps ownership; undone
        // if the commit throws before the swap, so the run fails rather than idles.
        const previousStore = expectedStore;
        if (accepted) expectedStore = dataStore;
        try {
          useViewerStore.getState().updateModel(modelId, accepted
            ? { ifcDataStore: dataStore, ...idRange }
            : idRange);
        } catch (error) {
          if (useViewerStore.getState().models.get(modelId)?.ifcDataStore !== dataStore) expectedStore = previousStore;
          throw error;
        }
        if (accepted && !useViewerStore.getState().models.get(modelId)?.hasOverlayCapacity) {
          console.warn(`[Server properties] Model ${modelId}: no id is left for edits in its safe range`);
        }
      });
      // Settlement follows deferred refreshers too: any post-extension error
      // must fail this run, rather than restore permission against stale data.
      lease.succeed();
    } catch (error) {
      if (ownershipMayHaveChanged || !owner.model.ifcDataStore || isAbortError(error)) throw error;
      console.warn('[Server properties] Refresh failed; previous properties remain available', error);
      // A running record cannot be restored: that older lease has been superseded.
      // Idle preserves loaded-store permission without forging a successful run.
      lease.fail(error instanceof Error ? error.message : String(error), {
        record: previousRun.kind === 'running' ? IDLE_RUN : previousRun,
      });
    }
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
