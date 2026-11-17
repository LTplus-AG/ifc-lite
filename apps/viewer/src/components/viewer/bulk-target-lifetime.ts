/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BulkQueryEngine, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';

/** Each captured engine may write only to the data/view pair it was built for. */
export function captureBulkTargetEngines(
  engines: ReadonlyMap<string, BulkQueryEngine | null | undefined>,
  getData: (modelId: string) => IfcDataStore | null | undefined,
  views: ReadonlyMap<string, MutablePropertyView>,
) {
  const targets = new Map([...engines].map(([modelId, engine]) =>
    [modelId, { engine, data: getData(modelId), view: views.get(modelId) }] as const));
  const matches = (modelId: string, target: NonNullable<ReturnType<typeof targets.get>>) => {
    const state = useViewerStore.getState();
    const data = modelId === '__legacy__' ? state.ifcDataStore : state.models.get(modelId)?.ifcDataStore;
    return !!target.engine && !!target.data && !!target.view
      && data === target.data && state.getMutationView(modelId) === target.view;
  };
  return {
    isCurrent: () => [...targets].every(([modelId, target]) => matches(modelId, target)),
    getEngine: (modelId: string) => {
      const target = targets.get(modelId);
      return target && matches(modelId, target) ? target.engine : undefined;
    },
  };
}
