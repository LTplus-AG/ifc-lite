/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One chart on the dashboard: title bar, the ECharts host, and the three
 * things a card can do — select buckets in 3D, frame them, be edited /
 * removed. The aggregation is the card's, computed over the dashboard's
 * dataset and the cross-chart slice (a chart never filters itself).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Crosshair, Pencil, X } from 'lucide-react';
import { aggregate, buildEChartsOption, type Aggregation, type ChartDataset, type ChartSpec, type PaletteAssignment } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { readChartTheme, useEChart, type ChartRenderer, type ChartSelectEvent } from './useEChart';
import type { Chart3DLink } from './useChart3DLink';

export interface ChartCardProps {
  spec: ChartSpec;
  dataset: ChartDataset;
  link: Chart3DLink;
  renderer?: ChartRenderer;
  onEdit: () => void;
  onRemove: () => void;
  /** The card's aggregation, so the panel can drive the colour overlay from it. */
  onAggregation?: (spec: ChartSpec, aggregation: Aggregation | null) => void;
}

export function ChartCard({ spec, dataset, link, renderer, onEdit, onRemove, onAggregation }: ChartCardProps) {
  const chartSlice = useViewerStore((s) => s.chartSlice);
  const chartSliceSource = useViewerStore((s) => s.chartSliceSource);
  const theme = useViewerStore((s) => s.theme);
  // Colours are kept by label across re-aggregations; the previous palette lives here.
  const paletteRef = useRef<PaletteAssignment | undefined>(undefined);

  const aggregation = useMemo<Aggregation | null>(() => {
    try {
      const slice = chartSliceSource === spec.id ? null : chartSlice;
      const result = aggregate(spec, dataset, { slice, palette: paletteRef.current });
      paletteRef.current = result.palette;
      return result;
    } catch (err) {
      console.warn(`[Charts] chart "${spec.title}" cannot aggregate`, err);
      return null;
    }
  }, [spec, dataset, chartSlice, chartSliceSource]);

  useEffect(() => { onAggregation?.(spec, aggregation); }, [onAggregation, spec, aggregation]);

  const selection = useMemo(() => (aggregation ? link.selectionFor(aggregation) : { full: [], partial: [] }), [aggregation, link]);

  const option = useMemo(() => {
    if (!aggregation) return null;
    // `theme` in the deps re-reads the stylesheet tokens on a light/dark switch.
    void theme;
    return buildEChartsOption({ aggregation, theme: readChartTheme(), selected: selection.full });
  }, [aggregation, selection.full, theme]);

  const onSelect = useCallback((event: ChartSelectEvent) => {
    if (!aggregation) return;
    if (event.dataIndices.length === 0) link.clearSelection();
    else link.selectCategories(aggregation, event.dataIndices);
  }, [aggregation, link]);

  const { ref } = useEChart({ option, selected: selection.full, onSelect, renderer });

  const frame = useCallback(() => {
    if (!aggregation) return;
    const indices = selection.full.length > 0 ? selection.full : aggregation.categories.map((_, i) => i);
    link.frameCategories(aggregation, indices);
  }, [aggregation, selection.full, link]);

  const subtitle = aggregation
    ? `${aggregation.categories.length} bucket${aggregation.categories.length === 1 ? '' : 's'} · ${aggregation.total.toLocaleString()} ${aggregation.spec.measure.agg === 'count' ? 'elements' : (aggregation.unit ?? '')}${aggregation.unbucketed > 0 ? ` · ${aggregation.unbucketed} without a value` : ''}`
    : 'Cannot aggregate — edit the chart';

  return (
    <div className="flex flex-col min-h-0 rounded-md border border-border bg-card" data-chart-id={spec.id}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/60 text-xs">
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate" title={spec.title}>{spec.title}</div>
          <div className="text-[10px] text-muted-foreground truncate" data-chart-subtitle>{subtitle}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Frame the selected buckets (or the whole chart) in 3D" onClick={frame} aria-label={`Frame ${spec.title}`}>
          <Crosshair className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Edit chart" onClick={onEdit} aria-label={`Edit ${spec.title}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Remove chart" onClick={onRemove} aria-label={`Remove ${spec.title}`}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div ref={ref} className="flex-1 min-h-[160px]" data-chart-host />
      {aggregation && (
        // A screen-reader / test-visible legend: one row per bucket, clickable like the bars.
        <ul className="sr-only" data-chart-legend>
          {aggregation.categories.map((bucket, index) => (
            <li key={bucket.key}>
              <button type="button" onClick={() => link.selectCategories(aggregation, [index])}>
                {bucket.label}: {bucket.value}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
