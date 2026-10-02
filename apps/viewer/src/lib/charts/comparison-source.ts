/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChartDataset, ChartDatasetRow, ChartSpec } from '@ifc-lite/charts';
import type { UseTranslationResult } from '@/i18n/useTranslation';
import { isSavedComparison, type SavedComparison } from '@/lib/compare/savedComparisons';
import { COMPARE_DATASET_COLUMNS } from './datasets/compare';

type SourceBinding = Pick<ChartSpec, 'source' | 'comparisonId'>;
export interface ComparisonChartSource {
  dataset: ChartDataset;
  status: 'live' | 'saved' | 'missing';
  name?: string;
}

/** Portable report identifiers cannot select entities in the current model. */
export function isSavedComparisonChart(spec: SourceBinding): boolean {
  return spec.source === 'compare' && spec.comparisonId !== undefined;
}

const revisions = new WeakMap<SavedComparison['report'], { rows: ChartDatasetRow[]; fingerprint: string }>();

function reportDataset(report: SavedComparison['report']) {
  const known = revisions.get(report);
  if (known) return known;
  const serialized = JSON.stringify(report);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
  const projected = {
    // Exact canonical report rows: includes content matches and excludes
    // unchanged rows as the saved report does. No second diff/ingest path.
    rows: report.rows.map((row) => ({ ids: [], values: [row.state, row.change, row.ifcType, row.model] })),
    fingerprint: `${serialized.length}:${(hash >>> 0).toString(16)}`,
  };
  revisions.set(report, projected);
  return projected;
}

/** One resolver for dashboard cards, the editor, and document/PDF data.
 * A missing bound source stays empty; it never substitutes the latest run. */
export function resolveComparisonChartSource(spec: SourceBinding, live: ChartDataset, history: readonly SavedComparison[]): ComparisonChartSource {
  if (!isSavedComparisonChart(spec)) return { dataset: live, status: 'live' };
  const saved = history.find((candidate) => candidate.id === spec.comparisonId && isSavedComparison(candidate));
  if (!saved) return { status: 'missing', dataset: { source: 'compare', columns: COMPARE_DATASET_COLUMNS, rows: [], fingerprint: `saved-compare:missing:${spec.comparisonId}` } };
  const projected = reportDataset(saved.report);
  return { status: 'saved', name: saved.name, dataset: { source: 'compare', columns: COMPARE_DATASET_COLUMNS,
    rows: projected.rows, fingerprint: `saved-compare:${saved.id}:${projected.fingerprint}` } };
}

export function comparisonChartMessage(source: ComparisonChartSource, t: UseTranslationResult['t']): string | undefined {
  if (source.status === 'missing') return t('chartComparison.missing');
  if (source.status === 'saved') return t('chartComparison.recorded', { name: source.name ?? '' });
  return undefined;
}
