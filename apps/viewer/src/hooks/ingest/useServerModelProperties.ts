/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { createRunSlot, IDLE_RUN } from '@/lib/runs/run-slot';
import type { ServerPropertiesOwner, ServerPropertiesRun } from '@/store/slices/serverPropertiesSlice';
import { watchLoadSupersession } from '../modelLoadCanceller.js';

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
  // Dropping the prior record ends its lease, even when the model id is reused.
  write(IDLE_RUN);
  void slot.run(owner, async lease => {
    const dataStore = await hydrate(lease.signal);
    if (!dataStore) return;
    await waitForCompletion(modelId, lease.signal);
    if (lease.isCurrent() && ownsModel()) {
      // End ownership before replacing the very store identity it protects.
      lease.succeed();
      useViewerStore.getState().updateModel(modelId, { ifcDataStore: dataStore });
    }
  }, { scopeIsCurrent: ownsModel, toError: error => {
    console.warn('[Server properties] Optional hydration failed; geometry remains available', error);
    return error instanceof Error ? error.message : String(error);
  } });
}

const properties = { start, cancel: () => useViewerStore.getState().clearServerPropertiesRuns() };
/** Store-owned runs survive unmount/remount of every component using this facade. */
export function useServerModelProperties() { return properties; }
