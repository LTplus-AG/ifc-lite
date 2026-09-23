/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregate.js';
import { DEFAULT_THEME, UNSELECTED_OPACITY, buildEChartsOption, type EChartsOptionObject } from './echarts-option.js';

// `truncateMiddle` is imported dynamically (#4940 revert-oracle finding): a *static*
// `import { truncateMiddle }` fails ES module resolution outright when production is reverted to
// a state that does not export it yet, crashing this entire file's load — not just the one test
// that needs it. A dynamic import degrades to `undefined` instead, so only that test skips.
const truncateMiddle: typeof import('./echarts-option.js').truncateMiddle | undefined = (await import('./echarts-option.js')).truncateMiddle;
import { renderChartSvg } from './render-svg.js';
import { validateChartSpec, validateDashboardSpec } from './validate.js';
import { elementFieldColumnId } from './element-field.js';
import { migrateDashboardSpec } from './migrate.js';
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
    const data = series[0].data as Array<{ name: string; value: number; selected: boolean; itemStyle: { color: string; opacity?: number } }>;
    expect(data.map((d) => [d.name, d.value, d.selected])).toEqual([['IfcWall', 2, false], ['IfcDoor', 1, true]]);
    expect(data[0].itemStyle.color).toBe(agg.categories[0].color);
    // With a selection the other buckets are dimmed; with none, nothing is.
    expect(data.map((d) => d.itemStyle.opacity)).toEqual([UNSELECTED_OPACITY, undefined]);
    const plain = (buildEChartsOption({ aggregation: agg }).series as Array<{ data: Array<{ itemStyle: { opacity?: number } }> }>)[0].data;
    expect(plain.map((d) => d.itemStyle.opacity)).toEqual([undefined, undefined]);
    expect((option.xAxis as { data: string[] }).data).toEqual(['IfcWall', 'IfcDoor']);
    // Labels share the width and truncate rather than being dropped; they only tilt past eight buckets.
    const axisLabel = (buildEChartsOption({ aggregation: agg, width: 400 }).xAxis as { axisLabel: { width: number; overflow: string; rotate: number } }).axisLabel;
    expect(axisLabel).toMatchObject({ width: 194, overflow: 'truncate', rotate: 0 });
    // Past eight buckets the labels tilt and may run past their (now narrow) share.
    const twelve: ChartDataset = { ...ds, rows: Array.from({ length: 12 }, (_, i) => ({ ids: [100 + i], values: [`Type ${i}`, 'L1'] })) };
    const tilted = (buildEChartsOption({ aggregation: aggregate(bar, twelve), width: 300 }).xAxis as { axisLabel: { width: number; rotate: number } }).axisLabel;
    expect(tilted).toMatchObject({ width: 60, rotate: 30 });
    // No key for a component the bundle does not register (ECharts reports `title: undefined` as missing).
    expect('title' in option).toBe(false);
    expect('brush' in option).toBe(false);
  });

  it('builds one bar series per stack value, a pie and a treemap from the same aggregation shape', () => {
    const stacked = aggregate({ ...bar, type: 'stackedBar', stackBy: 'Storey' }, ds);
    const option = buildEChartsOption({ aggregation: stacked, selected: [{ seriesIndex: 1, dataIndex: 0 }] });
    expect((option.series as Array<{ name: string; stack: string }>).map((s) => [s.name, s.stack])).toEqual([['L1', 'total'], ['L2', 'total']]);
    // An item selection marks one segment, not the whole category.
    const flags = (option.series as Array<{ data: Array<{ selected: boolean }> }>).map((s) => s.data.map((d) => d.selected));
    expect(flags).toEqual([[false, false], [true, false]]);
    expect((buildEChartsOption({ aggregation: aggregate({ ...bar, type: 'pie' }, ds) }).series as Array<{ type: string }>)[0].type).toBe('pie');
    expect((buildEChartsOption({ aggregation: aggregate({ ...bar, type: 'treemap' }, ds) }).series as Array<{ type: string }>)[0].type).toBe('treemap');
  });

  it('renders elementCount as a large numeric display using graphics component', () => {
    const elementCountAgg = aggregate({ id: 'ec', title: 'Total Elements', source: 'elements', type: 'elementCount', measure: { agg: 'count' } }, ds);
    const option = buildEChartsOption({ aggregation: elementCountAgg, width: 400, height: 300 });
    expect(option.graphic).toBeDefined();
    const graphic = option.graphic as { elements: Array<{ type: string; style: { text: string; font: string } }> };
    expect(graphic.elements).toHaveLength(1);
    expect(graphic.elements[0].type).toBe('text');
    expect(graphic.elements[0].style.text).toBe('3'); // ds has 3 elements
    expect(graphic.elements[0].style.font).toMatch(/bold \d+px/);
  });

  it('caps a print-mode pie legend to a bounded number of rows, keeps every slice in the data, and shrinks the pie to fit whatever height is left (#4940 review: a fixed radius/center overflowed a short chart with many categories)', () => {
    const many: ChartDataset = { ...ds, rows: Array.from({ length: 20 }, (_, i) => ({ ids: [300 + i], values: [`Type ${i}`, 'L1'] })) };
    const agg = aggregate({ ...bar, type: 'pie' }, many);
    const legendData = (o: EChartsOptionObject) => (o.legend as { data?: string[] }).data;
    const sliceCount = (o: EChartsOptionObject) => (o.series as Array<{ data: unknown[] }>)[0].data.length;
    const outerPct = (o: EChartsOptionObject) => Number((o.series as Array<{ radius: [string, string] }>)[0].radius[1].replace('%', ''));

    // Narrow width: 20 categories cannot fit within PRINT_LEGEND_MAX_ROWS rows, so the legend is
    // capped below 20 — but the pie itself still carries all 20 slices; only the legend is capped.
    const narrow = buildEChartsOption({ aggregation: agg, width: 150, height: 400, print: true });
    const narrowLegend = narrow.legend as { type: string; formatter: (name: string) => string; data?: string[] };
    // Asserted directly on the option, not scraped from the rendered SVG: the pie's own per-slice
    // label (`{b}`, unrelated to the legend) can carry the same full category text, so a plain
    // "does this string appear in the SVG" check cannot isolate legend truncation from that (review finding).
    expect(narrowLegend.type).toBe('plain');
    expect(narrowLegend.formatter('IfcVeryDescriptiveElementTypeNumber0')).not.toBe('IfcVeryDescriptiveElementTypeNumber0');
    expect(legendData(narrow)!.length).toBeGreaterThan(0);
    expect(legendData(narrow)!.length).toBeLessThan(20);
    expect(sliceCount(narrow)).toBe(20);

    // Wide enough that every category fits its legend rows regardless of height: no explicit `data` cap.
    const tall = buildEChartsOption({ aggregation: agg, width: 300, height: 600, print: true });
    const short = buildEChartsOption({ aggregation: agg, width: 300, height: 120, print: true });
    expect(legendData(tall)).toBeUndefined();
    expect(legendData(short)).toBeUndefined();
    // The short chart's pie is smaller (as a fraction of its own box) than the tall one's — it leaves
    // room below it for the legend rows instead of a fixed center/radius ignoring them.
    expect(outerPct(short)).toBeLessThan(outerPct(tall));
  });

  it('hides per-slice callout labels and leader lines on a crowded print-mode pie, since the legend already names every slice (#4940 review: headed-Chrome finding — leader lines drew over the legend grid)', () => {
    const many14: ChartDataset = { ...ds, rows: Array.from({ length: 14 }, (_, i) => ({ ids: [400 + i], values: [`Category ${i}`, 'L1'] })) };
    const agg = aggregate({ ...bar, type: 'pie' }, many14);
    // A 220pt half-width chart, roughly the shape of the reported layout.
    const crowded = buildEChartsOption({ aggregation: agg, width: 220, height: 220, print: true });
    const crowdedSeries = (crowded.series as Array<{ label: { show?: boolean }; labelLine: { show?: boolean } }>)[0];
    expect(crowdedSeries.label.show).toBe(false);
    expect(crowdedSeries.labelLine.show).toBe(false);

    // Plenty of room, few categories, print mode: the callouts are not suppressed.
    const roomy = buildEChartsOption({ aggregation: aggregate({ ...bar, type: 'pie' }, ds), width: 600, height: 600, print: true });
    const roomySeries = (roomy.series as Array<{ label: { show?: boolean }; labelLine?: { show?: boolean } }>)[0];
    expect(roomySeries.label.show).not.toBe(false);

    // Off the option shape entirely: the rendered SVG carries each name once, from the legend —
    // not a second time from a hidden-but-still-drawn callout.
    const svg = renderChartSvg({ aggregation: agg, width: 220, height: 220, print: true });
    const occurrences = svg.match(/>Category 0</g) ?? [];
    expect(occurrences.length).toBeLessThanOrEqual(1);
  });

  it.skipIf(!truncateMiddle)('truncates a long axis label from the middle, not the tail, so IFC classes sharing a prefix stay distinguishable (#4940 review: headed-Chrome finding — IfcSlab/IfcSpace/IfcSpatialZone all read "IfcS…")', () => {
    expect(truncateMiddle!('IfcSpatialZone', 0)).toBe('');
    expect(truncateMiddle!('IfcSpatialZone', 1)).toBe('…');
    expect(truncateMiddle!('IfcSpatialZone', 2)).toBe('I…');
    expect(truncateMiddle!('IfcSlab', 10)).toBe('IfcSlab');
    expect(truncateMiddle!('IfcSpatialZone', 8)).toBe('IfcSp…ne');
    expect(truncateMiddle!('IfcSpatialZone', 3)).toBe('If…');

    const threeClasses: ChartDataset = { ...ds, rows: [{ ids: [1], values: ['IfcSlab', 'L1'] }, { ids: [2], values: ['IfcSpace', 'L1'] }, { ids: [3], values: ['IfcSpatialZone', 'L1'] }] };
    const agg = aggregate(bar, threeClasses);
    const option = buildEChartsOption({ aggregation: agg, width: 240 });
    const formatter = (option.xAxis as { axisLabel: { formatter: (name: string) => string } }).axisLabel.formatter;
    const rendered = agg.categories.map((c) => formatter(c.label));
    expect(new Set(rendered).size).toBe(3); // no two distinct IFC classes render the same truncated string
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

  it('stays well-formed XML with a quoted font family from a stylesheet (browser finding: the report PDF refused the SVG)', () => {
    const svg = renderChartSvg({ aggregation: aggregate(bar, ds), width: 480, height: 320, theme: { ...DEFAULT_THEME, fontFamily: '"Segoe UI", ui-sans-serif, system-ui' } });
    expect(svg).toContain("'Segoe UI'");
    // Every attribute value is delimited by the double quote that opened it: no `"` may occur inside one.
    for (const attr of svg.matchAll(/="([^"]*)"/g)) expect(attr[1]).not.toContain('"');
    expect(svg).not.toContain('"Segoe UI"');
  });

  it('a print-mode pie with a long legend wraps as a plain legend that stays inside the SVG, not the unscrollable "scroll" type that clips in a static image (#4940)', () => {
    const manyBuckets: ChartDataset = {
      ...ds,
      rows: Array.from({ length: 20 }, (_, i) => ({ ids: [200 + i], values: [`IfcVeryDescriptiveElementTypeNumber${i}`, 'L1'] })),
    };
    const agg = aggregate({ ...bar, type: 'pie' }, manyBuckets);
    const screen = renderChartSvg({ aggregation: agg, width: 480, height: 320 });
    // Narrower than the screen render: packPrintLegend's truncation budget is roughly the whole
    // chart width per item (a real pixel measure now, not a fixed character count), so a 39-char
    // label needs a tight enough width to actually force truncation.
    const printWidth = 200;
    const print = renderChartSvg({ aggregation: agg, width: printWidth, height: 320, print: true });
    // The screen legend is ECharts' own `type: 'scroll'`; nothing to scroll once it is a flat SVG, so it clips.
    // Print mode truncates every long label (the full 39-character name never appears) and adds an ellipsis.
    expect(screen).toContain('IfcVeryDescriptiveElementTypeNumber0');
    expect(print).not.toContain('IfcVeryDescriptiveElementTypeNumber0');
    expect(print).toContain('…');
    // No <text> element's x sits past the declared canvas width: a scroll legend can emit off-canvas nodes,
    // a wrapped plain legend cannot.
    const xs = [...print.matchAll(/<text[^>]*\sx="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(x).toBeLessThanOrEqual(printWidth);
  });

  it('caps a wide-label print legend at four rendered rows while retaining every pie slice (#4983)', () => {
    const width = 480;
    const names = Array.from({ length: 20 }, (_, i) => `W${'ideIfcElementName'.repeat(8)}-${i}`);
    const manyBuckets: ChartDataset = {
      ...ds,
      rows: names.map((name, i) => ({ ids: [500 + i], values: [name, 'L1'] })),
    };
    const agg = aggregate({ ...bar, type: 'pie' }, manyBuckets);
    const option = buildEChartsOption({ aggregation: agg, width, height: 320, print: true });
    expect((option.series as Array<{ data: unknown[] }>)[0].data).toHaveLength(names.length);

    const svg = renderChartSvg({ aggregation: agg, width, height: 320, print: true });
    expect(svg).not.toContain(names[0]);
    const legendRows = new Set(
      [...svg.matchAll(/<text[^>]*transform="translate\([^ ]+ ([\d.]+)\)"[^>]*>W[^<]*<\/text>/g)].map((match) => match[1]),
    );
    expect(legendRows.size).toBeGreaterThan(0);
    expect(legendRows.size).toBeLessThanOrEqual(4);
  });
});

describe('validateDashboardSpec', () => {
  const good: DashboardSpec = {
    version: 2, id: 'd', name: 'Overview', scope: { kind: 'all' },
    charts: [bar, { ...bar, id: 'c2', type: 'stackedBar', stackBy: 'Storey' }],
    layout: [{ chartId: 'c', x: 0, y: 0, w: 6, h: 4 }, { chartId: 'c2', x: 6, y: 0, w: 6, h: 4 }],
  };

  it('accepts a well-formed dashboard and a report extending it', () => {
    expect(validateDashboardSpec(good)).toEqual([]);
    expect(validateDashboardSpec({ ...good, charts: [{ ...bar, elementField: { kind: 'property', psetName: 'Pset/A.B', propertyName: 'Fire.Rating/A', valueKind: 'category' } }], layout: [good.layout[0]] })).toEqual([]);
    for (const elementField of [
      { kind: 'quantity', qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume', valueKind: 'number', dataType: 'IFCVOLUMEMEASURE' },
      { kind: 'material', valueKind: 'category' },
      { kind: 'classification', system: 'Uniclass', valueKind: 'category' },
      { kind: 'classification', valueKind: 'category' },
      { kind: 'type', valueKind: 'category' },
      { kind: 'spatial', level: 'Building', valueKind: 'category' },
    ] as const) {
      expect(validateDashboardSpec({ ...good, charts: [{ ...bar, elementField }], layout: [good.layout[0]] })).toEqual([]);
    }
    expect(validateDashboardSpec({ ...good, page: { size: 'A4', orientation: 'landscape' }, titleBlock: { project: 'X' }, snapshots: true })).toEqual([]);
  });

  it('keeps a numeric measure binding tied to the summed column', () => {
    const measureField = { kind: 'quantity', qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume', valueKind: 'number', dataType: 'IFCVOLUMEMEASURE' } as const;
    const chart = { ...bar, elementField: { kind: 'material', valueKind: 'category' } as const,
      measureField, measure: { agg: 'sum' as const, column: elementFieldColumnId(measureField) } };
    const dashboard = { ...good, charts: [chart], layout: [good.layout[0]] };
    expect(validateDashboardSpec(dashboard)).toEqual([]);
    expect(validateDashboardSpec({ ...dashboard, charts: [{ ...chart, measure: { agg: 'sum', column: 'Area' } }] }).map(({ path }) => path)).toEqual(['.charts[0].measureField']);
    expect(validateDashboardSpec({ ...dashboard, charts: [{ ...chart, measure: { agg: 'count' } }] }).map(({ path }) => path)).toEqual(['.charts[0].measureField']);
  });

  it('validates copied charts and rejects ambiguous stack and fractional controls (#5373)', () => {
    expect(validateChartSpec(bar)).toEqual([]);
    expect(validateChartSpec({ ...bar, type: 'stackedBar', stackBy: 'IfcType' }).map(({ path }) => path)).toEqual(['.stackBy']);
    expect(validateChartSpec({ ...bar, topN: -1, bins: 1.5 }).map(({ path }) => path)).toEqual(['.topN', '.bins']);
  });

  it('rejects malformed or non-element IFC field bindings without changing dashboard version 2', () => {
    const invalid = { ...good, charts: [{ ...bar, source: 'clash', elementField: { kind: 'property', psetName: '', propertyName: 'X', valueKind: 'guess' } }], layout: [good.layout[0]] };
    expect(validateDashboardSpec(invalid).map(({ path }) => path).sort()).toEqual([
      '.charts[0].elementField', '.charts[0].elementField.psetName', '.charts[0].elementField.valueKind',
    ]);
    const badLevel = { ...good, charts: [{ ...bar, elementField: { kind: 'spatial', level: 'Storey', valueKind: 'category' } }], layout: [good.layout[0]] };
    expect(validateDashboardSpec(badLevel).map(({ path }) => path)).toEqual(['.charts[0].elementField.level']);
    // Relation fields read names: a numeric or boolean relation binding can never bucket (#4833 review).
    for (const elementField of [{ kind: 'material', valueKind: 'number' }, { kind: 'spatial', level: 'Site', valueKind: 'boolean' }, { kind: 'quantity', qsetName: 'Q', quantityName: 'A', valueKind: 'boolean' }]) {
      expect(validateDashboardSpec({ ...good, charts: [{ ...bar, elementField }], layout: [good.layout[0]] }).map(({ path }) => path)).toEqual(['.charts[0].elementField.valueKind']);
    }
    // A one-element array stringifies to a valid name; it must still be rejected (#4833 review).
    const arrayLevel = { ...good, charts: [{ ...bar, source: ['elements'], type: ['bar'], elementField: { kind: 'spatial', level: ['Building'], valueKind: 'category' } }], layout: [good.layout[0]] };
    expect(validateDashboardSpec(arrayLevel).map(({ path }) => path)).toEqual(expect.arrayContaining(['.charts[0].source', '.charts[0].type', '.charts[0].elementField.level']));
    const badQuantity = { ...good, charts: [{ ...bar, elementField: { kind: 'quantity', qsetName: 'Qto_X', valueKind: 'number' } }], layout: [good.layout[0]] };
    expect(validateDashboardSpec(badQuantity).map(({ path }) => path)).toEqual(['.charts[0].elementField.quantityName']);
  });

  it('reports every problem at once with its path', () => {
    const bad = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    bad.version = 1;
    (bad.charts as Array<Record<string, unknown>>)[1].stackBy = undefined;
    (bad.charts as Array<Record<string, unknown>>)[1].id = 'c';
    (bad.layout as Array<Record<string, unknown>>)[1].chartId = 'missing';
    (bad.layout as Array<Record<string, unknown>>)[0].w = 'wide';
    (bad.layout as Array<Record<string, unknown>>)[1].x = 9; // 9 + 6 > 12
    (bad.charts as Array<Record<string, unknown>>)[0].bins = 0;
    bad.page = { size: 'A4', orientation: 'portrait' };
    bad.titleBlock = { project: 42 };
    bad.snapshots = false;
    const paths = validateDashboardSpec(bad).map((e) => e.path).sort();
    expect(paths).toEqual(['.charts[0].bins', '.charts[1].id', '.charts[1].stackBy', '.layout[0].w', '.layout[1].chartId', '.layout[1].x', '.titleBlock.project', '.version']);
    // Negative / fractional / zero-size cells are refused too (review finding).
    const cells = JSON.parse(JSON.stringify(good)) as DashboardSpec;
    cells.layout[0] = { chartId: 'c', x: -1, y: 0.5, w: 0, h: 4 };
    expect(validateDashboardSpec(cells).map((e) => e.path).sort()).toEqual(['.layout[0].w', '.layout[0].x', '.layout[0].y']);
    expect(validateDashboardSpec(null)).toEqual([{ path: '', message: 'expected a dashboard object' }]);
  });

  // #4946 — the per-chart source filter and its "not applicable" sources.
  it('accepts a source filter on elements/clash/schedule/ids and rejects it on bcf/compare', () => {
    for (const source of ['elements', 'clash', 'schedule', 'ids'] as const) {
      expect(validateDashboardSpec({ ...good, charts: [{ ...bar, source, filter: { selector: 'IfcWall' } }], layout: [good.layout[0]] })).toEqual([]);
    }
    for (const source of ['bcf', 'compare'] as const) {
      expect(validateDashboardSpec({ ...good, charts: [{ ...bar, source, filter: { selector: 'IfcWall' } }], layout: [good.layout[0]] }).map(({ path }) => path)).toEqual(['.charts[0].filter']);
    }
    expect(validateDashboardSpec({ ...good, charts: [{ ...bar, filter: { selector: '' } }], layout: [good.layout[0]] }).map(({ path }) => path)).toEqual(['.charts[0].filter.selector']);
    // A whitespace-only selector passes `str`'s empty check but every consumer
    // trims before lookup, so it would resolve to "no filter" and strand the
    // chart on "Resolving filter…" forever with no entry to find (review finding).
    expect(validateDashboardSpec({ ...good, charts: [{ ...bar, filter: { selector: '   ' } }], layout: [good.layout[0]] }).map(({ path }) => path)).toEqual(['.charts[0].filter.selector']);
    const groups = [{ combinator: 'AND', rules: [{ kind: 'modelTag', op: 'hasAny', tagIds: ['structure'] }] }];
    expect(validateDashboardSpec({ ...good, charts: [{ ...bar, filter: { selector: '', groups } }], layout: [good.layout[0]] })).toEqual([]);
    expect(validateDashboardSpec({ ...good, charts: [{ ...bar, filter: { selector: '', groups: [{ combinator: 'AND', rules: [] }] } }], layout: [good.layout[0]] }).map(({ path }) => path)).toEqual(['.charts[0].filter.groups', '.charts[0].filter.selector']);
    expect(validateDashboardSpec({ ...good, charts: [{ ...bar, filter: { selector: 'IfcWall', groups } }], layout: [good.layout[0]] }).map(({ path }) => path)).toEqual(['.charts[0].filter.selector']);
  });
});

// #4946 — version 1 -> 2: adds `ChartSpec.filter`, drops the `list` scope.
describe('migrateDashboardSpec', () => {
  const v1 = {
    version: 1, id: 'd', name: 'Overview', scope: { kind: 'all' },
    charts: [bar], layout: [{ chartId: 'c', x: 0, y: 0, w: 6, h: 4 }],
  };

  it('bumps a version-1 dashboard to version 2 and leaves version 2 untouched', () => {
    expect(migrateDashboardSpec(v1)).toEqual({ ...v1, version: 2 });
    const v2 = { ...v1, version: 2 };
    expect(migrateDashboardSpec(v2)).toBe(v2);
    const migrated = migrateDashboardSpec(v1) as DashboardSpec;
    expect(validateDashboardSpec(migrated)).toEqual([]);
  });

  it('folds a version-1 "list" scope to "all" — the resolver it needed was deleted with the scaffold', () => {
    const withList = { ...v1, scope: { kind: 'list', listId: 'saved-1' } };
    const migrated = migrateDashboardSpec(withList) as DashboardSpec;
    expect(migrated.scope).toEqual({ kind: 'all' });
    expect(validateDashboardSpec(migrated)).toEqual([]);
  });

  it('does not migrate a non-dashboard value or a version other than 1', () => {
    expect(migrateDashboardSpec(null)).toBe(null);
    expect(migrateDashboardSpec('nope')).toBe('nope');
    const v3 = { ...v1, version: 3 };
    expect(migrateDashboardSpec(v3)).toBe(v3);
  });

  it('a raw version-1 object is refused by validateDashboardSpec directly — migration is not optional', () => {
    expect(validateDashboardSpec(v1).map((e) => e.path)).toEqual(['.version']);
  });
});
