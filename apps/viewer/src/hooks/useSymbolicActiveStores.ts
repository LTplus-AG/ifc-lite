/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { displayedTranslation } from '@/lib/model-placement/state';
import type { Translation } from '@/lib/model-placement/translation';
import { useViewerStore } from '@/store';

export interface SymbolicActiveStore {
  meshes?: readonly MeshData[];
  translation: Translation;
  store: IfcDataStore;
  modelId: string;
  idOffset: number;
}

/** Read the federation-aware active store set and RTC publication dependencies. */
export function useSymbolicActiveStores(): SymbolicActiveStore[] {
  const { models, ifcDataStore, placement, geometryResult, loading } = useViewerStore(
    useShallow((state) => ({
      models: state.models,
      ifcDataStore: state.ifcDataStore,
      placement: state.modelPlacement,
      geometryResult: state.geometryResult,
      loading: state.loading,
    })),
  );

  // `loading` is provenance state for the legacy primary path: true means
  // wait for an exact frame; false without one means standalone parsing.
  return useMemo(() => {
    const out: SymbolicActiveStore[] = [];
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue;
        out.push({
          meshes: model.geometryResult?.meshes,
          store: model.ifcDataStore,
          modelId,
          idOffset: model.idOffset ?? 0,
          translation: displayedTranslation(placement, modelId),
        });
      }
    } else if (ifcDataStore) {
      out.push({
        meshes: geometryResult?.meshes,
        store: ifcDataStore,
        modelId: 'legacy',
        idOffset: 0,
        translation: [0, 0, 0],
      });
    }
    return out;
  }, [models, ifcDataStore, placement, geometryResult, loading]);
}
