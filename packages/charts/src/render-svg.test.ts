/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregate.js';
import { buildEChartsOption } from './echarts-option.js';
import { renderChartSvg } from './render-svg.js';
import { validateDashboardSpec } from './validate.js';
import type { ChartDataset, ChartSpec, DashboardSpec } from './types.js';

const ds: ChartDataset = {
  source: 'elements',
  columns: [{ id: 'IfcType', label: 'IFC type', kind: 'category' }, { id: 'Storey', label: 'Storey', kind: 'category' }],
  rows: [
    { ids: [1], values: ['IfcWall', 'L1'] }, { ids: [2], values: ['IfcWall', 'L2'] }, { ids: [3], values: ['IfcDoor', 'L1'] },
  ],
  fingerprint: 't',
};
const bar: ChartSpec = { id: 'c', title: 'Elements by type', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } };

describe('buildEChartsOption', () => {
  it('marks the selected categories, keeps bucket colours and enables multiple select on every series', () => {
    const agg = aggregate(bar, ds);
    const option = buildEChartsOption({ aggregation: agg, selected: [1] });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(1);
    expect(series[0].selectedMode).toBe('multiple');
    const data = series[0].data as Array<{ name: string; value: number; selected: boolean; itemStyle: { color: string } }>;
    expect(data.map((d) => [d.name, d.value, d.selected])).toEqual([['IfcWall', 2, false], ['IfcDoor', 1, true]]);
    expect(data[0].itemStyle.color).toBe(agg.categories[0].color);
    expect((option.xAxis as { data: string[] }).data).toEqual(['IfcWall', 'IfcDoor']);
  });

  it('builds one bar series per stack value, a pie and a treemap from the same aggregation shape', () => {
    const stacked = aggregate({ ...bar, type: 'stackedBar', stackBy: 'Storey' }, ds);
    const option = buildEChartsOption({ aggregation: stacked });
    expect((option.series as Array<{ name: string; stack: string }>).map((s) => [s.name, s.stack])).toEqual([['L1', 'total'], ['L2', 'total']]);
    expect((buildEChartsOption({ aggregation: aggregate({ ...bar, type: 'pie' }, ds) }).series as Array<{ type: string }>)[0].type).toBe('pie');
    expect((buildEChartsOption({ aggregation: aggregate({ ...bar, type: 'treemap' }, ds) }).series as Array<{ type: string }>)[0].type).toBe('treemap');
  });
});

describe('renderChartSvg (ECharts SSR, no DOM)', () => {
  it('renders a bar, a pie and a treemap to SVG carrying the category labels and bucket colours', () => {
    for (const type of ['bar', 'pie', 'treemap'] as const) {
      const agg = aggregate({ ...bar, type }, ds);
      const svg = renderChartSvg({ aggregation: agg, width: 480, height: 320 });
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('IfcWall');
      expect(svg).toContain('IfcDoor');
      expect(svg).toContain('Elements by type');
      expect(svg.toLowerCase()).toContain(agg.categories[0].color.toLowerCase());
    }
  });
});

describe('validateDashboardSpec', () => {
  const good: DashboardSpec = {
    version: 1, id: 'd', name: 'Overview', scope: { kind: 'all' },
    charts: [bar, { ...bar, id: 'c2', type: 'stackedBar', stackBy: 'Storey' }],
    layout: [{ chartId: 'c', x: 0, y: 0, w: 6, h: 4 }, { chartId: 'c2', x: 6, y: 0, w: 6, h: 4 }],
  };

  it('accepts a well-formed dashboard and a report extending it', () => {
    expect(validateDashboardSpec(good)).toEqual([]);
    expect(validateDashboardSpec({ ...good, page: { size: 'A4', orientation: 'landscape' }, titleBlock: { project: 'X' }, snapshots: true })).toEqual([]);
  });

  it('reports every problem at once with its path', () => {
    const bad = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    bad.version = 2;
    (bad.charts as Array<Record<string, unknown>>)[1].stackBy = undefined;
    (bad.charts as Array<Record<string, unknown>>)[1].id = 'c';
    (bad.layout as Array<Record<string, unknown>>)[1].chartId = 'missing';
    (bad.layout as Array<Record<string, unknown>>)[0].w = 'wide';
    const paths = validateDashboardSpec(bad).map((e) => e.path).sort();
    expect(paths).toEqual(['.charts[1].id', '.charts[1].stackBy', '.layout[0].w', '.layout[1].chartId', '.version']);
    expect(validateDashboardSpec(null)).toEqual([{ path: '', message: 'expected a dashboard object' }]);
  });
});
