/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { format } from 'echarts/core';
import { aggregate } from './aggregate.js';
import { buildEChartsOption, DEFAULT_THEME } from './echarts-option.js';
import { renderChartSvg } from './render-svg.js';
import type { ChartDataset, ChartSpec, ChartType } from './types.js';

const dataset: ChartDataset = {
  source: 'elements', fingerprint: 'typography',
  columns: [{ id: 'Class', label: 'Class', kind: 'category' }, { id: 'Status', label: 'Status', kind: 'category' },
    { id: 'Height', label: 'Height', kind: 'number' }, { id: 'Date', label: 'Date', kind: 'date' }],
  rows: Array.from({ length: 12 }, (_, i) => ({ ids: [i + 1], values: [
    `IfcBuildingElementProxy Label ${i}`, `Change status ${i % 6}`, i + 1, `2026-09-${String(i + 1).padStart(2, '0')}`,
  ] })),
};
const types: ChartType[] = ['bar', 'stackedBar', 'pie', 'treemap', 'histogram', 'timeline', 'elementCount'];
const spec = (type: ChartType): ChartSpec => type === 'elementCount'
  ? { id: type, title: 'Count', source: 'elements', type, measure: { agg: 'count' } }
  : { id: type, title: 'Elements', source: 'elements', type, dimension: type === 'histogram' ? 'Height' : type === 'timeline' ? 'Date' : 'Class',
    measure: { agg: 'count' }, ...(type === 'stackedBar' ? { stackBy: 'Status' } : {}) };

describe('Chart text sizing (#6546)', () => {
  for (const type of types) {
    it(`changes real ${type} SVG text without changing aggregate data`, () => {
      const aggregation = aggregate(spec(type), dataset);
      const base = renderChartSvg({ aggregation, width: 350, height: 250, print: true, showTitle: false });
      const small = renderChartSvg({ aggregation, width: 350, height: 250, print: true, showTitle: false, fontSize: 6 });
      // ECharts emits its actual text font in SVG styles (not a source-code assertion).
      const sizes = (svg: string) => [...svg.matchAll(/(?:font-size:\s*|font:\s*(?:bold\s+)?)([\d.]+)px/g)].map((m) => Number(m[1]));
      expect(sizes(base).length).toBeGreaterThan(0);
      expect(sizes(small).length).toBeGreaterThan(0);
      expect(Math.max(...sizes(small))).toBeLessThan(Math.max(...sizes(base)));
      expect(small).not.toMatch(/NaN|Infinity/);
      expect(aggregation.total).toBe(12);
      expect(aggregation.categories.flatMap((c) => [...c.ids]).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    });
  }

  it('measures resized axis labels, revealing more of a crowded IFC name', () => {
    const aggregation = aggregate(spec('bar'), dataset);
    const axis = (fontSize?: number) => (buildEChartsOption({ aggregation, width: 350, height: 220, fontSize }).xAxis as {
      axisLabel: { fontSize: number; width: number; formatter: (name: string) => string };
    }).axisLabel;
    const original = axis();
    const small = axis(8);
    const name = aggregation.categories[0].label;
    expect(small.fontSize).toBe(8);
    expect(small.formatter(name).length).toBeGreaterThan(original.formatter(name).length);
    expect(format.getTextRect(small.formatter(name), `8px ${DEFAULT_THEME.fontFamily}`).width).toBeLessThanOrEqual(small.width);
  });

  it('packs a smaller stacked legend into less plot height and reserves room for every shown row', () => {
    const aggregation = aggregate(spec('stackedBar'), dataset);
    const option = (fontSize: number) => buildEChartsOption({ aggregation, width: 260, height: 250, print: true, fontSize });
    const small = option(8);
    const large = option(18);
    expect((small.grid as { top: number }).top).toBeLessThan((large.grid as { top: number }).top);
    expect((small.legend as { textStyle: { fontSize: number } }).textStyle.fontSize).toBe(8);
    expect((small.series as unknown[]).length).toBe(aggregation.series.length);
    expect((small.legend as { data: string[] }).data.length).toBeGreaterThanOrEqual((large.legend as { data: string[] }).data.length);
    const renderedLegend = (fontSize: number) => {
      const svg = renderChartSvg({ aggregation, width: 260, height: 250, print: true, fontSize });
      const centers = [...svg.matchAll(/<text[^>]*transform="translate\([^ ]+ ([\d.]+)\)"[^>]*>Change status[^<]*<\/text>/g)].map((m) => Number(m[1]));
      expect(centers.length).toBeGreaterThan(0);
      const bottom = Math.max(...centers) + fontSize / 2;
      expect(bottom).toBeLessThan((option(fontSize).grid as { top: number }).top);
      return bottom - Math.min(...centers) + fontSize / 2;
    };
    expect(renderedLegend(8)).toBeLessThan(renderedLegend(18));
  });

  it('fits more pie legend labels into the same bounded chart with smaller text', () => {
    const aggregation = aggregate(spec('pie'), dataset);
    const option = (fontSize: number) => buildEChartsOption({ aggregation, width: 400, height: 200, print: true, fontSize });
    const labels = (fontSize: number) => (option(fontSize).legend as { data?: string[] }).data?.length ?? aggregation.categories.length;
    expect(labels(8)).toBeGreaterThan(labels(18));
    expect((option(8).legend as { textStyle: { fontSize: number } }).textStyle.fontSize).toBeCloseTo(20 / 3);
  });

  it('bounds enlarged legends and count text within a short half-width chart', () => {
    const width = 220; const height = 120;
    for (const type of ['stackedBar', 'pie'] as const) {
      const aggregation = aggregate(spec(type), dataset);
      const option = buildEChartsOption({ aggregation, width, height, print: true, fontSize: 24 });
      const legend = option.legend as { data: string[] };
      expect(legend.data.length).toBeGreaterThan(0);
      expect(legend.data.length).toBeLessThan(type === 'stackedBar' ? aggregation.series.length : aggregation.categories.length);
      expect(renderChartSvg({ aggregation, width, height, print: true, fontSize: 24 })).not.toMatch(/NaN|Infinity/);
      if (type === 'stackedBar') expect((option.grid as { top: number }).top).toBeLessThan(height / 2);
    }
    const aggregation = { ...aggregate(spec('elementCount'), dataset), total: 12_623_456 };
    const option = buildEChartsOption({ aggregation, width, height, fontSize: 24 });
    const graphic = option.graphic as { elements: Array<{ style: { text: string; font: string } }> };
    const { text, font } = graphic.elements[0].style;
    expect(format.getTextRect(text, font).width).toBeLessThanOrEqual(width - 16);
  });

  it('uses unchanged default options for unset, default and invalid sizes', () => {
    for (const type of types) {
      const aggregation = aggregate(spec(type), dataset);
      // Compare the public option's structural values; no renderer-generated ids or byte pinning.
      const defaultValues = JSON.stringify(buildEChartsOption({ aggregation, width: 350, height: 250, print: true }));
      for (const fontSize of [undefined, 12, NaN, Infinity, -1, 5, 25]) {
        expect(JSON.stringify(buildEChartsOption({ aggregation, width: 350, height: 250, print: true, fontSize }))).toBe(defaultValues);
      }
    }
  });
});
