/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Charts panel (#3944): a dashboard of charts bound to the loaded models,
 * bidirectional with the 3D view. Click a bar and its elements are selected
 * and ghosted / isolated / highlighted; pick in 3D and the bars light up;
 * the selection in one chart slices the others.
 *
 * Bottom-strip panel like Schedule and Lists (`lib/panels/bottom-panels`).
 * Dashboards persist in localStorage; the first open seeds "Model overview".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Plus, X } from 'lucide-react';
import type { Aggregation, ChartScope, ChartSpec, DashboardSpec } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import type { ChartFocusMode } from '@/store/slices/chartSlice';
import { modelOverviewDashboard, newChartSpec } from '@/lib/charts/presets';
import { ChartCard } from './ChartCard';
import { ChartEditor } from './ChartEditor';
import { useChart3DLink, useChartColorOverlay } from './useChart3DLink';
import { useChartDataset } from './useChartDataset';
import type { ChartRenderer } from './useEChart';

const FOCUS_LABEL: Record<ChartFocusMode, string> = { highlight: 'Highlight', isolate: 'Isolate', ghost: 'Ghost others' };
const SCOPE_LABEL: Record<ChartScope['kind'], string> = { all: 'All models', visible: 'Visible elements', basket: 'Basket', list: 'Saved list' };

export interface ChartsPanelProps {
  onClose?: () => void;
  /** Injectable chart renderer; tests pass a recorder, the app uses ECharts. */
  renderer?: ChartRenderer;
}

export function ChartsPanel({ onClose, renderer }: ChartsPanelProps) {
  const dashboards = useViewerStore((s) => s.dashboards);
  const activeDashboardId = useViewerStore((s) => s.activeDashboardId);
  const setActiveDashboardId = useViewerStore((s) => s.setActiveDashboardId);
  const upsertDashboard = useViewerStore((s) => s.upsertDashboard);
  const focusMode = useViewerStore((s) => s.chartFocusMode);
  const setFocusMode = useViewerStore((s) => s.setChartFocusMode);
  const colorIn3D = useViewerStore((s) => s.chartColorIn3D);
  const setColorIn3D = useViewerStore((s) => s.setChartColorIn3D);
  const chartSlice = useViewerStore((s) => s.chartSlice);
  const modelCount = useViewerStore((s) => s.models.size);

  // Seed the first dashboard so the panel opens with something to click.
  useEffect(() => {
    if (dashboards.length === 0) {
      const seeded = modelOverviewDashboard();
      upsertDashboard(seeded);
      setActiveDashboardId(seeded.id);
    } else if (!activeDashboardId || !dashboards.some((d) => d.id === activeDashboardId)) {
      setActiveDashboardId(dashboards[0].id);
    }
  }, [dashboards, activeDashboardId, upsertDashboard, setActiveDashboardId]);

  const dashboard = useMemo(() => dashboards.find((d) => d.id === activeDashboardId) ?? null, [dashboards, activeDashboardId]);
  const scope = dashboard?.scope ?? { kind: 'all' as const };
  const dataset = useChartDataset(scope);
  const link = useChart3DLink();

  const [editing, setEditing] = useState<ChartSpec | null>(null);
  const [aggregations, setAggregations] = useState<Map<string, Aggregation | null>>(new Map());
  const onAggregation = useCallback((spec: ChartSpec, aggregation: Aggregation | null) => {
    setAggregations((prev) => (prev.get(spec.id) === aggregation ? prev : new Map(prev).set(spec.id, aggregation)));
  }, []);
  // Colour the 3D view by the first chart that has buckets — the dashboard's headline chart.
  const overlayAggregation = useMemo(() => {
    for (const spec of dashboard?.charts ?? []) {
      const agg = aggregations.get(spec.id);
      if (agg && agg.categories.length > 0) return agg;
    }
    return null;
  }, [dashboard, aggregations]);
  useChartColorOverlay(overlayAggregation);

  const update = useCallback((next: DashboardSpec) => upsertDashboard(next), [upsertDashboard]);
  const saveChart = useCallback((spec: ChartSpec) => {
    if (!dashboard) return;
    const exists = dashboard.charts.some((c) => c.id === spec.id);
    const charts = exists ? dashboard.charts.map((c) => (c.id === spec.id ? spec : c)) : [...dashboard.charts, spec];
    const layout = exists ? dashboard.layout : [...dashboard.layout, { chartId: spec.id, x: 0, y: dashboard.layout.length * 4, w: 6, h: 4 }];
    update({ ...dashboard, charts, layout });
    setEditing(null);
  }, [dashboard, update]);
  const removeChart = useCallback((id: string) => {
    if (!dashboard) return;
    update({ ...dashboard, charts: dashboard.charts.filter((c) => c.id !== id), layout: dashboard.layout.filter((l) => l.chartId !== id) });
  }, [dashboard, update]);
  const setScope = useCallback((kind: ChartScope['kind']) => {
    if (!dashboard || kind === 'list') return;
    update({ ...dashboard, scope: { kind } });
  }, [dashboard, update]);

  const select = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5';

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-charts-panel>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-border">
        <BarChart3 className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
        <select className={select} value={activeDashboardId ?? ''} onChange={(e) => setActiveDashboardId(e.target.value)} aria-label="Dashboard">
          {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-muted-foreground">
          Scope
          <select className={select} value={scope.kind} onChange={(e) => setScope(e.target.value as ChartScope['kind'])} aria-label="Scope">
            {(['all', 'visible', 'basket'] as const).map((k) => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-muted-foreground" title="How a clicked bucket is shown in 3D">
          On click
          <select className={select} value={focusMode} onChange={(e) => setFocusMode(e.target.value as ChartFocusMode)} aria-label="Focus mode">
            {(Object.keys(FOCUS_LABEL) as ChartFocusMode[]).map((m) => <option key={m} value={m}>{FOCUS_LABEL[m]}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 cursor-pointer text-muted-foreground" title="Colour the model by the first chart's buckets">
          <input type="checkbox" checked={colorIn3D} onChange={(e) => setColorIn3D(e.target.checked)} className="accent-[#7aa2f7]" />
          Colour in 3D
        </label>
        {chartSlice && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={link.clearSelection} title="Clear the chart selection and show the whole scope again">
            Clear slice ({chartSlice.size})
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing(newChartSpec())} disabled={!dashboard}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add chart
          </Button>
          {onClose && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose} aria-label="Close charts">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="border-b border-border bg-muted/20">
          <ChartEditor spec={editing} columns={dataset.columns} onSave={saveChart} onCancel={() => setEditing(null)} />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-2">
        {modelCount === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">Load a model to chart it.</div>
        ) : !dashboard || dashboard.charts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <span>No charts yet.</span>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(newChartSpec())}>Add a chart</Button>
          </div>
        ) : (
          <div className="grid gap-2 auto-rows-[220px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {dashboard.charts.map((spec) => (
              <ChartCard
                key={spec.id}
                spec={spec}
                dataset={dataset}
                link={link}
                renderer={renderer}
                onEdit={() => setEditing(spec)}
                onRemove={() => removeChart(spec.id)}
                onAggregation={onAggregation}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
