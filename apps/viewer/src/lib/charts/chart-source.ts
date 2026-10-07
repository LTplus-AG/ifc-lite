/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one resolver every chart surface asks for its rows: the dashboard card,
 * the chart editor, the report export dialog, the document preview and PDF,
 * and the assistant's charts evidence. A chart reads its live dataset unless
 * it is bound to saved content, either a saved comparison (#6549) or a saved
 * clash report (#6947). Routing both through here is what keeps a surface from
 * honouring one binding and silently drawing the latest run for the other.
 */

import type { ChartDataset, ChartSpec } from '@ifc-lite/charts';
import type { UseTranslationResult } from '@/i18n/useTranslation';
import type { SavedComparison } from '@/lib/compare/savedComparisons';
import type { LoadedModelIdentity, SavedClashReport } from '@/lib/clash/saved-report-schema';
import { comparisonChartMessage, isSavedComparisonChart, resolveComparisonChartSource, type ComparisonChartSource } from './comparison-source';
import { clashReportChartBadges, clashReportChartMessage, isSavedClashReportChart, resolveClashReportChartSource, type ClashReportChartSource } from './clash-report-source';

/** The saved content and loaded models a binding is resolved against. */
export interface ChartSourceContext {
  comparisons: readonly SavedComparison[];
  clashReports: readonly SavedClashReport[];
  models: ReadonlyMap<string, LoadedModelIdentity>;
  mutationVersion: number;
}

/** No saved content and no loaded models: every bound chart resolves as unavailable. */
export const NO_SAVED_CHART_CONTENT: ChartSourceContext = { comparisons: [], clashReports: [], models: new Map(), mutationVersion: 0 };

export type ResolvedChartSource =
  | (ComparisonChartSource & { saved: 'comparison' | null })
  | (ClashReportChartSource & { saved: 'clashReport' });

type SourceBinding = Pick<ChartSpec, 'source' | 'comparisonId' | 'clashReportId'>;

/** Bound to saved content: its rows carry no renderer ids, so no 3D selection, framing, cross-filter or snapshot. */
export function isRecordedChart(spec: SourceBinding): boolean {
  return isSavedComparisonChart(spec) || isSavedClashReportChart(spec);
}

export function chartSourceContext(state: { savedComparisons: readonly SavedComparison[]; savedClashReports: readonly SavedClashReport[];
  models: ReadonlyMap<string, LoadedModelIdentity>; mutationVersion: number }): ChartSourceContext {
  return { comparisons: state.savedComparisons, clashReports: state.savedClashReports, models: state.models, mutationVersion: state.mutationVersion };
}

export function resolveChartSource(spec: SourceBinding, live: ChartDataset, context: ChartSourceContext): ResolvedChartSource {
  if (isSavedClashReportChart(spec)) {
    return { ...resolveClashReportChartSource(spec, live, context.clashReports, context.models.values(), context.mutationVersion), saved: 'clashReport' };
  }
  const source = resolveComparisonChartSource(spec, live, context.comparisons);
  return { ...source, saved: source.status === 'live' ? null : 'comparison' };
}

type Translate = UseTranslationResult['t'];

/** Provenance of a recorded source, or why a bound source is unavailable; undefined for a live chart. */
export function chartSourceMessage(source: ResolvedChartSource, t: Translate): string | undefined {
  return source.saved === 'clashReport' ? clashReportChartMessage(source, t) : comparisonChartMessage(source, t);
}

/** The short "source unavailable" label of a bound chart whose saved content is gone. */
export function chartSourceUnavailable(source: ResolvedChartSource, t: Translate): string {
  return t(source.saved === 'clashReport' ? 'chartClashReport.unavailable' : 'chartComparison.unavailable');
}

/** Short card labels for a saved clash report (what it is, then what limits it); none for other sources. */
export function chartSourceBadges(source: ResolvedChartSource, t: Translate): string[] {
  return source.saved === 'clashReport' ? clashReportChartBadges(source, t) : [];
}
