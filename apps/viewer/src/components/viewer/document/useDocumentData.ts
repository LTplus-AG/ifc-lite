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
import { aggregate, type Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import type { BindingContext } from '@/lib/document/bindings';
import type { DocumentSpec } from '@/lib/document/types';
import { useChartDatasets } from '../charts/useChartDatasets';

export interface DocumentData {
  bindings: BindingContext;
  aggregations: Map<string, Aggregation | null>;
  topics: Map<string, BCFTopic>;
}

const ALL_SCOPE = { kind: 'all' as const };

export function useDocumentData(document: DocumentSpec | null): DocumentData {
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const bcfProject = useViewerStore((s) => s.bcfProject);
  const datasets = useChartDatasets(ALL_SCOPE);

  const bindings = useMemo<BindingContext>(() => {
    const bound: Array<BindingContext['models'][number]> = [];
    for (const m of models.values()) if (m.ifcDataStore) bound.push({ id: m.id, name: m.name, store: m.ifcDataStore });
    return { models: bound, activeModelId, today: new Date() };
  }, [models, activeModelId]);

  const aggregations = useMemo(() => {
    const out = new Map<string, Aggregation | null>();
    for (const block of document?.blocks ?? []) {
      if (block.kind !== 'chart') continue;
      try {
        out.set(block.id, aggregate(block.chart, datasets[block.chart.source]));
      } catch (err) {
        console.warn(`[Documents] chart "${block.chart.title}" cannot aggregate`, err);
        out.set(block.id, null);
      }
    }
    return out;
  }, [document, datasets]);

  const topics = useMemo(() => bcfProject?.topics ?? new Map<string, BCFTopic>(), [bcfProject]);

  return { bindings, aggregations, topics };
}
