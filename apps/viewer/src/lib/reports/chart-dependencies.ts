/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ChartSpec } from '@ifc-lite/charts';
import type { DocumentSpec } from '@/lib/document/types';
import type { ViewerState } from '@/store';
import { readDashboards } from '@/lib/charts/persistence';

export type ReportSource = { kind: 'compare' | 'clash'; id: string };
export interface ChartDependency { key: string; family: 'dashboard' | 'document'; name: string; chart: string }
export const DEPENDENCY_DISPLAY_LIMIT = 20;
export interface ChartDependencyPreview {
  entries: ChartDependency[];
  total: number;
  documentPhase: 'loading' | 'ready' | 'unavailable';
  dashboardsUnavailable: boolean;
  documentsRecovered: boolean;
  omittedDashboards: number;
  signature: string;
}
const pointsTo = (chart: ChartSpec, source: ReportSource) => chart.source === source.kind
  && (source.kind === 'compare' ? chart.comparisonId : chart.clashReportId) === source.id;
/** Only executable chart references; embedded report snapshots are independent historical evidence. */
export function reportChartDependencies(state: ViewerState, source: ReportSource, durableDocuments?: { entries: readonly DocumentSpec[]; phase: ChartDependencyPreview['documentPhase'] }): ChartDependencyPreview {
  const persisted = readDashboards();
  // Another tab's durable version and this tab's unsaved version can each
  // contain executable references. Neither version can erase the other.
  const references = new Map<string, ChartDependency>();
  const observations = new Set<string>();
  const add = (dependency: ChartDependency) => {
    references.set(dependency.key, dependency);
    observations.add(JSON.stringify(dependency));
  };
  for (const dashboard of [...persisted.entries, ...state.dashboards]) for (const chart of dashboard.charts) {
    if (pointsTo(chart, source)) add({ key: JSON.stringify(['dashboard', dashboard.id, chart.id]), family: 'dashboard', name: dashboard.name, chart: chart.title });
  }
  for (const document of [...(durableDocuments?.entries ?? []), ...state.documents]) for (const block of document.blocks) {
    if (block.kind === 'chart' && pointsTo(block.chart, source)) add({ key: JSON.stringify(['document', document.id, block.id]), family: 'document', name: document.name, chart: block.chart.title });
  }
  const all = [...references.values()];
  all.sort((a, b) => a.key.localeCompare(b.key));
  const coverage = { documentPhase: durableDocuments?.phase === 'loading' || state.documentsStorage.phase === 'loading' ? 'loading' as const
    : durableDocuments?.phase === 'unavailable' || state.documentsStorage.phase === 'unavailable' ? 'unavailable' as const : 'ready' as const, documentsRecovered: state.documentsStorage.recovered, dashboardsUnavailable: persisted.unavailable, omittedDashboards: persisted.omitted };
  return { ...coverage, entries: all.slice(0, DEPENDENCY_DISPLAY_LIMIT), total: all.length, signature: JSON.stringify([all, coverage, [...observations].sort()]) };
}
