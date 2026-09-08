/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One viewer-shell owner builds per-model search indexes (#3993).
 * Search interfaces consume the records and use Tier-0 while a build is pending.
 * Partial/final metadata wrappers retain their model's in-flight or ready index.
 */

import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { buildTier1Index } from '@/lib/search/tier1-index';

export function useSearchIndex(): void {
  const {
    models,
    searchIndexes,
    setSearchIndexRecord,
    removeSearchIndexRecord,
    searchFilterSchema,
    removeFilterSchema,
  } = useViewerStore(
    useShallow((s) => ({
      models: s.models,
      searchIndexes: s.searchIndexes,
      setSearchIndexRecord: s.setSearchIndexRecord,
      removeSearchIndexRecord: s.removeSearchIndexRecord,
      searchFilterSchema: s.searchFilterSchema,
      removeFilterSchema: s.removeFilterSchema,
    })),
  );

  // One AbortController per in-flight build. Lets us cancel cleanly when a
  // model is removed mid-build or when the component unmounts.
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const controllers = controllersRef.current;

    // Drop records / abort builds for models that no longer exist.
    for (const modelId of Array.from(searchIndexes.keys())) {
      if (!models.has(modelId)) {
        controllers.get(modelId)?.abort();
        controllers.delete(modelId);
        removeSearchIndexRecord(modelId);
      }
    }

    // Drop the filter-schema cache for departed models too. Stale entries
    // would surface in the chip dropdowns the next time a model with the
    // same id loaded (e.g. user reopens a different file as model_0).
    for (const modelId of Array.from(searchFilterSchema.keys())) {
      if (!models.has(modelId)) removeFilterSchema(modelId);
    }

    // Kick off builds for models that are loaded but not yet indexed.
    for (const [modelId, model] of models) {
      if (!model.ifcDataStore) continue;
      const existing = useViewerStore.getState().searchIndexes.get(modelId);
      if (existing && existing.status !== 'pending') continue;
      if (controllers.has(modelId)) continue;

      const controller = new AbortController();
      controllers.set(modelId, controller);

      setSearchIndexRecord(modelId, { status: 'building', progress: 0 });

      // Fire-and-forget — the build is cancellable via the controller, and
      // the completion handlers update the store without needing a ref.
      void buildTier1Index(modelId, model.ifcDataStore, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (controller.signal.aborted) return;
          const progress = total > 0 ? done / total : 1;
          setSearchIndexRecord(modelId, { status: 'building', progress });
        },
      })
        .then((index) => {
          if (controller.signal.aborted || controllers.get(modelId) !== controller) return;
          controllers.delete(modelId);
          setSearchIndexRecord(modelId, { status: 'ready', index, progress: 1 });
        })
        .catch((err: unknown) => {
          if (controllers.get(modelId) !== controller) return;
          controllers.delete(modelId);
          if (err instanceof DOMException && err.name === 'AbortError') return;
          const message = err instanceof Error ? err.message : String(err);
          // Don't set a 'ready' record — Tier-0 fallback stays live.
          console.warn(`[useSearchIndex] build failed for ${modelId}:`, message);
          setSearchIndexRecord(modelId, { status: 'error', error: message });
        });
    }

  }, [models, searchIndexes, setSearchIndexRecord, removeSearchIndexRecord, searchFilterSchema, removeFilterSchema]);

  // Cleanup must release claims, including StrictMode's setup/cleanup/setup.
  // Old promise handlers cannot delete a replacement controller or its result.
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      const active = [...controllers];
      controllers.clear();
      for (const [modelId, controller] of active) {
        controller.abort();
        const state = useViewerStore.getState();
        if (state.models.has(modelId) && state.searchIndexes.get(modelId)?.status === 'building') {
          state.setSearchIndexRecord(modelId, { status: 'pending', progress: 0 });
        }
      }
    };
  }, []);
}
