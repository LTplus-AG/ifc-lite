/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import type { ChartSourceContext } from '@/lib/charts/chart-source';

/** The saved content and loaded models chart bindings resolve against, subscribed for a component. */
export function useChartSourceContext(): ChartSourceContext {
  const comparisons = useViewerStore((s) => s.savedComparisons);
  const clashReports = useViewerStore((s) => s.savedClashReports);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  return useMemo(() => ({ comparisons, clashReports, models, mutationVersion }), [comparisons, clashReports, models, mutationVersion]);
}
