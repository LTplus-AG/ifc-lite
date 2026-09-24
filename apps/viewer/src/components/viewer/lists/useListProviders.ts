/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list engine's view of the loaded federation: one `ListDataProvider`
 * per model (with its zone / world-coordinate context), plus each model's
 * declared units. Extracted from `ListPanel` (#5142) so the Lists panel and
 * a document's table blocks build their providers from the same store
 * reads — a list run outside the panel must see the same zones, units and
 * render frame the panel does.
 */
import { useMemo } from 'react';
import { extractProjectUnits, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import type { ListDataProvider } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets';
import { createListDataProvider } from '@/lib/lists';
import type { ModelProviderPair } from '@/lib/lists/run-list';
import { makeWorldPositionGetter } from '@/lib/geo/entity-world-position';
import { zoneVolumeSiScale } from '@/lib/units/zone-volume-scale';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';

export interface ListProviders {
  /** {modelId, provider, store} triples, built in one pass so they can never drift out of alignment. */
  pairs: ModelProviderPair[];
  providers: ListDataProvider[];
  stores: IfcDataStore[];
  /** Every loaded model's declared units, keyed by the same modelId the rows carry (#1573 follow-up). */
  modelUnits: Map<string, ProjectUnits>;
  /** `false` when no loaded model carries an `IfcDataStore` to query. */
  hasData: boolean;
}

export function useListProviders(): ListProviders {
  const { ifcDataStore, models, geometryResult } = useIfc();
  const renderFrame = useRenderFrameOffsets(); // scene-wide frame for World X/Y/Z (issue #3671)

  // Zone assignment (issue #1810) is shared across every model's provider —
  // `zoneAssignments` is already keyed by federated global id, so each
  // model's provider just needs ITS OWN `toGlobalId` closure.
  const zoneSets = useViewerStore((s) => s.zoneSets);
  const zoneAssignments = useViewerStore((s) => s.zoneAssignments);
  const zoneApportionment = useViewerStore((s) => s.zoneApportionment);
  const toGlobalId = useViewerStore((s) => s.toGlobalId);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  // Declared VOLUMEUNIT scale per model (#2508), memoized on MODELS alone so
  // zone/assignment changes don't re-derive a value that cannot have moved.
  const volumeScaleByModelId = useMemo(() => {
    const map = new Map<string, number>();
    const scaleOf = (store: IfcDataStore) => (store.source.length > 0
      ? zoneVolumeSiScale(extractProjectUnits(store.source, store.entityIndex)) : 1);
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue;
        map.set(modelId, scaleOf(model.ifcDataStore));
      }
    } else if (ifcDataStore) {
      map.set('default', scaleOf(ifcDataStore));
    }
    return map;
  }, [models, ifcDataStore]);

  const pairs = useMemo(() => {
    const out: ModelProviderPair[] = [];
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue; // native-metadata model, nothing to query
        const zoneContext = {
          zoneSets, zoneAssignments,
          apportionment: zoneApportionment,
          volumeSiScale: volumeScaleByModelId.get(modelId) ?? 1,
          toGlobalId: (expressId: number) => toGlobalId(modelId, expressId),
          getWorldPosition: makeWorldPositionGetter(model.ifcDataStore, model.geometryResult ?? geometryResult, renderFrame, (id) => toGlobalId(modelId, id)),
        };
        out.push({ modelId, provider: createListDataProvider(model.ifcDataStore, model.name, zoneContext, mutationViews.get(modelId)), store: model.ifcDataStore });
      }
    } else if (ifcDataStore) {
      const zoneContext = {
        zoneSets, zoneAssignments,
        apportionment: zoneApportionment,
        volumeSiScale: volumeScaleByModelId.get('default') ?? 1,
        toGlobalId: (expressId: number) => toGlobalId('default', expressId),
        getWorldPosition: makeWorldPositionGetter(ifcDataStore, geometryResult, renderFrame, (id) => toGlobalId('default', id)),
      };
      const view = mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? mutationViews.get(LEGACY_MODEL_ID);
      out.push({ modelId: 'default', provider: createListDataProvider(ifcDataStore, '', zoneContext, view), store: ifcDataStore });
    }
    return out;
  }, [models, ifcDataStore, geometryResult, renderFrame, zoneSets, zoneAssignments, zoneApportionment, volumeScaleByModelId, toGlobalId, mutationViews, mutationVersion]);

  const providers = useMemo(() => pairs.map((p) => p.provider), [pairs]);
  const stores = useMemo(() => pairs.map((p) => p.store), [pairs]);

  // The single per-model source both the on-screen table and the export
  // resolve quantity/measure columns against (`resolveListColumnUnits`), so
  // a federation of models with different declared units converts each row
  // from ITS OWN model's unit rather than assuming every row shares the
  // first model's units.
  const modelUnits = useMemo(() => {
    const map = new Map<string, ProjectUnits>();
    for (const { modelId, store } of pairs) {
      map.set(modelId, store.source.length > 0 ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty());
    }
    return map;
  }, [pairs]);

  return { pairs, providers, stores, modelUnits, hasData: pairs.length > 0 };
}
