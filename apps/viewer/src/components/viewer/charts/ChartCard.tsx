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
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { applyChartFilter, applyClashRuleFilter, chartElementFilterKey } from '@/lib/charts/source-filter';
import { countRows } from '@/lib/charts/row-noun';
import { readChartTheme, useEChart, type ChartRenderer, type ChartSelectEvent } from './useEChart';
import { GRID_DRAG_HANDLE_CLASS } from './DashboardGrid';
import { chartBucketIdentity, chartSelectionIsLive, sameChartBucketIdentity, type Chart3DLink } from './useChart3DLink';
import type { ChartSourceFilterState } from './useChartSourceFilters';

export interface ChartCardProps {
  spec: ChartSpec;
  dataset: ChartDataset;
  /** Resolution of `spec.filter`, from `useChartSourceFilters`; `undefined`
   *  when the chart has no filter, or a lookup hasn't landed yet. */
  filterState?: ChartSourceFilterState;
  link: Chart3DLink;
  renderer?: ChartRenderer;
  onEdit: () => void;
  onRemove: () => void;
  /** The card's aggregation, so the panel can drive the colour overlay from it. */
  onAggregation?: (spec: ChartSpec, aggregation: Aggregation | null) => void;
}

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "6 buckets · 15 elements · 2 without a value" — the card's subtitle; the
 *  row noun follows the source ("4 clashes"), see `countRows` (#5218). */
export function describeAggregation(aggregation: Aggregation): string {
  if (aggregation.categories.length === 0 && aggregation.unbucketed === 0) return 'No data';
  const total = aggregation.spec.measure.agg === 'count' ? countRows(aggregation.total, aggregation.spec.source) : `${aggregation.total.toLocaleString()} ${aggregation.unit ?? ''}`.trim();
  const rest = aggregation.unbucketed > 0 ? ` · ${aggregation.unbucketed} without a value` : '';
  const unmeasured = (aggregation.unmeasured ?? 0) > 0 ? ` · ${aggregation.unmeasured} without a measure` : '';
  const unsupported = (aggregation.unsupported ?? 0) > 0 ? ` · ${aggregation.unsupported} unsupported` : '';
  return `${plural(aggregation.categories.length, 'bucket')} · ${total}${rest}${unmeasured}${unsupported}`;
}

/**
 * The card's subtitle: the aggregation summary, with the filter's own state
 * folded in. A resolving or erred filter REPLACES the summary — the row
 * count underneath is of the empty placeholder dataset, not a real answer,
 * so showing it next to "Resolving filter…" would read as a contradiction.
 * An applied filter only APPENDS its selector text, since the summary above
 * it already reflects the narrowed rows. A `clashRule` filter (#5156)
 * appends the same way, by the rule's name when it is still known (the
 * clash result that named it may since have been cleared or re-run).
 */
function subtitleFor(spec: ChartSpec, aggregation: Aggregation | null, filterSelector: string | undefined, filterState: ChartSourceFilterState | undefined, clashRuleLabel: string | undefined): string {
  if (filterSelector) {
    if (filterState?.status === 'error') return filterState.message;
    if (filterState === undefined || filterState.status === 'resolving') return 'Resolving filter…';
  }
  if (!aggregation) return 'Cannot aggregate — edit the chart';
  const summary = describeAggregation(aggregation);
  const parts = [filterSelector ? `filter: ${filterSelector}` : null, clashRuleLabel ? `rule: ${clashRuleLabel}` : null].filter((p): p is string => p !== null);
  return parts.length > 0 ? `${summary} · ${parts.join(' · ')}` : summary;
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

export function ChartCard({ spec, dataset, filterState, link, renderer, onEdit, onRemove, onAggregation }: ChartCardProps) {
  const { t } = useTranslation();
  const chartSlice = useViewerStore((s) => s.chartSlice);
  const chartSliceSource = useViewerStore((s) => s.chartSliceSource);
  const chartSliceBuckets = useViewerStore((s) => s.chartSliceBuckets);
  const theme = useViewerStore((s) => s.theme);
  // Colours are kept by label across re-aggregations; the previous palette lives here.
  const paletteRef = useRef<PaletteAssignment | undefined>(undefined);

  // Trimmed-empty is treated as no filter, consistent with every other
  // reader of `spec.filter.selector` (`resolveChartFilter`, `validate.ts`
  // now also refuses it outright) — a malformed saved/imported dashboard
  // must not strand the card on "Resolving filter…" forever (review finding).
  const filterSelector = chartElementFilterKey(spec.filter) ? (spec.filter?.groups?.length ? `${spec.filter.groups.reduce((sum, group) => sum + group.rules.length, 0)} rules` : spec.filter?.selector) : undefined;
  // Only meaningful on `clash` — `validate.ts` refuses it on every other
  // source (#5156). A rule id is a value already on the dataset, so it needs
  // no async resolution the way a selector does.
  const clashRule = spec.source === 'clash' ? spec.filter?.clashRule : undefined;
  const clashRuleLabel = useViewerStore((s) => (clashRule ? s.clashResult?.rulesRun.find((r) => r.id === clashRule)?.name : undefined));
  // Resolving or erred: an EMPTY dataset, never the unfiltered rows under a
  // filter (#4946) — a card must not flash the whole model's numbers while
  // its filter is still running, or keep showing them after it fails.
  const filteredDataset = useMemo<ChartDataset>(() => {
    let result = dataset;
    if (filterSelector) {
      if (filterState?.status !== 'ok') return { ...dataset, rows: [] };
      result = applyChartFilter(result, filterState.ids);
    }
    if (clashRule) result = applyClashRuleFilter(result, clashRule);
    return result;
  }, [dataset, filterSelector, filterState, clashRule]);

  const aggregation = useMemo<Aggregation | null>(() => {
    try {
      const slice = chartSliceSource === spec.id ? null : chartSlice;
      const result = aggregate(spec, filteredDataset, { slice, palette: paletteRef.current });
      paletteRef.current = result.palette;
      return result;
    } catch (err) {
      console.warn(`[Charts] chart "${spec.title}" cannot aggregate`, err);
      return null;
    }
  }, [spec, filteredDataset, chartSlice, chartSliceSource]);

  useEffect(() => { onAggregation?.(spec, aggregation); }, [onAggregation, spec, aggregation]);

  useEffect(() => {
    if (
      aggregation
      && chartSliceSource === spec.id
      && chartSlice
      && chartSliceBuckets
      && !chartSelectionIsLive(aggregation, chartSliceBuckets, chartSlice)
    ) link.clearSelectionIfOwned(spec.id, chartSlice, chartSliceBuckets);
  }, [aggregation, chartSlice, chartSliceBuckets, chartSliceSource, link, spec.id]);

  const selection = useMemo(() => (aggregation ? link.selectionFor(aggregation) : { full: [], partial: [] }), [aggregation, link]);

  const option = useCallback((width: number) => {
    if (!aggregation) return null;
    // `theme` in the deps re-reads the stylesheet tokens on a light/dark switch.
    void theme;
    return buildEChartsOption({ aggregation, theme: readChartTheme(), selected: selection.full, width: width || undefined });
  }, [aggregation, selection.full, theme]);

  const onSelect = useCallback((event: ChartSelectEvent) => {
    if (!aggregation) return;
    if (event.items.length === 0) link.clearSelection();
    else link.selectItems(aggregation, event.items);
  }, [aggregation, link]);

  const canClearSelection = useCallback((item: { seriesIndex: number; dataIndex: number }) => {
    if (!aggregation || chartSliceSource !== spec.id) return false;
    const clicked = chartBucketIdentity(aggregation, item);
    return clicked !== null && (chartSliceBuckets ?? []).some((active) => sameChartBucketIdentity(active, clicked));
  }, [aggregation, chartSliceBuckets, chartSliceSource, spec.id]);

  const { ref } = useEChart({
    option,
    selected: selection.full,
    partial: selection.partial,
    onSelect,
    canClearSelection,
    renderer,
  });

  const frame = useCallback(() => {
    if (!aggregation) return;
    const items = selection.full.length > 0 ? selection.full : aggregation.categories.map((_, i) => ({ seriesIndex: 0, dataIndex: i }));
    link.frameItems(aggregation, items);
  }, [aggregation, selection.full, link]);

  const subtitle = subtitleFor(spec, aggregation, filterSelector, filterState, clashRuleLabel || clashRule);

  return (
    <div className="flex h-full flex-col min-h-0 rounded-md border border-border bg-card" data-chart-id={spec.id}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/60 text-xs">
        <div className={`min-w-0 flex-1 cursor-grab active:cursor-grabbing select-none ${GRID_DRAG_HANDLE_CLASS}`} title={t('chartCard.dragToMoveTitle')}>
          <div className="font-medium truncate" title={spec.title}>{spec.title}</div>
          <div className="text-2xs text-muted-foreground truncate" data-chart-subtitle>{subtitle}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title={t('chartCard.frameTitle')} onClick={frame} aria-label={t('chartCard.frameAriaLabel', { title: spec.title })}>
          <Crosshair className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title={t('chartCard.editChartTitle')} onClick={onEdit} aria-label={t('chartCard.editAriaLabel', { title: spec.title })}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title={t('chartCard.removeChartTitle')} onClick={onRemove} aria-label={t('chartCard.removeAriaLabel', { title: spec.title })}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative flex-1 min-h-[120px]">
        <div ref={ref} className="absolute inset-0" data-chart-host />
        {aggregation && aggregation.categories.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-muted-foreground" data-chart-empty>
            {filterSelector && filterState?.status !== 'ok'
              ? subtitle
              : filteredDataset.rows.length === 0
                ? filterSelector || clashRule
                  ? t('chartCard.noSourceFilterMatches')
                  : EMPTY_HINTS[spec.source]
                : t('chartCard.nothingToBucket')}
          </div>
        )}
      </div>
      {aggregation && (
        // A screen-reader / test-visible legend: one row per bucket, clickable like the bars.
        <ul className="sr-only" data-chart-legend>
          {aggregation.categories.map((bucket, index) => (
            <li key={`${bucket.key}:${'isOther' in bucket && bucket.isOther === true ? 'other' : 'value'}`}>
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
