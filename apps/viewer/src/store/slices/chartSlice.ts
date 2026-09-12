/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Charts panel state (#3944): the saved dashboards, which one is open, how a
 * chart click presents in 3D, and the panel's claim on the shared
 * isolate / ghost channel.
 *
 * Dashboards persist like list definitions (localStorage). Everything else is
 * session state: the active slice is a set of renderer ids that die with the
 * model, and the ownership record is a claim on a channel that the teardown
 * releases exactly like clash's and the basket's.
 */
import type { StateCreator } from 'zustand';
import type { DashboardSpec } from '@ifc-lite/charts';
import type { VisibilityOwnership } from '@/lib/visibility/ownership';
import { loadDashboards, saveDashboards } from '../../lib/charts/persistence.js';
import { defineSliceTeardown } from '../teardown.js';

/** How a chart click presents its bucket in 3D — the clash panel's vocabulary. */
export type ChartFocusMode = 'highlight' | 'isolate' | 'ghost';

export interface ChartSlice {
  dashboards: DashboardSpec[];
  activeDashboardId: string | null;
  chartPanelVisible: boolean;
  chartFocusMode: ChartFocusMode;
  /** Push bucket colours into the 3D view as an overlay layer. */
  chartColorIn3D: boolean;
  /** Renderer ids the current chart selection resolves to; `null` = no slice. */
  chartSlice: Set<number> | null;
  /** The chart whose selection produced `chartSlice`; it keeps showing the whole scope. */
  chartSliceSource: string | null;
  /** The panel's claim on the isolate/ghost channel, released only if still owned. */
  chartVisibilityOwned: VisibilityOwnership;

  setDashboards: (dashboards: DashboardSpec[]) => void;
  upsertDashboard: (dashboard: DashboardSpec) => void;
  deleteDashboard: (id: string) => void;
  setActiveDashboardId: (id: string | null) => void;
  setChartPanelVisible: (visible: boolean) => void;
  setChartFocusMode: (mode: ChartFocusMode) => void;
  setChartColorIn3D: (on: boolean) => void;
  setChartSlice: (slice: Set<number> | null, source?: string | null) => void;
  setChartVisibilityOwned: (owned: VisibilityOwnership) => void;
}

export const createChartSlice: StateCreator<ChartSlice, [], [], ChartSlice> = (set, get) => ({
  dashboards: loadDashboards(),
  activeDashboardId: null,
  chartPanelVisible: false,
  chartFocusMode: 'ghost',
  chartColorIn3D: false,
  chartSlice: null,
  chartSliceSource: null,
  chartVisibilityOwned: null,

  setDashboards: (dashboards) => {
    set({ dashboards });
    saveDashboards(dashboards);
  },
  upsertDashboard: (dashboard) => {
    const current = get().dashboards;
    const index = current.findIndex((d) => d.id === dashboard.id);
    const dashboards = index === -1 ? [...current, dashboard] : current.map((d, i) => (i === index ? dashboard : d));
    set({ dashboards });
    saveDashboards(dashboards);
  },
  deleteDashboard: (id) => {
    const dashboards = get().dashboards.filter((d) => d.id !== id);
    set({ dashboards, activeDashboardId: get().activeDashboardId === id ? null : get().activeDashboardId });
    saveDashboards(dashboards);
  },
  setActiveDashboardId: (activeDashboardId) => set({ activeDashboardId }),
  setChartPanelVisible: (chartPanelVisible) => set({ chartPanelVisible }),
  setChartFocusMode: (chartFocusMode) => set({ chartFocusMode }),
  setChartColorIn3D: (chartColorIn3D) => set({ chartColorIn3D }),
  setChartSlice: (chartSlice, source = null) => set({ chartSlice, chartSliceSource: chartSlice ? source : null }),
  setChartVisibilityOwned: (chartVisibilityOwned) => set({ chartVisibilityOwned }),
});

/**
 * Dashboards are workspace preferences and survive every teardown; the slice
 * (renderer ids of the outgoing model) and the ownership claim do not. The
 * channel itself is released by the hook that installed it — the record here
 * is the claim, and a stale claim is dangerous (see `lib/visibility/ownership`).
 */
export const chartTeardown = defineSliceTeardown(
  'chartSlice',
  ['chartPanelVisible', 'chartSlice', 'chartSliceSource', 'chartVisibilityOwned'],
  {
    'session-reset': () => ({ chartPanelVisible: false, chartSlice: null, chartSliceSource: null, chartVisibilityOwned: null }),
    'model-removed': ({ isStale }, state) => {
      const slice = state.chartSlice;
      if (!slice) return {};
      const kept = new Set<number>();
      for (const id of slice) if (!isStale(id)) kept.add(id);
      if (kept.size === slice.size) return {};
      return kept.size > 0 ? { chartSlice: kept } : { chartSlice: null, chartSliceSource: null };
    },
    'all-models-cleared': () => ({ chartSlice: null, chartSliceSource: null, chartVisibilityOwned: null }),
  },
);
