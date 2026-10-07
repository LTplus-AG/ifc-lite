/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { aggregate, type Aggregation, type ChartDataset, type ChartSource } from '@ifc-lite/charts';
import type { DocumentSpec } from './types';
import { applyChartFilter, applyClashRuleFilter, chartElementFilterKey } from '../charts/source-filter';
import { NO_SAVED_CHART_CONTENT, resolveChartSource, type ChartSourceContext } from '../charts/chart-source';
import { chartSourceMessage } from '../charts/chart-source-message';
import { withoutBuckets } from '../charts/unavailable-aggregation';
import { resolve } from '@/i18n/registry';

export type DocumentChartFilterState =
  | { status: 'resolving' }
  | { status: 'ok'; ids: ReadonlySet<number> }
  | { status: 'error'; message: string };

/** Same aggregation and refusal messages for subscribed preview and awaited automation. */
export function prepareDocumentCharts(document: DocumentSpec | null,
  datasets: Record<ChartSource, ChartDataset>,
  sourceFilters: ReadonlyMap<string, DocumentChartFilterState>,
  savedContent: ChartSourceContext = NO_SAVED_CHART_CONTENT,
): { aggregations: Map<string, Aggregation | null>; chartMessages: Map<string, string>; chartErrors?: ReadonlySet<string> } {
    const aggs = new Map<string, Aggregation | null>();
    const messages = new Map<string, string>();
    const errors = new Set<string>();
    for (const block of document?.blocks ?? []) {
      if (block.kind !== 'chart') continue;
      const spec = block.chart;
      try {
        // Trimmed-empty is no filter, consistent with ChartCard (review finding).
        const filterKey = chartElementFilterKey(spec.filter);
        const filterState = filterKey ? sourceFilters.get(filterKey) : undefined;
        const source = resolveChartSource(spec, datasets[spec.source], savedContent);
        const sourceMessage = chartSourceMessage(source, resolve);
        if (sourceMessage) {
          messages.set(block.id, sourceMessage);
          if (source.status === 'missing') errors.add(block.id);
        }
        const baseDataset = source.dataset;
        // Never the unfiltered rows under a filter (#4946): resolving/erred
        // prints an EMPTY dataset, same as the dashboard card — but unlike
        // the card (which reads the status straight off the hook) the
        // preview/PDF only ever see an `Aggregation`, so the REASON has to
        // travel separately or a broken filter prints identically to one
        // that legitimately matched nothing (review finding on PR #4984).
        let dataset = baseDataset;
        if (filterKey) {
          if (filterState?.status === 'ok') dataset = applyChartFilter(baseDataset, filterState.ids);
          else {
            dataset = { ...baseDataset, rows: [] };
            messages.set(block.id, filterState?.status === 'error' ? filterState.message : 'Resolving filter…');
            errors.add(block.id);
          }
        }
        // A clash rule filter (#5156) is a plain row-value match, so it
        // applies on top regardless of whether a selector was also resolving
        // or erred — an erred selector already emptied `dataset`, so this is
        // a no-op in that case.
        if (spec.source === 'clash' && spec.filter?.clashRule) dataset = applyClashRuleFilter(dataset, spec.filter.clashRule);
        const aggregation = aggregate(spec, dataset);
        aggs.set(block.id, source.status === 'missing' ? withoutBuckets(aggregation) : aggregation);
      } catch (err) {
        console.warn(`[Documents] chart "${block.chart.title}" cannot aggregate`, err);
        messages.set(block.id, err instanceof Error ? err.message : String(err));
        errors.add(block.id);
        aggs.set(block.id, null);
      }
    }
  return { aggregations: aggs, chartMessages: messages, chartErrors: errors };
}
