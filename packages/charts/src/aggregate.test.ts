/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { LENS_PALETTE } from '@ifc-lite/lens';
import { aggregate, categoriesForIds, idsForCategories, idsForItems, itemsForIds, isoWeekKey, sturgesBins } from './aggregate.js';
import { elementsDataset, ELEMENT_COLUMNS } from './elements-dataset.js';
import { OTHER_BUCKET_COLOR, OTHER_BUCKET_KEY } from './palette.js';
import type { ChartDataset, ChartSpec } from './types.js';

/**
 * Three walls and two doors on two storeys, through the real columnar parser
 * — the storey comes from `IfcRelContainedInSpatialStructure` via the
 * spatial hierarchy, the type from the entity table (#3944).
 */
const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#6=IFCBUILDINGSTOREY('0Storey00000000000006',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5,#6));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall B',$,$,#24,#28,$,$);
#43=IFCWALL('0Wall00000000000000043',$,'Wall C',$,$,#24,#28,$,$);
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
#45=IFCDOOR('0Door00000000000000045',$,'Door B',$,$,#24,#28,$,$,$,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41,#42,#44),#5);
#91=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000091',$,$,$,(#43,#45),#6);
ENDSEC;
END-ISO-10303-21;
`;

async function parsedDataset(idOffset = 0): Promise<ChartDataset> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return elementsDataset([{ store, toGlobalId: (id) => id + idOffset, name: 'mini.ifc' }]);
}

const byType: ChartSpec = { id: 'c1', title: 'Elements by type', source: 'elements', type: 'bar', dimension: ELEMENT_COLUMNS.ifcType, measure: { agg: 'count' } };

describe('elementsDataset on a real parsed store', () => {
  it('two include sets of the same size produce different fingerprints (review finding)', async () => {
    const bytes = new TextEncoder().encode(MINI_IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const a = elementsDataset([{ store, toGlobalId: (id) => id, name: 'm', include: new Set([41, 42]) }]);
    const b = elementsDataset([{ store, toGlobalId: (id) => id, name: 'm', include: new Set([41, 43]) }]);
    expect(a.rows).toHaveLength(2);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('yields one row per element instance with type, storey, model, name and the offset renderer id', async () => {
    const ds = await parsedDataset(1_000_000);
    expect(ds.rows).toHaveLength(5);
    const wallA = ds.rows.find((r) => r.values[3] === 'Wall A');
    expect(wallA).toBeDefined();
    expect(Array.from(wallA!.ids)).toEqual([1_000_041]);
    expect(wallA!.values.slice(0, 3)).toEqual(['IfcWall', 'Level 1', 'mini.ifc']);
    // Storeys, the project, placements and representations are not elements.
    expect(ds.rows.some((r) => r.values[0] === 'IfcBuildingStorey')).toBe(false);
  });

  it('buckets by type with member ids, largest first, and by storey', async () => {
    const ds = await parsedDataset();
    const agg = aggregate(byType, ds);
    expect(agg.categories.map((c) => [c.label, c.value])).toEqual([['IfcWall', 3], ['IfcDoor', 2]]);
    expect([...agg.categories[0].ids].sort()).toEqual([41, 42, 43]);
    expect(agg.total).toBe(5);
    expect(agg.unbucketed).toBe(0);
    // Colours follow the lens palette in rank order.
    expect(agg.categories.map((c) => c.color)).toEqual([LENS_PALETTE[0], LENS_PALETTE[1]]);

    const byStorey = aggregate({ ...byType, id: 'c2', dimension: ELEMENT_COLUMNS.storey, sort: 'label' }, ds);
    expect(byStorey.categories.map((c) => [c.label, c.count])).toEqual([['Level 1', 3], ['Level 2', 2]]);
  });

  it('maps a chart click to element ids and a 3D selection back to full/partial categories', async () => {
    const agg = aggregate(byType, await parsedDataset());
    expect([...idsForCategories(agg, [1])].sort()).toEqual([44, 45]);
    expect(categoriesForIds(agg, [44, 45])).toEqual({ full: [1], partial: [] });
    expect(categoriesForIds(agg, [41, 44, 45, 999])).toEqual({ full: [1], partial: [0] });
  });

  it('a slice restricts the rows — how one chart filters another', async () => {
    const agg = aggregate(byType, await parsedDataset(), { slice: new Set([41, 45]) });
    // Equal values tie-break by label so the order is deterministic.
    expect(agg.categories.map((c) => [c.label, c.count])).toEqual([['IfcDoor', 1], ['IfcWall', 1]]);
    expect(agg.total).toBe(2);
  });

  it('keeps a label\'s colour across re-aggregation when its rank changes', async () => {
    const ds = await parsedDataset();
    const first = aggregate(byType, ds);
    // Slice to doors only: IfcDoor becomes rank 0 but must keep its colour.
    const second = aggregate(byType, ds, { slice: new Set([44, 45]), palette: first.palette });
    expect(second.categories[0].label).toBe('IfcDoor');
    expect(second.categories[0].color).toBe(first.categories[1].color);
  });
});

function dataset(columns: Array<[string, 'category' | 'number' | 'date']>, rows: Array<[number[], Array<string | number | null>]>): ChartDataset {
  return {
    source: 'clash',
    columns: columns.map(([id, kind]) => ({ id, label: id, kind, unit: kind === 'number' ? 'm²' : undefined })),
    rows: rows.map(([ids, values]) => ({ ids, values })),
    fingerprint: 'test',
  };
}

describe('aggregate invariants', () => {
  it('sums a number column with its unit, and counts rows without a dimension value as unbucketed', () => {
    const ds = dataset([['Type', 'category'], ['Area', 'number']], [
      [[1], ['Wall', 10]], [[2], ['Wall', 2.5]], [[3], ['Slab', 7]], [[4], [null, 100]],
    ]);
    const agg = aggregate({ id: 's', title: 'Area by type', source: 'clash', type: 'bar', dimension: 'Type', measure: { agg: 'sum', column: 'Area' } }, ds);
    expect(agg.categories.map((c) => [c.label, c.value, c.count])).toEqual([['Wall', 12.5, 2], ['Slab', 7, 1]]);
    expect(agg.unbucketed).toBe(1);
    expect(agg.unit).toBe('m²');
  });

  it('reports missing sum contributions instead of presenting them as measured zero (#4833)', () => {
    const dataset: ChartDataset = {
      source: 'elements', fingerprint: 'missing-measure',
      columns: [{ id: 'group', label: 'Group', kind: 'category' }, { id: 'value', label: 'Value', kind: 'number', unit: 'm' }],
      rows: [
        { ids: [1], values: ['A', null] },
        { ids: [2], values: ['A', 0] },
        { ids: [3], values: ['B', null] },
      ],
    };
    const result = aggregate({ id: 'sum', title: 'Sum', source: 'elements', type: 'bar', dimension: 'group', measure: { agg: 'sum', column: 'value' } }, dataset);
    expect(result.total).toBe(0);
    expect(result.unmeasured).toBe(2);
    expect(result.categories.map(({ count, value }) => ({ count, value }))).toEqual([{ count: 2, value: 0 }, { count: 1, value: 0 }]);
    expect([...result.categories[0].ids]).toEqual([1, 2]);
  });

  it('reports unsupported scalar contributions separately from missing (#4833)', () => {
    const dataset: ChartDataset = {
      source: 'elements', fingerprint: 'unsupported',
      columns: [{ id: 'group', label: 'Group', kind: 'category' }, { id: 'value', label: 'Value', kind: 'number' }],
      rows: [
        { ids: [1], values: ['A', null], statuses: ['value', 'unsupported'] },
        { ids: [2], values: ['A', null], statuses: ['value', 'missing'] },
      ],
    };
    const result = aggregate({ id: 'sum', title: 'Sum', source: 'elements', type: 'bar', dimension: 'group', measure: { agg: 'sum', column: 'value' } }, dataset);
    expect(result.unmeasured).toBe(2);
    expect(result.unsupported).toBe(1);
  });

  it('reports an unsupported stack value instead of hiding it as missing (#4833)', () => {
    const input: ChartDataset = {
      source: 'elements', fingerprint: 'unsupported-stack',
      columns: [{ id: 'group', label: 'Group', kind: 'category' }, { id: 'stack', label: 'Stack', kind: 'category' }],
      rows: [{ ids: [1], values: ['A', null], statuses: ['value', 'unsupported'] }],
    };
    const result = aggregate({ id: 'stack', title: 'Stack', source: 'elements', type: 'stackedBar', dimension: 'group', stackBy: 'stack', measure: { agg: 'count' } }, input);
    expect(result.unsupported).toBe(1);
  });

  it('keeps a real stack category named __missing__ separate from missing values (#5373)', () => {
    const input = dataset([['group', 'category'], ['stack', 'category']], [
      [[1], ['A', '__missing__']], [[2], ['A', null]],
    ]);
    const result = aggregate({ id: 'stack', title: 'Stack', source: 'elements', type: 'stackedBar', dimension: 'group', stackBy: 'stack', measure: { agg: 'count' } }, input);
    expect(result.series.map(({ label, buckets }) => [label, [...buckets[0].ids]])).toEqual([
      ['__missing__', [1]], ['(none)', [2]],
    ]);
  });

  it('rejects a stacked chart when its stack column has disappeared (#5373)', () => {
    const input = dataset([['group', 'category']], [[[1], ['A']]]);
    expect(() => aggregate({ id: 'stack', title: 'Stack', source: 'elements', type: 'stackedBar', dimension: 'group', stackBy: 'removed', measure: { agg: 'count' } }, input))
      .toThrow('stack column "removed" is not in the dataset');
  });

  it('folds the tail past topN into a grey Other bucket that still carries every id', () => {
    const ds = dataset([['T', 'category']], [[[1], ['a']], [[2], ['a']], [[3], ['b']], [[4], ['c']], [[5], ['d']]]);
    const agg = aggregate({ id: 't', title: 't', source: 'clash', type: 'pie', dimension: 'T', measure: { agg: 'count' }, topN: 2 }, ds);
    expect(agg.categories.map((c) => c.label)).toEqual(['a', 'b', 'Other']);
    const other = agg.categories[2];
    expect(other.key).toBe(OTHER_BUCKET_KEY);
    expect(other.isOther).toBe(true);
    expect(other.color).toBe(OTHER_BUCKET_COLOR);
    expect([...other.ids].sort()).toEqual([4, 5]);
    expect(agg.categoryOf.get(5)).toEqual([2]);
  });

  it('a pair row (clash) puts both ids in the bucket, de-duplicates across rows, and an element under two rules maps back to both', () => {
    const ds = dataset([['Rule', 'category']], [[[10, 20], ['r1']], [[20, 30], ['r1']], [[20, 40], ['r2']]]);
    const agg = aggregate({ id: 'p', title: 'p', source: 'clash', type: 'bar', dimension: 'Rule', measure: { agg: 'count' } }, ds);
    expect(agg.categories[0].count).toBe(2);
    expect([...agg.categories[0].ids].sort()).toEqual([10, 20, 30]);
    // Element 20 is in r1 and r2 (review finding): selecting it in 3D touches both buckets.
    expect(agg.categoryOf.get(20)).toEqual([0, 1]);
    expect(categoriesForIds(agg, [20])).toEqual({ full: [], partial: [0, 1] });
    expect(categoriesForIds(agg, [20, 40])).toEqual({ full: [1], partial: [0] });
  });

  it('a real dimension value spelled like the Other sentinel stays a real bucket (review finding)', () => {
    const ds = dataset([['S', 'category'], ['T', 'category']], [[[1], ['L1', '__other__']], [[2], ['L1', '__other__']], [[3], ['L1', 'b']], [[4], ['L1', 'c']], [[5], ['L2', 'd']]]);
    const agg = aggregate({ id: 'o', title: 'o', source: 'clash', type: 'stackedBar', dimension: 'T', stackBy: 'S', measure: { agg: 'count' }, topN: 1 }, ds);
    expect(agg.categories.map((c) => [c.label, c.count])).toEqual([['__other__', 2], ['Other', 3]]);
    expect(agg.series.find((s) => s.label === 'L1')!.buckets.map((b) => b.count)).toEqual([2, 2]);
    expect(agg.series.find((s) => s.label === 'L2')!.buckets.map((b) => b.count)).toEqual([0, 1]);
    // And on a plain chart the real value keeps a palette colour, only the synthetic tail is grey.
    const plain = aggregate({ id: 'o2', title: 'o', source: 'clash', type: 'bar', dimension: 'T', measure: { agg: 'count' }, topN: 1 }, ds);
    expect(plain.categories[0].color).not.toBe(OTHER_BUCKET_COLOR);
    expect(plain.categories[0].isOther).toBeUndefined();
    expect(plain.categories[1].color).toBe(OTHER_BUCKET_COLOR);
    expect(plain.categories[1].isOther).toBe(true);
  });

  it('clamps a non-positive bin count instead of producing negative bins', () => {
    const ds = dataset([['D', 'number']], [[[1], [0]], [[2], [5]]]);
    const agg = aggregate({ id: 'b', title: 'b', source: 'clash', type: 'histogram', dimension: 'D', measure: { agg: 'count' }, bins: 0 }, ds);
    expect(agg.categories.map((c) => [c.label, c.count])).toEqual([['0–5', 2]]);
  });

  it('stacks a second category into aligned series with per-series colour', () => {
    const ds = dataset([['Storey', 'category'], ['Status', 'category']], [
      [[1], ['L1', 'open']], [[2], ['L1', 'open']], [[3], ['L1', 'resolved']], [[4], ['L2', 'open']],
    ]);
    const agg = aggregate({ id: 'st', title: 'st', source: 'clash', type: 'stackedBar', dimension: 'Storey', stackBy: 'Status', measure: { agg: 'count' } }, ds);
    expect(agg.categories.map((c) => c.label)).toEqual(['L1', 'L2']);
    expect(agg.series.map((s) => s.label)).toEqual(['open', 'resolved']);
    expect(agg.series[0].buckets.map((b) => b.value)).toEqual([2, 1]);
    expect(agg.series[1].buckets.map((b) => b.value)).toEqual([1, 0]);
    expect(agg.series[0].buckets[0].color).toBe(agg.series[0].buckets[1].color);
    expect(agg.series[0].buckets[0].color).not.toBe(agg.series[1].buckets[0].color);
    // A stacked SEGMENT selects only its own series' share of the category (review finding).
    expect([...idsForItems(agg, [{ seriesIndex: 1, dataIndex: 0 }])]).toEqual([3]);
    expect([...idsForItems(agg, [{ seriesIndex: 0, dataIndex: 0 }])].sort()).toEqual([1, 2]);
    expect(itemsForIds(agg, [3])).toEqual({ full: [{ seriesIndex: 1, dataIndex: 0 }], partial: [] });
    expect(itemsForIds(agg, [1])).toEqual({ full: [], partial: [{ seriesIndex: 0, dataIndex: 0 }] });
  });

  it('bins a number column into a histogram whose last bin includes the max', () => {
    const ds = dataset([['Depth', 'number']], [[[1], [0]], [[2], [0.25]], [[3], [0.5]], [[4], [0.75]], [[5], [1]]]);
    const agg = aggregate({ id: 'h', title: 'h', source: 'clash', type: 'histogram', dimension: 'Depth', measure: { agg: 'count' }, bins: 4 }, ds);
    expect(agg.categories.map((c) => [c.label, c.count])).toEqual([['0–0.25', 1], ['0.25–0.50', 1], ['0.50–0.75', 1], ['0.75–1', 2]]);
    expect(sturgesBins(100)).toBe(8);
  });

  it('buckets dates into ISO weeks in chronological order', () => {
    const ds = dataset([['Created', 'date']], [
      [[1], ['2026-09-08']], [[2], ['2026-09-13']], [[3], ['2026-09-01']], [[4], ['not a date']],
    ]);
    const agg = aggregate({ id: 'w', title: 'w', source: 'bcf', type: 'timeline', dimension: 'Created', measure: { agg: 'count' } }, ds);
    expect(agg.categories.map((c) => [c.label, c.count])).toEqual([['2026-W36', 1], ['2026-W37', 2]]);
    expect(agg.unbucketed).toBe(1);
    // ISO week 1 of 2027 starts on Monday 2027-01-04; the 3rd is still 2026-W53.
    expect(isoWeekKey(Date.UTC(2027, 0, 3))).toBe('2026-W53');
    expect(isoWeekKey(Date.UTC(2027, 0, 4))).toBe('2027-W01');
  });

  it('refuses a dimension or measure column the dataset does not have', () => {
    const ds = dataset([['T', 'category']], [[[1], ['a']]]);
    expect(() => aggregate({ id: 'x', title: 'x', source: 'clash', type: 'bar', dimension: 'Nope', measure: { agg: 'count' } }, ds)).toThrow(/dimension column "Nope"/);
    expect(() => aggregate({ id: 'x', title: 'x', source: 'clash', type: 'bar', dimension: 'T', measure: { agg: 'sum', column: 'Nope' } }, ds)).toThrow(/measure column "Nope"/);
  });

  it('creates a single bucket for elementCount, counting all elements', async () => {
    const ds = await parsedDataset();
    const agg = aggregate({ id: 'ec', title: 'All Elements', source: 'elements', type: 'elementCount', measure: { agg: 'count' } }, ds);
    expect(agg.categories).toHaveLength(1);
    expect(agg.categories[0].label).toBe('Total');
    expect(agg.categories[0].count).toBe(5);
    expect(agg.categories[0].value).toBe(5);
    expect([...agg.categories[0].ids].sort()).toEqual([41, 42, 43, 44, 45]);
    expect(agg.total).toBe(5);
    expect(agg.unbucketed).toBe(0);
    expect(agg.series).toHaveLength(1);
    expect(agg.series[0].buckets).toHaveLength(1);
  });

  it('elementCount respects the slice option to count only selected elements', async () => {
    const ds = await parsedDataset();
    const selectedIds = new Set([41, 42, 44]);
    const agg = aggregate({ id: 'ec', title: 'Selected', source: 'elements', type: 'elementCount', measure: { agg: 'count' } }, ds, { slice: selectedIds });
    expect(agg.categories[0].count).toBe(3);
    expect([...agg.categories[0].ids].sort()).toEqual([41, 42, 44]);
  });

  // Regression (#5151): a chart switched from a sum-measured type (e.g. a
  // bar chart summing "Area") to elementCount used to keep the stale
  // `{ agg: 'sum', column }` measure — nothing normalized it away before it
  // reached `aggregate()`. The elementCount branch read `spec.measure.agg`
  // and only counted a row when it was literally `'count'`, so every row
  // added zero and a five-row dataset displayed as a Total of 0 even though
  // `count`/`ids` still reported 5 correctly. This is the "adds zero"
  // failure the maintainer review named; `aggregate()` must ignore
  // `measure` entirely for elementCount, so no caller — editor or library —
  // can reproduce it by constructing this spec directly.
  it('elementCount ignores a stale non-count measure instead of adding zero for every row', () => {
    const ds = dataset([['Type', 'category'], ['Area', 'number']], [
      [[1], ['Wall', 10]], [[2], ['Wall', 2.5]], [[3], ['Slab', 7]], [[4], ['Slab', 4]], [[5], ['Door', 1]],
    ]);
    const staleMeasure: ChartSpec = { id: 'ec', title: 'Total', source: 'elements', type: 'elementCount', measure: { agg: 'sum', column: 'Area' } };
    const agg = aggregate(staleMeasure, ds);
    expect(agg.total).toBe(5);
    expect(agg.categories[0].value).toBe(5);
    expect(agg.categories[0].count).toBe(5);
  });

  // Regression (#5151): `Bucket.count` is documented ("Rows in the bucket,
  // regardless of measure") and every other path keeps `count` as a ROW
  // count (`acc.count += 1`), independent from `value`/`ids.size`. The
  // elementCount branch instead set `count: ids.size` — a DEDUPLICATED
  // element-id count — while `value`/`total` stayed a row count. Two rows
  // that carry the same element id (e.g. two schedule tasks touching one
  // element) make row count and unique-id count genuinely diverge: 3 rows,
  // 2 unique ids.
  it('elementCount keeps count as a row count, not a unique-id count, when rows share an id', () => {
    const ds = dataset([['Type', 'category']], [
      [[1], ['Wall']],
      [[1], ['Wall']], // same element id as row 1 — a second task/row referencing it
      [[2], ['Door']],
    ]);
    const spec: ChartSpec = { id: 'ec', title: 'Total', source: 'elements', type: 'elementCount', measure: { agg: 'count' } };
    const agg = aggregate(spec, ds);
    expect(agg.total).toBe(3);
    expect(agg.categories[0].value).toBe(3);
    expect(agg.categories[0].count).toBe(3); // rows, not the 2 unique ids
    expect([...agg.categories[0].ids].sort()).toEqual([1, 2]);
  });
});
