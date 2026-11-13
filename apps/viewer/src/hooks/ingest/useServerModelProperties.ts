/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { createRunSlot, IDLE_RUN } from '@/lib/runs/run-slot';
import type { ServerPropertiesOwner, ServerPropertiesRun } from '@/store/slices/serverPropertiesSlice';
import { watchLoadSupersession } from '../modelLoadCanceller.js';
import { federationRegistry } from '@ifc-lite/renderer';
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

/** Publishes the hydrated store's ids. The watermark is the store's highest id, so no authored id
 *  reuses a hydrated one; a range a later model clamps leaves the model without authoring ids. */
function extendModelIdRange(modelId: string, dataStore: IfcDataStore): { maxExpressId: number; idSpaceExhausted: boolean } {
  const registered = useViewerStore.getState().models.get(modelId)?.maxExpressId ?? 0;
  const maxExpressId = Math.max(registered, getMaxExpressId(dataStore, []));
  // An unregistered primary keeps the single-model `globalId === expressId` fallback.
  if (!federationRegistry.hasModel(modelId)) return { maxExpressId, idSpaceExhausted: false };
  // Throws only for a range carrying authored ids, which `dataMutationPermission` rules out while
  // properties load; the run then fails like any optional hydration and nothing is aliased.
  const published = federationRegistry.extendModel(modelId, maxExpressId);
  if (published >= maxExpressId) return { maxExpressId, idSpaceExhausted: false }; // clears an earlier flag
  console.warn(`[Server properties] Ids ${published + 1}..${maxExpressId} of model ${modelId} lie past the ids a later model owns; those entities cannot be selected or resolved, and the model cannot be edited`);
  return { maxExpressId, idSpaceExhausted: true };
}

function start(modelId: string | null, isStale: (() => boolean) | undefined,
  hydrate: (signal: AbortSignal) => Promise<IfcDataStore | null>): void {
  const state = useViewerStore.getState();
  const model = modelId ? state.models.get(modelId) : undefined;
  if (!model || !modelId) {
    console.warn('[Server properties] Cannot hydrate without a registered model', modelId);
    return;
  }
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
    // transaction: grow it only for a result that publishes in this same turn.
    const idRange = lease.isCurrent() && ownsModel() ? extendModelIdRange(modelId, dataStore) : undefined;
    // A rejected settlement must never publish, including after cancellation.
    if (lease.succeed()) {
      useViewerStore.getState().updateModel(modelId, { ifcDataStore: dataStore, ...idRange });
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
