/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useSearchIndex — lazy builder for the Tier-1 search index.
 *
 * Mount once near the root of the viewer shell (currently `SearchInline`,
 * since it's always rendered once the toolbar is up). The hook watches
 * the federated `models` map; for each model with a populated
 * `ifcDataStore` that doesn't yet have a Tier-1 record, it spawns a
 * chunked build. Models that disappear get their index record dropped.
 *
 * Load-perf guarantee: the build NEVER runs during the actual IFC load
 * because `ifcDataStore` is non-null only after the parser reports the
 * model is ready (`onSpatialReady` + geometry). The build itself yields
 * to the event loop every `DEFAULT_CHUNK_SIZE` rows so a 4M-entity
 * index doesn't hog the main thread.
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
      const existing = searchIndexes.get(modelId);
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
          if (controller.signal.aborted) return;
          controllers.delete(modelId);
          setSearchIndexRecord(modelId, { status: 'ready', index, progress: 1 });
        })
        .catch((err: unknown) => {
          controllers.delete(modelId);
          if (err instanceof DOMException && err.name === 'AbortError') return;
          const message = err instanceof Error ? err.message : String(err);
          // Don't set a 'ready' record — Tier-0 fallback stays live.
          console.warn(`[useSearchIndex] build failed for ${modelId}:`, message);
          setSearchIndexRecord(modelId, { status: 'error', error: message });
        });
    }

    // On unmount OR next effect pass, abort everything. The effect re-runs
    // only when `models` / `searchIndexes` changes, so steady-state
    // incurs no abort — the `controllers.has(modelId)` guard above makes
    // re-entry idempotent.
    return () => {
      // Intentionally NOT aborting everything on every re-render — only
      // models that went missing got aborted above. The real cleanup is
      // the component-unmount pass below.
    };
  }, [models, searchIndexes, setSearchIndexRecord, removeSearchIndexRecord, searchFilterSchema, removeFilterSchema]);

  // Abort any in-flight builds when the consumer unmounts. Separate effect
  // so it only fires on unmount (no deps).
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
    };
  }, []);
}
