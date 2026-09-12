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
import { aggregate, buildEChartsOption, type Aggregation, type ChartDataset, type ChartSource, type ChartSpec, type PaletteAssignment } from '@ifc-lite/charts';
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

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "6 buckets · 15 elements · 2 without a value" — the card's subtitle. */
export function describeAggregation(aggregation: Aggregation): string {
  if (aggregation.categories.length === 0 && aggregation.unbucketed === 0) return 'No data';
  const total = aggregation.spec.measure.agg === 'count' ? plural(aggregation.total, 'element') : `${aggregation.total.toLocaleString()} ${aggregation.unit ?? ''}`.trim();
  const rest = aggregation.unbucketed > 0 ? ` · ${aggregation.unbucketed} without a value` : '';
  return `${plural(aggregation.categories.length, 'bucket')} · ${total}${rest}`;
}

/** What fills an empty chart, per source — where the data comes from, in the app's own words. */
export const EMPTY_HINTS: Record<ChartSource, string> = {
  elements: 'No elements in scope.',
  clash: 'No clash results yet — run a clash check (Analyze › Clash).',
  bcf: 'No BCF topics — open or create topics (Analyze › BCF topics).',
  schedule: 'No schedule — load one on the Schedule panel.',
  ids: 'No IDS results yet — run an IDS check (Analyze › IDS check).',
  compare: 'No comparison yet — compare two models (Analyze › Compare).',
};

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
    if (event.items.length === 0) link.clearSelection();
    else link.selectItems(aggregation, event.items);
  }, [aggregation, link]);

  const { ref } = useEChart({ option, selected: selection.full, partial: selection.partial, onSelect, renderer });

  const frame = useCallback(() => {
    if (!aggregation) return;
    const items = selection.full.length > 0 ? selection.full : aggregation.categories.map((_, i) => ({ seriesIndex: 0, dataIndex: i }));
    link.frameItems(aggregation, items);
  }, [aggregation, selection.full, link]);

  const subtitle = aggregation ? describeAggregation(aggregation) : 'Cannot aggregate — edit the chart';

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
      <div className="relative flex-1 min-h-[160px]">
        <div ref={ref} className="absolute inset-0" data-chart-host />
        {aggregation && aggregation.categories.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-muted-foreground" data-chart-empty>
            {dataset.rows.length === 0 ? EMPTY_HINTS[spec.source] : 'Nothing to bucket — every row is without a value for this dimension.'}
          </div>
        )}
      </div>
      {aggregation && (
        // A screen-reader / test-visible legend: one row per bucket, clickable like the bars.
        <ul className="sr-only" data-chart-legend>
          {aggregation.categories.map((bucket, index) => (
            <li key={bucket.key}>
              <button type="button" onClick={() => link.selectItems(aggregation, [{ seriesIndex: 0, dataIndex: index }])}>
                {bucket.label}: {bucket.value}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
