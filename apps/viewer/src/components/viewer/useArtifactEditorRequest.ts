/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { ChartSpec } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import type { Lens } from '@/store/slices/lensSlice';
import type { ArtifactEditorTarget } from '@/store/slices/uiSlice';

type State = ReturnType<typeof useViewerStore.getState>;
function useEditorRequest<T>(
  kind: ArtifactEditorTarget['kind'],
  resolve: (state: State, target: ArtifactEditorTarget) => T | undefined,
  edit: (item: T | null) => void,
): number {
  const pending = useViewerStore(state => state.pendingArtifactEditor);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const state = useViewerStore.getState();
    // A later Open replaces an older request; an effect from the older render
    // must neither consume it nor open the wrong editor (#7167).
    if (!pending || pending.kind !== kind || state.pendingArtifactEditor !== pending) return;
    const item = resolve(state, pending);
    state.setPendingArtifactEditor(null);
    edit(item ?? null);
    setVersion(value => value + 1);
  }, [pending, kind, resolve, edit]);
  return version;
}

const savedLens = (state: State, target: ArtifactEditorTarget): Lens | undefined =>
  target.kind === 'lens' ? state.savedLenses.find(lens => lens.id === target.id) : undefined;
const savedChart = (state: State, target: ArtifactEditorTarget): ChartSpec | undefined => {
  if (target.kind !== 'chart') return undefined;
  const dashboard = state.dashboards.find(item => item.id === target.dashboardId);
  const chart = dashboard?.charts.find(item => item.id === target.id);
  if (chart) state.setActiveDashboardId(target.dashboardId);
  return chart;
};

export function useLensEditorRequest(edit: (lens: Lens | null) => void): number {
  return useEditorRequest('lens', savedLens, edit);
}
export function useChartEditorRequest(edit: (chart: ChartSpec | null) => void): number {
  return useEditorRequest('chart', savedChart, edit);
}
