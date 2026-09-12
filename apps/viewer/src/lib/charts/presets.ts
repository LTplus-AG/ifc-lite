/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Starter dashboards (#3944). The first one is what an empty Charts panel
 * offers; more (coordination, delivery, schedule) arrive with their sources.
 */
import { ELEMENT_COLUMNS, type ChartSpec, type DashboardSpec } from '@ifc-lite/charts';

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
