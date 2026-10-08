/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react';
import type { ChartSpec } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import type { Lens } from '@/store/slices/lensSlice';
import type { ArtifactEditorTarget } from '@/store/slices/uiSlice';

type State = ReturnType<typeof useViewerStore.getState>;
function useEditorRequest<T>(
  kind: ArtifactEditorTarget['kind'],
  resolve: (state: State, target: ArtifactEditorTarget) => T | undefined,
  edit: (item: T | null) => void,
  editingId: string | undefined,
): { version: number; canSave: (id: string) => boolean } {
  const pending = useViewerStore(state => state.pendingArtifactEditor);
  const [version, setVersion] = useState(0);
  const [owner, setOwner] = useState<ArtifactEditorTarget | null>(null);
  const savedLenses = useViewerStore(state => state.savedLenses);
  const dashboards = useViewerStore(state => state.dashboards);
  const activeDashboardId = useViewerStore(state => state.activeDashboardId);
  useEffect(() => {
    const state = useViewerStore.getState();
    // A later Open replaces an older request; an effect from the older render
    // must neither consume it nor open the wrong editor (#7167).
    if (!pending || pending.kind !== kind || state.pendingArtifactEditor !== pending) return;
    const item = resolve(state, pending);
    state.setPendingArtifactEditor(null);
    if (item && pending.kind === 'chart') state.setActiveDashboardId(pending.dashboardId);
    setOwner(item ? pending : null);
    edit(item ?? null);
    setVersion(value => value + 1);
  }, [pending, kind, resolve, edit]);
  const canSave = useCallback((id: string) => {
    if (!owner || owner.id !== id) return true;
    const state = useViewerStore.getState();
    return Boolean(resolve(state, owner)) && (owner.kind !== 'chart' || state.activeDashboardId === owner.dashboardId);
  }, [owner, resolve]);
  useEffect(() => {
    // A saved editor cannot become a new draft when its identity disappears,
    // or carry its chart into a different dashboard (#7167).
    if (pending?.kind === kind) return;
    if (owner && editingId !== owner.id) { setOwner(null); return; }
    if (owner && !canSave(owner.id)) { setOwner(null); edit(null); }
  }, [owner, canSave, edit, savedLenses, dashboards, activeDashboardId, pending, kind, editingId]);
  return { version, canSave };
}

const savedLens = (state: State, target: ArtifactEditorTarget): Lens | undefined =>
  target.kind === 'lens' ? state.savedLenses.find(lens => lens.id === target.id) : undefined;
const savedChart = (state: State, target: ArtifactEditorTarget): ChartSpec | undefined => {
  if (target.kind !== 'chart') return undefined;
  const dashboard = state.dashboards.find(item => item.id === target.dashboardId);
  const chart = dashboard?.charts.find(item => item.id === target.id);
  return chart;
};

export function useLensEditorRequest(edit: (lens: Lens | null) => void, editingId: string | undefined): { version: number; canSave: (id: string) => boolean } {
  return useEditorRequest('lens', savedLens, edit, editingId);
}
export function useChartEditorRequest(edit: (chart: ChartSpec | null) => void, editingId: string | undefined): { version: number; canSave: (id: string) => boolean } {
  return useEditorRequest('chart', savedChart, edit, editingId);
}
