/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `clash` chart bound to a saved clash report (#6947). An unbound clash
 * chart keeps reading the current result; a bound one reads its report's
 * frozen rows, so another check cannot change what it shows. A bound report
 * that is gone stays empty and says so: the current result never stands in.
 */

import type { ChartDataset, ChartDatasetRow, ChartSpec } from '@ifc-lite/charts';
import type { UseTranslationResult } from '@/i18n/useTranslation';
import { clashReportRevision, isSavedClashReport, type ClashReportRevision, type LoadedModelIdentity, type SavedClashReport } from '@/lib/clash/saved-report-schema';
import { CLASH_DATASET_COLUMNS, clashDatasetRow } from './datasets/clash';

type SourceBinding = Pick<ChartSpec, 'source' | 'clashReportId'>;

export type ClashReportChartSource =
  | { status: 'live'; dataset: ChartDataset }
  | { status: 'missing'; dataset: ChartDataset }
  | { status: 'saved'; dataset: ChartDataset; report: SavedClashReport; revision: ClashReportRevision };

/** A saved report keeps no renderer ids, so its chart cannot select or frame elements. */
export function isSavedClashReportChart(spec: SourceBinding): boolean {
  return spec.source === 'clash' && spec.clashReportId !== undefined;
}

const projections = new WeakMap<SavedClashReport, { rows: ChartDatasetRow[]; fingerprint: string }>();

function reportRows(report: SavedClashReport): { rows: ChartDatasetRow[]; fingerprint: string } {
  const known = projections.get(report);
  if (known) return known;
  const names = new Map(report.models.map((model) => [model.id, model.name]));
  const name = (id: string): string => names.get(id) ?? id;
  // The same row builder as the current result; only the facts come from the report instead of the store.
  const rows = report.clashes.map((clash) => clashDatasetRow({
    rule: clash.rule, severity: clash.severity, status: clash.status, review: clash.review,
    typeA: clash.a.tag, typeB: clash.b.tag, modelA: name(clash.a.model), modelB: name(clash.b.model),
    storey: clash.storey, distance: clash.distance, group: clash.group,
  }, []));
  // A report's evidence is immutable, so its id and row count identify the rows; only the name can change.
  const projected = { rows, fingerprint: `${report.savedAt}:${rows.length}` };
  projections.set(report, projected);
  return projected;
}

export function resolveClashReportChartSource(spec: SourceBinding, live: ChartDataset, reports: readonly SavedClashReport[],
  loaded: Iterable<LoadedModelIdentity>, mutationVersion: number): ClashReportChartSource {
  if (!isSavedClashReportChart(spec)) return { status: 'live', dataset: live };
  const report = reports.find((candidate) => candidate.id === spec.clashReportId && isSavedClashReport(candidate));
  if (!report) return { status: 'missing', dataset: { source: 'clash', columns: CLASH_DATASET_COLUMNS, rows: [], fingerprint: `saved-clash:missing:${spec.clashReportId}` } };
  const projected = reportRows(report);
  return { status: 'saved', report, revision: clashReportRevision(report, [...loaded], mutationVersion),
    dataset: { source: 'clash', columns: CLASH_DATASET_COLUMNS, rows: projected.rows, fingerprint: `saved-clash:${report.id}:${projected.fingerprint}` } };
}

type Translate = UseTranslationResult['t'];

/** What limits a saved report as evidence: a partial run, models that changed before saving, another model revision.
 * One list for the chart card and the Clash panel's saved-report list. */
export function clashReportLimitBadges(report: SavedClashReport, revision: ClashReportRevision, t: Translate): string[] {
  return [
    ...(report.completeness.truncated ? [t('chartClashReport.badgePartial')] : []),
    ...(report.completeness.stale ? [t('chartClashReport.badgeStale')] : []),
    ...(revision === 'same' ? [] : [t(`chartClashReport.badgeRevision.${revision}`)]),
  ];
}

/** Short labels for a chart card, most important first: what the source is, then what limits it. */
export function clashReportChartBadges(source: ClashReportChartSource, t: Translate): string[] {
  if (source.status !== 'saved') return [];
  return [t('chartClashReport.badgeSaved', { name: source.report.name }), ...clashReportLimitBadges(source.report, source.revision, t)];
}

/** The full statement: printed under a document chart, read by the editor and the card's tooltip. */
export function clashReportChartMessage(source: ClashReportChartSource, t: Translate): string | undefined {
  if (source.status === 'live') return undefined;
  if (source.status === 'missing') return t('chartClashReport.missing');
  const { report } = source;
  return [
    t('chartClashReport.recorded', { name: report.name, date: new Date(report.savedAt).toLocaleDateString() }),
    ...(report.completeness.truncated ? [t('chartClashReport.partial', { count: report.completeness.truncated.droppedPairs })] : []),
    ...(report.completeness.stale ? [t('chartClashReport.stale')] : []),
    ...(source.revision === 'same' ? [] : [t(`chartClashReport.revision.${source.revision}`)]),
    t('chartClashReport.recordedLimits'),
  ].join(' ');
}
