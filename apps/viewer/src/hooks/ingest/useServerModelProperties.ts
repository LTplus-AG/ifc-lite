/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { useAsyncRun } from '../useAsyncRun.js';
import { watchLoadSupersession } from '../modelLoadCanceller.js';

/** Optional properties belong to the model, not the loader's metadata signal. */
export function useServerModelProperties() {
  const { restart, reset } = useAsyncRun({ label: 'Server properties (geometry remains available)' });
  const start = useCallback((modelId: string | null, isStale: (() => boolean) | undefined,
    hydrate: (signal: AbortSignal) => Promise<IfcDataStore | null>) => {
    const state = useViewerStore.getState();
    const owner = modelId ? state.models.get(modelId) : undefined;
    if (!owner || !modelId) return;
    void restart(async lease => {
      const ownsModel = () => {
        const current = useViewerStore.getState();
        const model = current.models.get(modelId);
        return !isStale?.() &&
          model !== undefined && model.sourceFile === owner.sourceFile && model.ifcDataStore === owner.ifcDataStore;
      };
      let ready!: () => void;
      const finalized = new Promise<void>(resolve => { ready = resolve; });
      const observe = () => {
        if (!ownsModel() || useViewerStore.getState().models.get(modelId)?.loadState === 'error') reset();
        else if (useViewerStore.getState().models.get(modelId)?.loadState === 'complete') ready();
      };
      const unsubscribe = useViewerStore.subscribe(observe);
      const supersession = watchLoadSupersession('primary');
      supersession.signal.addEventListener('abort', reset, { once: true });
      const dispose = () => {
        unsubscribe(); supersession.stop();
        supersession.signal.removeEventListener('abort', reset);
        ready();
      };
      lease.signal.addEventListener('abort', dispose, { once: true });
      observe();
      try {
        const dataStore = await hydrate(lease.signal);
        if (!dataStore) return;
        // A fast response must not be overwritten by geometry's finalizer.
        await finalized;
        dispose();
        if (lease.isCurrent() && ownsModel()) useViewerStore.getState().updateModel(modelId, { ifcDataStore: dataStore });
      } finally {
        dispose();
        lease.signal.removeEventListener('abort', dispose);
      }
    });
  }, [restart, reset]);
  return { start, cancel: reset };
}
