/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CSV reports for the Cost and BIM ↔ scan Deviation panels (#5832). */

import { tableToCsv } from '@ifc-lite/export';
import type { CostBackendMethods, CostGraphData } from '@ifc-lite/sdk';
import { buildExportFilename, modelExportFilename } from '@/lib/export/download';

export interface CostReportModel {
  modelName: string;
  graph: CostGraphData | null;
}

interface CostReportRow {
  Model: string;
  GlobalId: string;
  Name: string;
  IfcClass: 'IfcCostItem';
  Identification: string;
  Amount: string;
  Currency: string;
  QuantityApplied: string;
  Diagnostics: string;
}

const COST_COLUMNS: ReadonlyArray<keyof CostReportRow> = [
  'GlobalId', 'Name', 'IfcClass', 'Identification', 'Amount', 'Currency', 'QuantityApplied', 'Diagnostics',
];

export interface CsvReport {
  content: string;
  filename: string;
  rows: number;
}

function reportFilename(modelNames: readonly string[], suffix: string): string {
  return modelNames.length <= 1
    ? modelExportFilename(modelNames[0] ?? 'model', 'csv', suffix)
    : buildExportFilename(`federation${suffix}`, 'csv');
}

/** Each cost item is evaluated by the same backend as the detail pane. */
export function buildCostCsvReport(
  models: readonly CostReportModel[],
  evaluateItem: CostBackendMethods['evaluateItem'],
): CsvReport | null {
  const rows: CostReportRow[] = [];
  for (const model of models) {
    for (const item of model.graph?.CostItems ?? []) {
      const evaluation = evaluateItem(item.ref);
      rows.push({
        Model: model.modelName,
        GlobalId: item.GlobalId ?? '',
        Name: item.Name ?? '',
        IfcClass: 'IfcCostItem',
        Identification: item.Identification ?? '',
        Amount: evaluation.Amount ?? '',
        Currency: evaluation.Currency ?? '',
        QuantityApplied: evaluation.QuantityApplied ?? '',
        Diagnostics: evaluation.Diagnostics.map((diagnostic) => diagnostic.Message).join('; '),
      });
    }
  }
  if (rows.length === 0) return null;
  const columns: ReadonlyArray<keyof CostReportRow> = models.length > 1
    ? ['Model', ...COST_COLUMNS]
    : COST_COLUMNS;
  return {
    content: tableToCsv(columns, rows),
    filename: reportFilename(models.map((model) => model.modelName), '-cost'),
    rows: rows.length,
  };
}

/** One scan asset, with metadata resolved by the viewer's model store. */
export interface DeviationReportRow {
  Model: string;
  GlobalId: string;
  Name: string;
  IfcClass: string;
  PointsProcessed: number;
  FinitePoints: number;
  MinimumDeviationM: number | null;
  MaximumDeviationM: number | null;
  MeanDeviationM: number | null;
}

export function buildDeviationCsvReport(
  rows: readonly DeviationReportRow[],
  modelNames: readonly string[],
): CsvReport | null {
  if (rows.length === 0) return null;
  const columns: ReadonlyArray<keyof DeviationReportRow> = modelNames.length > 1
    ? ['Model', 'GlobalId', 'Name', 'IfcClass', 'PointsProcessed', 'FinitePoints',
      'MinimumDeviationM', 'MaximumDeviationM', 'MeanDeviationM']
    : ['GlobalId', 'Name', 'IfcClass', 'PointsProcessed', 'FinitePoints',
      'MinimumDeviationM', 'MaximumDeviationM', 'MeanDeviationM'];
  return {
    content: tableToCsv(columns, rows),
    filename: reportFilename(modelNames, '-deviation'),
    rows: rows.length,
  };
}
