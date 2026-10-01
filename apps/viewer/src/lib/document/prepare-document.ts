/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { toGlobalIdFromModels } from '@/store/globalId';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '../model-tags/evaluator-models';
import { prepareListProviders } from '../lists/prepare-providers';
import { chartElementFields } from '../charts/chart-fields';
import { chartElementFilterKey, resolveChartFilter } from '../charts/source-filter';
import { buildElementsDataset } from '../charts/datasets/elements';
import { buildClashDataset } from '../charts/datasets/clash';
import { buildBcfDataset } from '../charts/datasets/bcf';
import { buildScheduleDataset } from '../charts/datasets/schedule';
import { buildIdsDataset } from '../charts/datasets/ids';
import { buildCompareDataset } from '../charts/datasets/compare';
import { largestBucketIds } from '../charts/buckets';
import { prepareDocumentCharts, type DocumentChartFilterState } from './prepare-charts';
import { prepareListTable } from './prepare-list-table';
import { listFingerprint } from './list-fingerprint';
import { resolveComparisonTableState } from './resolve-comparison-table';
import { resolveValidationTableState } from './resolve-validation-table';
import type { TableState } from './resolve-table';
import type { DocumentSpec } from './types';
import type { DocumentPdfInput } from './generate-document-pdf';

/** Await every native list/filter before exporting; no UI result slots are mutated. */
export async function prepareDocument(document: DocumentSpec, state: ViewerState,
  options: { signal?: AbortSignal; today?: Date } = {},
): Promise<DocumentPdfInput> {
  const { signal } = options;
  signal?.throwIfAborted();
  const today = options.today ?? new Date();
  const charts = document.blocks.flatMap((block) => block.kind === 'chart' ? [block.chart] : []);
  const datasets = {
    elements: buildElementsDataset({ kind: 'all' }, chartElementFields(charts), state),
    clash: buildClashDataset(state), bcf: buildBcfDataset(state), schedule: buildScheduleDataset(state),
    ids: buildIdsDataset(state), compare: buildCompareDataset(state),
  };
  const filters = new Map<string, DocumentChartFilterState>();
  let limit = 0;
  for (const model of state.models.values()) limit += (model.maxExpressId ?? 0) + 1;
  for (const chart of charts) {
    const key = chartElementFilterKey(chart.filter);
    if (!key || filters.has(key)) continue;
    try {
      const ids = await resolveChartFilter(evaluatorModelsFromState(state), chart.filter,
        (modelId, expressId) => toGlobalIdFromModels(state.models, modelId, expressId), {
          signal, limit, definedModelTagIds: definedModelTagIdsOf(state),
          schemaVersion: state.models.get(state.activeModelId ?? '')?.ifcDataStore?.schemaVersion,
        });
      signal?.throwIfAborted();
      filters.set(key, { status: 'ok', ids: ids ?? new Set() });
    } catch (error) {
      signal?.throwIfAborted();
      filters.set(key, { status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  const { aggregations, chartMessages, chartErrors } = prepareDocumentCharts(document, datasets, filters, state.savedComparisons);
  const tables = new Map<string, TableState>();
  const providers = document.blocks.some((block) => block.kind === 'table' && block.source.kind === 'list')
    ? prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult)) : null;
  const listResults = new Map<string, TableState>();
  for (const block of document.blocks) {
    signal?.throwIfAborted();
    if (block.kind !== 'table') continue;
    if (block.source.kind === 'comparison') tables.set(block.id, resolveComparisonTableState(block.source.comparison));
    else if (block.source.kind === 'validation') tables.set(block.id, resolveValidationTableState(block.source,
      state.idsValidationReport, (modelId) => state.models.get(modelId)?.name ?? modelId));
    else if (!providers?.hasData) tables.set(block.id, { status: 'no-model' });
    else {
      const key = listFingerprint(block.source.list);
      let result = listResults.get(key);
      if (!result) {
        try { result = await prepareListTable(block.source.list, providers.pairs, providers.modelUnits, state, { signal, today }); }
        catch (error) {
          signal?.throwIfAborted();
          result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
        }
        listResults.set(key, result);
      }
      tables.set(block.id, result);
    }
  }
  signal?.throwIfAborted();
  return { document, bindings: { models: [...state.models.values()].flatMap((model) => model.ifcDataStore
    ? [{ id: model.id, name: model.name, store: model.ifcDataStore, view: state.mutationViews.get(model.id) }] : []),
    activeModelId: state.activeModelId, today }, aggregations, chartMessages, chartErrors,
    tables, topics: state.bcfProject?.topics ?? new Map(),
    snapshotIds: (blockId) => largestBucketIds(aggregations.get(blockId)),
  };
}
