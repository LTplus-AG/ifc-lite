/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chart editor's catalog of chartable IFC fields across the federation
 * (#4833). Every model's elements are scanned in chunks on the main thread
 * (yielding between chunks so a model unload can cancel the scan); the raw
 * observations of every chunk and every model are MERGED, and the field kinds
 * are inferred once from the merged record — so which model loaded first
 * cannot change whether a field is offered as a number or a category.
 */
import { useEffect, useState } from 'react';
import { EntityFlags } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { createElementFieldReader, type ElementFieldCatalog } from '@/lib/charts/element-field-reader';
import { catalogFromObservations, emptyObservations, mergeObservations } from '@/lib/charts/element-field-discovery';
import { iterateEffectiveChartRows } from '@/lib/charts/datasets/effective-elements';

export interface ElementFieldCatalogState {
  catalog: ElementFieldCatalog;
  loading: boolean;
}

const EMPTY: ElementFieldCatalog = { attributes: [], properties: new Map(), quantities: new Map(), relations: [] };
const CHUNK = 500;

export function useElementFieldCatalog(enabled: boolean): ElementFieldCatalogState {
  const models = useViewerStore((s) => s.models);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [state, setState] = useState<ElementFieldCatalogState>({ catalog: EMPTY, loading: false });

  useEffect(() => {
    if (!enabled) {
      setState({ catalog: EMPTY, loading: false });
      return;
    }
    let cancelled = false;
    setState({ catalog: EMPTY, loading: true });
    const run = async (): Promise<void> => {
      const observations = emptyObservations();
      for (const model of models.values()) {
        if (cancelled) return;
        const store = model.ifcDataStore;
        if (!store) continue;
        const view = mutationViews.get(model.id);
        const reader = createElementFieldReader(store, view);
        let ids: number[] = [];
        let scanned = 0;
        for (const row of iterateEffectiveChartRows(store, view)) {
          if ((row.flags & EntityFlags.HAS_GEOMETRY) !== 0 && (row.flags & EntityFlags.IS_TYPE) === 0) ids.push(row.expressId);
          if (++scanned % CHUNK === 0) {
            if (ids.length > 0) mergeObservations(observations, reader.observe(ids));
            ids = [];
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (cancelled) return;
          }
        }
        if (ids.length > 0) mergeObservations(observations, reader.observe(ids));
      }
      if (cancelled) return;
      setState({ loading: false, catalog: catalogFromObservations(observations) });
    };
    void run().catch((error: unknown) => {
      if (!cancelled) {
        console.error('Failed to discover chart IFC fields', error);
        setState({ catalog: EMPTY, loading: false });
      }
    });
    return () => { cancelled = true; };
  }, [enabled, models, mutationViews, mutationVersion]);

  return state;
}
