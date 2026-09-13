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
import type { Aggregation, ChartScope, ChartSpec, DashboardLayoutItem, DashboardSpec } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import type { ChartFocusMode } from '@/store/slices/chartSlice';
import { DASHBOARD_PRESETS, modelOverviewDashboard, newChartSpec } from '@/lib/charts/presets';
import { ChartCard } from './ChartCard';
import { ChartEditor } from './ChartEditor';
import { DashboardGrid } from './DashboardGrid';
import { DashboardMenu } from './DashboardMenu';
import { ReportExportDialog } from './ReportExportDialog';
import { useChart3DLink, useChartColorOverlay } from './useChart3DLink';
import { useChartDatasets } from './useChartDatasets';
import type { ChartRenderer } from './useEChart';
import type { ReportPdfSeams } from '@/lib/export/report/generate-report-pdf';

const FOCUS_LABEL: Record<ChartFocusMode, string> = { highlight: 'Highlight', isolate: 'Isolate', ghost: 'Ghost others' };
const SCOPE_LABEL: Record<ChartScope['kind'], string> = { all: 'All models', visible: 'Visible elements', basket: 'Basket', list: 'Saved list' };

export interface ChartsPanelProps {
  onClose?: () => void;
  /** Injectable chart renderer; tests pass a recorder, the app uses ECharts. */
  renderer?: ChartRenderer;
  /** Injectable PDF seams for the report export; the app uses jsPDF + the live renderer. */
  reportSeams?: () => Promise<ReportPdfSeams>;
}

/**
 * Seeds "Model overview" when there is no dashboard and makes sure one is
 * active. Reads and writes the live slice, so it is idempotent: StrictMode
 * runs the mount effect twice on the same (empty) render snapshot, and the
 * second run must see the first run's seed rather than add another.
 */
export function ensureActiveDashboard(): void {
  const live = useViewerStore.getState();
  if (live.dashboards.length === 0) {
    const seeded = modelOverviewDashboard();
    live.upsertDashboard(seeded);
    live.setActiveDashboardId(seeded.id);
  } else if (!live.activeDashboardId || !live.dashboards.some((d) => d.id === live.activeDashboardId)) {
    live.setActiveDashboardId(live.dashboards[0].id);
  }
}

export function ChartsPanel({ onClose, renderer, reportSeams }: ChartsPanelProps) {
  const dashboards = useViewerStore((s) => s.dashboards);
  const activeDashboardId = useViewerStore((s) => s.activeDashboardId);
  const setActiveDashboardId = useViewerStore((s) => s.setActiveDashboardId);
  const upsertDashboard = useViewerStore((s) => s.upsertDashboard);
  const deleteDashboard = useViewerStore((s) => s.deleteDashboard);
  const focusMode = useViewerStore((s) => s.chartFocusMode);
  const setFocusMode = useViewerStore((s) => s.setChartFocusMode);
  const colorIn3D = useViewerStore((s) => s.chartColorIn3D);
  const setColorIn3D = useViewerStore((s) => s.setChartColorIn3D);
  const chartSlice = useViewerStore((s) => s.chartSlice);
  const modelCount = useViewerStore((s) => s.models.size);

  // Seed the first dashboard so the panel opens with something to click.
  useEffect(() => { ensureActiveDashboard(); }, [dashboards, activeDashboardId]);

  const dashboard = useMemo(() => dashboards.find((d) => d.id === activeDashboardId) ?? null, [dashboards, activeDashboardId]);
  const scope = dashboard?.scope ?? { kind: 'all' as const };
  const datasets = useChartDatasets(scope);
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
  const setLayout = useCallback((layout: DashboardLayoutItem[]) => {
    if (dashboard) update({ ...dashboard, layout });
  }, [dashboard, update]);
  const chartIds = useMemo(() => dashboard?.charts.map((c) => c.id) ?? [], [dashboard]);
  const renderCard = useCallback((id: string) => {
    const spec = dashboard?.charts.find((c) => c.id === id);
    if (!spec) return null;
    return (
      <ChartCard
        spec={spec}
        dataset={datasets[spec.source]}
        link={link}
        renderer={renderer}
        onEdit={() => setEditing(spec)}
        onRemove={() => removeChart(spec.id)}
        onAggregation={onAggregation}
      />
    );
  }, [dashboard, datasets, link, renderer, removeChart, onAggregation]);

  const select = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5';

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-charts-panel>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-border">
        <BarChart3 className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
        <select
          className={select}
          value={activeDashboardId ?? ''}
          onChange={(e) => {
            // The preset entries create a new dashboard from a template.
            const preset = DASHBOARD_PRESETS.find((p) => `preset:${p.name}` === e.target.value);
            if (preset) {
              const created = preset.create();
              upsertDashboard(created);
              setActiveDashboardId(created.id);
            } else {
              setActiveDashboardId(e.target.value);
            }
          }}
          aria-label="Dashboard"
        >
          {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <optgroup label="New from preset">
            {DASHBOARD_PRESETS.map((p) => <option key={p.name} value={`preset:${p.name}`}>{p.name}</option>)}
          </optgroup>
        </select>
        <DashboardMenu dashboard={dashboard} onUpsert={upsertDashboard} onDelete={deleteDashboard} onActivate={setActiveDashboardId} />
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
          <ReportExportDialog dashboard={dashboard} aggregations={aggregations} onSaveReportSetup={upsertDashboard} seams={reportSeams} />
          {onClose && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose} aria-label="Close charts">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="border-b border-border bg-muted/20">
          <ChartEditor spec={editing} datasets={datasets} onSave={saveChart} onCancel={() => setEditing(null)} />
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
          <DashboardGrid layout={dashboard.layout} ids={chartIds} renderItem={renderCard} onLayoutChange={setLayout} />
        )}
      </div>
    </div>
  );
}
