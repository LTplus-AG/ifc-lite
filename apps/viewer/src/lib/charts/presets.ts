/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Starter dashboards (#3944). The first one is what an empty Charts panel
 * offers; more (coordination, delivery, schedule) arrive with their sources.
 */
import { ELEMENT_COLUMNS, type ChartSpec, type DashboardSpec } from '@ifc-lite/charts';
import { CLASH_COLUMNS } from './datasets/clash';
import { BCF_COLUMNS } from './datasets/bcf';
import { SCHEDULE_COLUMNS } from './datasets/schedule';
import { IDS_COLUMNS } from './datasets/ids';

let counter = 0;
/** A fresh id per call: two dashboards from one preset must not collide. */
export function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function newChartSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    id: freshId('chart'),
    title: 'Elements by type',
    source: 'elements',
    type: 'bar',
    dimension: ELEMENT_COLUMNS.ifcType,
    measure: { agg: 'count' },
    topN: 12,
    ...overrides,
  };
}

export function modelOverviewDashboard(): DashboardSpec {
  const byType = newChartSpec({ title: 'Elements by type', type: 'bar', dimension: ELEMENT_COLUMNS.ifcType, topN: 12 });
  const byStorey = newChartSpec({ title: 'Elements by storey', type: 'pie', dimension: ELEMENT_COLUMNS.storey, sort: 'label' });
  const typeByStorey = newChartSpec({ title: 'Types per storey', type: 'stackedBar', dimension: ELEMENT_COLUMNS.storey, stackBy: ELEMENT_COLUMNS.ifcType, sort: 'label', topN: 8 });
  return {
    version: 1,
    id: freshId('dashboard'),
    name: 'Model overview',
    scope: { kind: 'all' },
    charts: [byType, byStorey, typeByStorey],
    layout: [
      { chartId: byType.id, x: 0, y: 0, w: 6, h: 4 },
      { chartId: byStorey.id, x: 6, y: 0, w: 6, h: 4 },
      { chartId: typeByStorey.id, x: 0, y: 4, w: 12, h: 4 },
    ],
  };
}

/** Lay charts out two per row, full width for the last odd one. */
function grid(charts: ChartSpec[]): DashboardSpec['layout'] {
  return charts.map((c, i) => ({ chartId: c.id, x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: i === charts.length - 1 && i % 2 === 0 ? 12 : 6, h: 4 }));
}

function dashboard(name: string, charts: ChartSpec[]): DashboardSpec {
  return { version: 1, id: freshId('dashboard'), name, scope: { kind: 'all' }, charts, layout: grid(charts) };
}

/** Weekly coordination meeting: clashes by discipline pair / severity / review / storey, issues by status / assignee / due, opened vs closed per week. */
export function coordinationDashboard(): DashboardSpec {
  return dashboard('Coordination', [
    newChartSpec({ title: 'Clashes by type pair', source: 'clash', type: 'bar', dimension: CLASH_COLUMNS.typePair, topN: 10 }),
    newChartSpec({ title: 'Clashes by severity', source: 'clash', type: 'pie', dimension: CLASH_COLUMNS.severity, topN: undefined }),
    newChartSpec({ title: 'Clash review status per storey', source: 'clash', type: 'stackedBar', dimension: CLASH_COLUMNS.storey, stackBy: CLASH_COLUMNS.review, sort: 'label', topN: undefined }),
    newChartSpec({ title: 'Penetration depth', source: 'clash', type: 'histogram', dimension: CLASH_COLUMNS.distance, topN: undefined }),
    newChartSpec({ title: 'Topics by status', source: 'bcf', type: 'pie', dimension: BCF_COLUMNS.status, topN: undefined }),
    newChartSpec({ title: 'Open topics by assignee', source: 'bcf', type: 'stackedBar', dimension: BCF_COLUMNS.assignedTo, stackBy: BCF_COLUMNS.due, topN: 10 }),
    newChartSpec({ title: 'Topics created per week', source: 'bcf', type: 'timeline', dimension: BCF_COLUMNS.created, topN: undefined }),
    newChartSpec({ title: 'Topics closed per week', source: 'bcf', type: 'timeline', dimension: BCF_COLUMNS.closed, topN: undefined }),
  ]);
}

/** Delivery check: IDS pass / fail per specification and what fails. */
export function deliveryDashboard(): DashboardSpec {
  return dashboard('Delivery', [
    newChartSpec({ title: 'IDS result per specification', source: 'ids', type: 'stackedBar', dimension: IDS_COLUMNS.specification, stackBy: IDS_COLUMNS.result, sort: 'label', topN: undefined }),
    newChartSpec({ title: 'Failures by facet', source: 'ids', type: 'pie', dimension: IDS_COLUMNS.failedFacet, topN: undefined }),
    newChartSpec({ title: 'Failures by entity type', source: 'ids', type: 'bar', dimension: IDS_COLUMNS.entityType, topN: 12 }),
    newChartSpec({ title: 'Elements by type', source: 'elements', type: 'treemap', dimension: ELEMENT_COLUMNS.ifcType, topN: 20 }),
  ]);
}

/** 4D: tasks by status and by phase at the playback cursor, per week. */
export function scheduleDashboard(): DashboardSpec {
  return dashboard('Schedule', [
    newChartSpec({ title: 'Tasks by phase at cursor', source: 'schedule', type: 'pie', dimension: SCHEDULE_COLUMNS.phase, topN: undefined }),
    newChartSpec({ title: 'Tasks by type', source: 'schedule', type: 'bar', dimension: SCHEDULE_COLUMNS.type, topN: 12 }),
    newChartSpec({ title: 'Tasks starting per week', source: 'schedule', type: 'timeline', dimension: SCHEDULE_COLUMNS.start, topN: undefined }),
    newChartSpec({ title: 'Products per phase', source: 'schedule', type: 'bar', dimension: SCHEDULE_COLUMNS.phase, measure: { agg: 'sum', column: SCHEDULE_COLUMNS.products }, topN: undefined }),
  ]);
}

export const DASHBOARD_PRESETS: ReadonlyArray<{ name: string; create: () => DashboardSpec }> = [
  { name: 'Model overview', create: modelOverviewDashboard },
  { name: 'Coordination', create: coordinationDashboard },
  { name: 'Delivery', create: deliveryDashboard },
  { name: 'Schedule', create: scheduleDashboard },
];
