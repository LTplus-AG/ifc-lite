/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLoadWindowHold } from './loadWindow.js';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { displayedTranslation } from '@/lib/model-placement/state';
import type { Translation } from '@/lib/model-placement/translation';
import { useViewerStore } from '@/store';

export interface SymbolicActiveStore {
  meshes?: readonly MeshData[];
  translation: Translation;
  store: IfcDataStore;
  modelId: string;
  idOffset: number;
  mutationView?: MutablePropertyView;
}

/** Read the federation-aware active store set and RTC publication dependencies. */
export function useSymbolicActiveStores(): SymbolicActiveStore[] {
  const { models, ifcDataStore, placement, geometryResult, loading, mutationVersion, mutationViews } = useViewerStore(
    useShallow((state) => ({
      models: state.models,
      ifcDataStore: state.ifcDataStore,
      placement: state.modelPlacement,
      geometryResult: state.geometryResult,
      loading: state.loading,
      // Some live hierarchy maps are patched in place when authored entities
      // are added. Their object identity stays stable; mutationVersion is the
      // store signal that must re-run consumers such as symbolic bucket lookup.
      mutationVersion: state.mutationVersion,
      mutationViews: state.mutationViews,
    })),
  );

  // A loading model's IfcGrid / annotation overlays wait for its load to settle
  // (loadWindow.ts): their parse key walks the model's spatial lookups, which
  // inside the load window ran in the drain and finalize that end the load. The
  // cache key stays a content digest (#6421, #9621), so it cannot be made
  // constant-time soundly. A model that had settled keeps its overlays.
  const loadHold = useLoadWindowHold();

  // `loading` is provenance state for the legacy primary path: true means
  // wait for an exact frame; false without one means standalone parsing.
  return useMemo(() => {
    const out: SymbolicActiveStore[] = [];
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore || loadHold.isHeld(modelId)) continue;
        out.push({
          meshes: model.geometryResult?.meshes,
          store: model.ifcDataStore,
          modelId,
          idOffset: model.idOffset ?? 0,
          mutationView: mutationViews.get(modelId),
          translation: displayedTranslation(placement, modelId),
        });
      }
    } else if (ifcDataStore && !loadHold.isHeld('legacy')) {
      out.push({
        meshes: geometryResult?.meshes,
        store: ifcDataStore,
        modelId: 'legacy',
        idOffset: 0,
        mutationView: mutationViews.get('__legacy__'),
        translation: [0, 0, 0],
      });
    }
    return out;
  }, [models, ifcDataStore, placement, geometryResult, loading, loadHold, mutationVersion, mutationViews]);
}
