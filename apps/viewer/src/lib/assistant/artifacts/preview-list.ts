/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List review: the definition runs through `runListFederated`, the path the
 * Lists panel and document tables use, and every numeric column is converted
 * through `resolveListColumnUnits`, the resolver the Lists table sums with.
 * A measure states its total, how many rows carry a value and how many rows
 * there are, so "summed over 4 of 7 rows" is read off the engine's own output.
 */

import type { CellValue, ColumnDefinition } from '@ifc-lite/lists';
import type { CapturedEntityScope } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { resolveListColumnUnits } from '@/lib/units/list-column-units';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { toListDefinition, type ListProposal } from './list-proposal';
import { populationOf, revisionOf, SAMPLE_LIMIT, type ArtifactPreview, type MeasureSummary } from './preview-shared';

export const columnLabel = (column: ColumnDefinition): string =>
  column.label ?? (column.source === 'property' || column.source === 'quantity' ? `${column.psetName}.${column.propertyName}` : column.propertyName || column.source);

function cellText(value: CellValue, unit: string | null): string {
  if (value === null || value === '') return '—';
  if (typeof value === 'number') return `${Number(value.toPrecision(6))}${unit ? ` ${unit}` : ''}`;
  return String(value);
}

export async function previewList(proposal: ListProposal, state: ViewerState, signal?: AbortSignal, capturedScope?: CapturedEntityScope): Promise<ArtifactPreview> {
  const definition = { ...toListDefinition(proposal.list, crypto.randomUUID(), Date.now()), ...(capturedScope ? { capturedScope } : {}) };
  const { pairs, modelUnits } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
  const result = await runListFederated(definition, pairs, state, { evaluatorModels: evaluatorModelsFromState(state), signal });
  const units = resolveListColumnUnits(result.columns, modelUnits, state.unitDisplayOverrides);
  const measures: MeasureSummary[] = [];
  result.columns.forEach((column, index) => {
    if (column.source !== 'property' && column.source !== 'quantity') return;
    let measured = 0;
    let total = 0;
    for (const row of result.rows) {
      const value = units.convertCell(index, row.values[index], row.modelId);
      if (typeof value === 'number' && Number.isFinite(value)) { measured += 1; total += value; }
    }
    // A text property has nothing to sum; a quantity always states its denominator, even when no row carries it.
    if (measured > 0 || column.source === 'quantity') {
      measures.push({ label: columnLabel(column), unit: units.unitSymbol(index), total, measured, rows: result.rows.length });
    }
  });
  const providers = new Map(pairs.map((pair) => [pair.modelId, pair.provider] as const));
  const modelName = (modelId: string) => state.models.get(modelId)?.name ?? modelId;
  return {
    kind: 'list.proposal', matched: result.rows.length, population: populationOf(result.rows, state),
    sampleColumns: result.columns.map(columnLabel),
    samples: result.rows.slice(0, SAMPLE_LIMIT).map((row) => {
      const provider = providers.get(row.modelId);
      return { model: modelName(row.modelId), ifcClass: provider?.getEntityTypeName(row.entityId) ?? '', name: provider?.getEntityName(row.entityId) ?? '',
        globalId: provider?.getEntityGlobalId(row.entityId) ?? '',
        values: row.values.map((value, index) => cellText(units.convertCell(index, value, row.modelId), units.unitSymbol(index))) };
    }),
    measures, buckets: [], artifact: { kind: 'list.proposal', definition }, revision: revisionOf(state),
  };
}
