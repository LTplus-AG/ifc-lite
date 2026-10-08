/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ChartSpec } from '@ifc-lite/charts';
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
export function reportChartDependencies(state: ViewerState, source: ReportSource): ChartDependencyPreview {
  const persisted = readDashboards();
  const dashboards = new Map(persisted.entries.map(entry => [entry.id, entry]));
  // Visible native session edits win over their durable version; no shadow library is created.
  for (const entry of state.dashboards) dashboards.set(entry.id, entry);
  const all: ChartDependency[] = [];
  for (const dashboard of dashboards.values()) for (const chart of dashboard.charts) {
    if (pointsTo(chart, source)) all.push({ key: JSON.stringify(['dashboard', dashboard.id, chart.id]), family: 'dashboard', name: dashboard.name, chart: chart.title });
  }
  for (const document of state.documents) for (const block of document.blocks) {
    if (block.kind === 'chart' && pointsTo(block.chart, source)) all.push({ key: JSON.stringify(['document', document.id, block.id]), family: 'document', name: document.name, chart: block.chart.title });
  }
  all.sort((a, b) => a.key.localeCompare(b.key));
  const coverage = { documentPhase: state.documentsStorage.phase, documentsRecovered: state.documentsStorage.recovered, dashboardsUnavailable: persisted.unavailable, omittedDashboards: persisted.omitted };
  return { ...coverage, entries: all.slice(0, DEPENDENCY_DISPLAY_LIMIT), total: all.length, signature: JSON.stringify([all, coverage]) };
}
