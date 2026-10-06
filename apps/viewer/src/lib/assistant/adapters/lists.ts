/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue, ColumnDefinition, ListResult } from '@ifc-lite/lists';
import { extractProjectUnits, ProjectUnits } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import type { ViewerState } from '@/store';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { resolveListColumnUnits } from '@/lib/units/list-column-units';
import { listRunDefinition } from '@/lib/lists/run-provenance';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const GROUP_LIMIT = 50;
const TEXT = 200;

const bounded = (value: CellValue): CellValue => typeof value === 'string' && value.length > TEXT ? `${value.slice(0, TEXT)}…` : value;

/** The data store a list row's `modelId` names; `default` is the legacy single-model path (`prepareListProviders`). */
function storeFor(state: ViewerState, modelId: string) {
  return state.models.get(modelId)?.ifcDataStore ?? (modelId === 'default' && state.models.size === 0 ? state.ifcDataStore : null);
}

/** Each contributing model's declared units, read the way `prepareListProviders` reads them. */
function modelUnitsOf(state: ViewerState, result: ListResult): Map<string, ProjectUnits> {
  const units = new Map<string, ProjectUnits>();
  for (const row of result.rows) {
    if (units.has(row.modelId)) continue;
    const store = storeFor(state, row.modelId);
    units.set(row.modelId, store && store.source.length > 0 ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty());
  }
  return units;
}

function columnEvidence(columns: ColumnDefinition[], units: Map<string, ProjectUnits>) {
  // No display overrides: values below are as the source files declare them.
  const resolver = resolveListColumnUnits(columns, units, {});
  return columns.map((column, index) => {
    const unitsByModel = Object.fromEntries([...units.keys()].map(modelId => [modelId, resolver.sourceUnitSymbol(index, modelId)]));
    const distinct = new Set(Object.values(unitsByModel));
    const measure = column.quantityType !== undefined || column.dataType !== undefined;
    return {
      id: column.id, label: column.label ?? column.propertyName, source: column.source,
      psetName: column.psetName ?? null, propertyName: column.propertyName,
      quantityKind: column.quantityType !== undefined ? QuantityType[column.quantityType] ?? null : null,
      dataType: column.dataType ?? null,
      // One unit only when every contributing model declares the same one.
      unit: measure && distinct.size === 1 ? [...distinct][0] : null,
      unitsByModel: measure ? unitsByModel : null,
      mixedSourceUnits: measure && distinct.size > 1,
    };
  });
}

/** The stored Lists result (`listResult`), stamped when its run started. */
export const listsAdapter: EvidenceAdapter = {
  id: 'lists', group: 'quantities', panelIds: ['lists'],
  titleKey: 'lists.panel.title', descriptionKey: 'assistantSources.lists.description',
  rowMeaningKey: 'assistantSources.lists.rows', unavailableKey: 'assistantSources.lists.unavailable',
  suggestionKeys: ['assistantSources.lists.suggestSummary', 'assistantSources.lists.suggestGaps'],
  readiness: s => s.listExecuting ? { status: { labelKey: 'assistantSources.lists.running' }, ready: false, running: true }
    : s.listResult ? { status: { labelKey: 'assistantSources.lists.ready', params: { count: s.listResult.totalCount } }, ready: true }
      : { status: { labelKey: 'assistantSources.lists.notRun' }, ready: false },
  identity: s => s.listResult,
  reportStamp: s => analysisStampOf(s.listResult),
  capture: (s, limit) => {
    const result = s.listResult;
    if (!result) return unavailableCapture();
    const definition = listRunDefinition(result);
    const units = modelUnitsOf(s, result);
    const columns = columnEvidence(result.columns, units);
    const mixed = new Set(columns.filter(column => column.mixedSourceUnits).map(column => column.id));
    // Native sums are raw source values; a sum over models declaring different units is withheld, never reported.
    const sums = (raw: Record<string, number>) => Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, mixed.has(id) ? null : value]));
    const groups = result.groups ?? null;
    return {
      summary: {
        kind: 'list-result',
        definitionId: definition?.id ?? null, definitionName: definition?.name ?? null,
        definitionProvenance: definition ? 'executed-definition' : 'unknown',
        columns, totalCount: result.totalCount, modelCount: units.size,
        executionTimeMs: Math.round(result.executionTime),
        grouping: definition?.grouping ? { columnIds: definition.grouping.columnIds ?? [definition.grouping.columnId], sumColumnIds: definition.grouping.sumColumnIds } : null,
        nativeSummary: result.summary ? { count: result.summary.count, sums: sums(result.summary.sums) } : null,
        nativeGroups: groups ? groups.slice(0, GROUP_LIMIT).map(group => ({ label: bounded(group.label), path: group.path ?? null, level: group.level ?? 0, count: group.count, sums: sums(group.sums) })) : null,
        groupCount: groups?.length ?? 0, groupsTruncated: (groups?.length ?? 0) > GROUP_LIMIT,
        sumsWithheldForMixedUnits: [...mixed].filter(id => result.summary && id in result.summary.sums),
        limitations: 'Values are as the source files declare them (columns[].unit / unitsByModel), not converted to display-unit overrides. Native sums cover only the configured sum columns; a sum over models with different declared units is withheld (null). Rows are the list as executed at its run stamp; they do not establish anything outside the list scope, filters, or columns.',
      },
      totalRows: result.rows.length,
      availability: 'available',
      rows: result.rows.slice(0, limit).map(row => evidenceRow({
        kind: 'list-row', modelId: row.modelId, expressId: row.entityId,
        globalId: resolveEntityRefGlobalIdFromState(s, { modelId: row.modelId, expressId: row.entityId }),
      }, { values: Object.fromEntries(result.columns.map((column, index) => [column.id, bounded(row.values[index] ?? null)])) })),
    };
  },
};
