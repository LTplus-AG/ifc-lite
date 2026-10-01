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
import { type Aggregation, type ChartSpec } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentSpec } from '@/lib/document/types';
import { prepareDocumentCharts } from '@/lib/document/prepare-charts';
import { chartElementFields } from '@/lib/charts/chart-fields';
import type { TableState } from '@/lib/document/resolve-table';
import { useChartDatasets } from '../charts/useChartDatasets';
import { useChartSourceFilters } from '../charts/useChartSourceFilters';
import { useDocumentTables } from './useDocumentTables';

export interface DocumentData {
  bindings: BindingContext;
  aggregations: Map<string, Aggregation | null>;
  /** Set for a chart block whose `filter` is still resolving or was refused
   *  (#4946): the preview and the PDF export must tell that apart from a
   *  selector that legitimately matched nothing — both print an empty
   *  `Aggregation`, so the message is the only thing that distinguishes them. */
  chartMessages: Map<string, string>;
  topics: Map<string, BCFTopic>;
  /** Table block id → its list run (#5142); preview and PDF print the same rows. */
  tables: ReadonlyMap<string, TableState>;
}

const ALL_SCOPE = { kind: 'all' as const };

export function useDocumentData(document: DocumentSpec | null): DocumentData {
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const bcfProject = useViewerStore((s) => s.bcfProject);
  // Same resolution hook the Charts panel uses (#4946), so a document chart
  // block prints the SAME filtered numbers the dashboard card shows — never
  // a second, possibly-stale reading of the same selector.
  const charts = useMemo<ChartSpec[]>(() => (document?.blocks ?? []).flatMap((b) => (b.kind === 'chart' ? [b.chart] : [])), [document]);
  const elementFields = useMemo(() => chartElementFields(charts), [charts]);
  const datasets = useChartDatasets(ALL_SCOPE, elementFields);
  const sourceFilters = useChartSourceFilters(charts);

  const bindings = useMemo<BindingContext>(() => {
    const bound: Array<BindingContext['models'][number]> = [];
    for (const m of models.values()) if (m.ifcDataStore) bound.push({ id: m.id, name: m.name, store: m.ifcDataStore, view: mutationViews.get(m.id) });
    return { models: bound, activeModelId, today: new Date() };
  }, [models, activeModelId, mutationViews, mutationVersion]);

  const { aggregations, chartMessages } = useMemo(() => {
    return prepareDocumentCharts(document, datasets, sourceFilters);
  }, [document, datasets, sourceFilters]);

  const topics = useMemo(() => bcfProject?.topics ?? new Map<string, BCFTopic>(), [bcfProject]);
  const tables = useDocumentTables(document);

  return { bindings, aggregations, chartMessages, topics, tables };
}
