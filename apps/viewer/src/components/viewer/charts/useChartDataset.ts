/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dashboard's dataset for its scope, rebuilt only when the inputs the
 * scope reads actually change: the federation for `all`, plus the basket for
 * `basket`, plus every visibility channel for `visible`.
 */
import { useMemo } from 'react';
import type { ChartDataset, ChartScope } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { buildElementsDataset } from '@/lib/charts/datasets/elements';

export function useChartDataset(scope: ChartScope): ChartDataset {
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const pinboardEntities = useViewerStore((s) => s.pinboardEntities);
  const visible = scope.kind === 'visible';
  // Only a `visible` scope pays for these subscriptions; the selector returns
  // a constant otherwise so a hide/isolate does not rebuild an `all` dataset.
  const hiddenEntities = useViewerStore((s) => (visible ? s.hiddenEntities : null));
  const isolatedEntities = useViewerStore((s) => (visible ? s.isolatedEntities : null));
  const classFilter = useViewerStore((s) => (visible ? s.classFilter : null));
  const lensHiddenIds = useViewerStore((s) => (visible ? s.lensHiddenIds : null));
  const selectedStoreys = useViewerStore((s) => (visible ? s.selectedStoreys : null));
  const typeVisibility = useViewerStore((s) => (visible ? s.typeVisibility : null));

  return useMemo(
    () => buildElementsDataset(scope, { models, activeModelId, pinboardEntities }),
    // The visibility channels are read inside `buildElementsDataset` through
    // the store; they are deps so the memo invalidates when they change.
    [scope, models, activeModelId, pinboardEntities, hiddenEntities, isolatedEntities, classFilter, lensHiddenIds, selectedStoreys, typeVisibility],
  );
}
