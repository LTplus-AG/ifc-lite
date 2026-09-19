/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a document needs from the live store (#4594): the binding context
 * its text resolves against, the aggregation of each chart block, and the
 * BCF topics by GUID. The preview and the PDF export read the same values,
 * so what is on screen is what prints.
 */
import { useMemo } from 'react';
import { trimSelectorWhitespace } from '@ifc-lite/query';
import { aggregate, type Aggregation, type ChartSpec } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentSpec } from '@/lib/document/types';
import { applyChartFilter } from '@/lib/charts/source-filter';
import { useChartDatasets } from '../charts/useChartDatasets';
import { useChartSourceFilters } from '../charts/useChartSourceFilters';

export interface DocumentData {
  bindings: BindingContext;
  aggregations: Map<string, Aggregation | null>;
  /** Set for a chart block whose `filter` is still resolving or was refused
   *  (#4946): the preview and the PDF export must tell that apart from a
   *  selector that legitimately matched nothing — both print an empty
   *  `Aggregation`, so the message is the only thing that distinguishes them. */
  chartMessages: Map<string, string>;
  topics: Map<string, BCFTopic>;
}

const ALL_SCOPE = { kind: 'all' as const };

export function useDocumentData(document: DocumentSpec | null): DocumentData {
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const bcfProject = useViewerStore((s) => s.bcfProject);
  const datasets = useChartDatasets(ALL_SCOPE);
  // Same resolution hook the Charts panel uses (#4946), so a document chart
  // block prints the SAME filtered numbers the dashboard card shows — never
  // a second, possibly-stale reading of the same selector.
  const charts = useMemo<ChartSpec[]>(() => (document?.blocks ?? []).flatMap((b) => (b.kind === 'chart' ? [b.chart] : [])), [document]);
  const sourceFilters = useChartSourceFilters(charts);

  const bindings = useMemo<BindingContext>(() => {
    const bound: Array<BindingContext['models'][number]> = [];
    for (const m of models.values()) if (m.ifcDataStore) bound.push({ id: m.id, name: m.name, store: m.ifcDataStore });
    return { models: bound, activeModelId, today: new Date() };
  }, [models, activeModelId]);

  const { aggregations, chartMessages } = useMemo(() => {
    const aggs = new Map<string, Aggregation | null>();
    const messages = new Map<string, string>();
    for (const block of document?.blocks ?? []) {
      if (block.kind !== 'chart') continue;
      const spec = block.chart;
      try {
        // Trimmed-empty is no filter, consistent with ChartCard (review finding).
        const filterText = spec.filter && trimSelectorWhitespace(spec.filter.selector).length > 0 ? spec.filter.selector : undefined;
        const filterState = filterText ? sourceFilters.get(filterText) : undefined;
        const baseDataset = datasets[spec.source];
        // Never the unfiltered rows under a filter (#4946): resolving/erred
        // prints an EMPTY dataset, same as the dashboard card — but unlike
        // the card (which reads the status straight off the hook) the
        // preview/PDF only ever see an `Aggregation`, so the REASON has to
        // travel separately or a broken filter prints identically to one
        // that legitimately matched nothing (review finding on PR #4984).
        let dataset = baseDataset;
        if (filterText) {
          if (filterState?.status === 'ok') dataset = applyChartFilter(baseDataset, filterState.ids);
          else {
            dataset = { ...baseDataset, rows: [] };
            messages.set(block.id, filterState?.status === 'error' ? filterState.message : 'Resolving filter…');
          }
        }
        aggs.set(block.id, aggregate(spec, dataset));
      } catch (err) {
        console.warn(`[Documents] chart "${block.chart.title}" cannot aggregate`, err);
        aggs.set(block.id, null);
      }
    }
    return { aggregations: aggs, chartMessages: messages };
  }, [document, datasets, sourceFilters]);

  const topics = useMemo(() => bcfProject?.topics ?? new Map<string, BCFTopic>(), [bcfProject]);

  return { bindings, aggregations, chartMessages, topics };
}
