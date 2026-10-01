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
import { type ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import type { ListDataProvider } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import type { ModelProviderPair } from '@/lib/lists/run-list';

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

  return useMemo(() => prepareListProviders({ models, ifcDataStore, geometryResult, zoneSets,
    zoneAssignments, zoneApportionment, toGlobalId, mutationViews }, renderFrame),
  [models, ifcDataStore, geometryResult, renderFrame, zoneSets, zoneAssignments, zoneApportionment, toGlobalId, mutationViews, mutationVersion]);
}
