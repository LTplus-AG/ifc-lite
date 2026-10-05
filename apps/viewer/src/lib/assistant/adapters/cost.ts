/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CostBackendMethods, CostEvaluationData, CostGraphData } from '@ifc-lite/sdk';
import { useViewerStore, type ViewerState } from '@/store';
import { createCostAdapter } from '@/sdk/adapters/cost-adapter';
import { getAllModelEntries } from '@/sdk/adapters/model-compat';
import { readCostModels } from '@/lib/cost/cost-models';
import { buildCostTree, classifyCostModel, refKey } from '@/lib/cost/cost-tree';
import { addDecimalStrings } from '@/lib/cost/decimal-sum';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const MESSAGE = 240;
let backend: CostBackendMethods | null = null;
/** One `bim.cost` backend (and its unmutated-graph cache), as the Cost panel holds one. */
const costBackend = (): CostBackendMethods => (backend ??= createCostAdapter(useViewerStore));

const hasSource = (s: ViewerState): boolean =>
  getAllModelEntries(s).some(([, model]) => (model.ifcDataStore?.source?.byteLength ?? 0) > 0);

/** Items not nested under another item: the cost tree's schedule roots and unassigned roots. */
function rootKeys(graph: CostGraphData): Set<string> {
  const tree = buildCostTree(graph);
  return new Set([...tree.schedules.flatMap(schedule => schedule.items), ...tree.unassignedItems].map(node => refKey(node.ref)));
}

interface Total { currency: string | null; dimension: string | null; rootTotal: string | null; rootItemsWithAmount: number; itemsWithAmount: number }

/** Per (currency, dimension) bucket; amounts in different currencies or dimensions are never added. */
function addTotal(totals: Map<string, Total>, evaluation: CostEvaluationData, root: boolean): void {
  if (evaluation.Amount === undefined) return;
  const key = `${evaluation.Currency ?? ''}\u0000${evaluation.Dimension ?? ''}`;
  const total = totals.get(key) ?? { currency: evaluation.Currency ?? null, dimension: evaluation.Dimension ?? null, rootTotal: null, rootItemsWithAmount: 0, itemsWithAmount: 0 };
  total.itemsWithAmount += 1;
  if (root) {
    total.rootItemsWithAmount += 1;
    total.rootTotal = total.rootTotal === null ? evaluation.Amount : addDecimalStrings(total.rootTotal, evaluation.Amount);
  }
  totals.set(key, total);
}

/** Every loaded model's IfcCostItem graph, evaluated by the same `bim.cost` backend as the Cost panel and its CSV. */
export const costAdapter: EvidenceAdapter = {
  id: 'cost', group: 'quantities', panelIds: ['cost'],
  titleKey: 'costPanel.title', descriptionKey: 'assistantSources.cost.description',
  rowMeaningKey: 'assistantSources.cost.rows', unavailableKey: 'assistantSources.cost.unavailable',
  suggestionKeys: ['assistantSources.cost.suggestSummary', 'assistantSources.cost.suggestGaps'],
  readiness: s => {
    const count = getAllModelEntries(s).filter(([, model]) => (model.ifcDataStore?.source?.byteLength ?? 0) > 0).length;
    return count > 0 ? { status: { labelKey: 'assistantSources.cost.ready', params: { count } }, ready: true }
      : { status: { labelKey: 'assistantSources.cost.noSource' }, ready: false };
  },
  // Live: re-read on every edit (the context stamp covers mutationVersion).
  identity: s => [s.models, s.ifcDataStore],
  capture: (s, limit) => {
    if (!hasSource(s)) return unavailableCapture();
    const methods = costBackend();
    const entries = readCostModels(s, methods);
    if (!entries.some(entry => entry.graph)) return unavailableCapture({ models: entries.map(entry => ({ modelId: entry.modelId, status: 'no-cost-source', error: entry.error ?? null })) });
    const rows: unknown[] = [];
    let totalRows = 0;
    const models = entries.map(entry => {
      const graph = entry.graph;
      if (!graph) return { modelId: entry.modelId, modelName: entry.modelName, status: 'no-cost-source', error: entry.error ?? null };
      const flags = classifyCostModel(graph);
      if (!flags.hasCostData) return { modelId: entry.modelId, modelName: entry.modelName, status: 'no-cost-data', schemaVersion: graph.SchemaVersion, costScheduleCount: 0, costItemCount: 0 };
      const roots = rootKeys(graph);
      const totals = new Map<string, Total>();
      let withoutAmount = 0;
      for (const item of graph.CostItems) {
        const evaluation = methods.evaluateItem(item.ref);
        const root = roots.has(refKey(item.ref));
        addTotal(totals, evaluation, root);
        if (evaluation.Amount === undefined) withoutAmount += 1;
        totalRows += 1;
        if (rows.length < limit) {
          rows.push(evidenceRow({ kind: 'cost-item', modelId: entry.modelId, globalId: item.GlobalId ?? null, expressId: item.ref.expressId,
            unit: evaluation.Currency ?? null, status: evaluation.Amount === undefined ? 'no-amount' : 'evaluated' }, {
            GlobalId: item.GlobalId ?? null, Identification: item.Identification ?? null, Name: item.Name?.slice(0, MESSAGE) ?? null,
            Amount: evaluation.Amount ?? null, Currency: evaluation.Currency ?? null, Dimension: evaluation.Dimension ?? null,
            QuantityApplied: evaluation.QuantityApplied ?? null, rootItem: root,
            diagnostics: evaluation.Diagnostics.slice(0, 5).map(d => ({ code: d.Code, severity: d.Severity, message: d.Message.slice(0, MESSAGE) })),
            diagnosticCount: evaluation.Diagnostics.length,
          }));
        }
      }
      return {
        modelId: entry.modelId, modelName: entry.modelName, status: 'cost-data', schemaVersion: graph.SchemaVersion,
        declaredCurrency: graph.Currency ?? null,
        costSchedules: graph.CostSchedules.map(schedule => ({ globalId: schedule.GlobalId ?? null, name: schedule.Name ?? null, predefinedType: schedule.PredefinedType ?? null, status: schedule.Status ?? null })).slice(0, 20),
        costScheduleCount: graph.CostSchedules.length, costItemCount: graph.CostItems.length, rootItemCount: roots.size,
        itemsWithoutAmount: withoutAmount, totals: [...totals.values()],
        cyclic: flags.cyclic, mixedCurrency: flags.mixedCurrency,
        graphDiagnostics: flags.diagnostics.slice(0, 10).map(d => ({ code: d.Code, severity: d.Severity, message: d.Message.slice(0, MESSAGE) })),
        graphDiagnosticCount: flags.diagnostics.length,
      };
    });
    return {
      summary: {
        kind: 'cost-items', models,
        limitations: 'Totals are per model and per (currency, dimension), never across them. rootTotal adds only items not nested under another item, because a parent IfcCostItem can already include its children through category references; items without an amount are excluded from totals and counted in itemsWithoutAmount. "no-cost-source" means no IFC source could be read; "no-cost-data" means the source was read and declares no cost items. Amounts are as evaluated at capture including pending edits.',
      },
      totalRows,
      availability: 'available',
      rows,
    };
  },
};
