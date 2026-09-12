/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chart data contract (#3944).
 *
 * A chart is bound to a DATASET — rows that each carry the renderer ids of
 * the elements they stand for — and a SPEC that says how to bucket those
 * rows. Aggregation keeps every bucket's member ids, which is what makes the
 * chart bidirectional with the 3D view: a bar is a set of element ids, and a
 * 3D selection is a set of buckets. The chart library only ever sees
 * `(seriesIndex, dataIndex)`; the id math lives here.
 */

export type CellValue = string | number | boolean | null;

/** Where a dataset's rows come from; decides which adapter builds it. */
export type ChartSource = 'elements' | 'clash' | 'bcf' | 'schedule' | 'ids' | 'compare';

export interface ChartDatasetColumn {
  id: string;
  label: string;
  kind: 'category' | 'number' | 'boolean' | 'date';
  /** Display unit for a `number` column (`m²`, `m³`, `mm`), if any. */
  unit?: string;
}

export interface ChartDatasetRow {
  /** Renderer (federated) global ids of the elements this row stands for —
   *  one for an element, two for a clash pair, N for a schedule task. */
  ids: ArrayLike<number>;
  /** One value per dataset column, in column order. */
  values: CellValue[];
}

export interface ChartDataset {
  source: ChartSource;
  columns: ChartDatasetColumn[];
  rows: ChartDatasetRow[];
  /** Changes whenever the rows do; lets a consumer skip re-aggregation. */
  fingerprint: string;
}

export type ChartType = 'bar' | 'stackedBar' | 'pie' | 'treemap' | 'histogram' | 'timeline';

export type ChartAggregate = 'count' | 'sum';

export interface ChartMeasure {
  agg: ChartAggregate;
  /** The `number` column to sum; ignored for `count`. */
  column?: string;
}

export interface ChartSpec {
  id: string;
  title: string;
  source: ChartSource;
  type: ChartType;
  /** Column id to bucket by. A `date` column for `timeline`, a `number` column for `histogram`. */
  dimension: string;
  /** Second category column for `stackedBar`: one series per distinct value. */
  stackBy?: string;
  measure: ChartMeasure;
  /** Bucket order; default `value` (largest first). `label` sorts by label, dates chronologically. */
  sort?: 'value' | 'label';
  /** Keep the first N buckets and fold the rest into one `Other` bucket. */
  topN?: number;
  /** Histogram bin count; Sturges' rule when absent. */
  bins?: number;
}

/** What a dashboard aggregates over; resolved by the host into a dataset scope. */
export type ChartScope =
  | { kind: 'all' }
  | { kind: 'visible' }
  | { kind: 'basket' }
  | { kind: 'list'; listId: string };

export interface DashboardLayoutItem {
  chartId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardSpec {
  version: 1;
  id: string;
  name: string;
  scope: ChartScope;
  charts: ChartSpec[];
  layout: DashboardLayoutItem[];
}

export interface ReportPageSetup {
  size: 'A4' | 'A3';
  orientation: 'portrait' | 'landscape';
}

/** A dashboard plus what a printed report needs: page setup, title-block fields, snapshots. */
export interface ReportSpec extends DashboardSpec {
  page: ReportPageSetup;
  titleBlock: Record<string, string>;
  /** Render a 3D snapshot of each chart's top bucket under it. */
  snapshots: boolean;
}

export interface Bucket {
  /** Stable key: the dimension value (stringified) or a bin/week key. */
  key: string;
  label: string;
  /** The measure: count, or sum of the measure column. */
  value: number;
  /** Rows in the bucket, regardless of measure. */
  count: number;
  /** Renderer global ids of every element in the bucket, de-duplicated. */
  ids: Uint32Array;
  /** Hex colour, stable per label across re-aggregations. */
  color: string;
}

/** One series of buckets — a plain chart has one, a stacked bar one per `stackBy` value. */
export interface BucketSeries {
  key: string;
  label: string;
  buckets: Bucket[];
}

export interface Aggregation {
  spec: ChartSpec;
  /** Category axis in display order; every series aligns to it. */
  categories: Bucket[];
  series: BucketSeries[];
  total: number;
  /** Rows the spec could not place (missing dimension value). */
  unbucketed: number;
  /** Element id → index into `categories`. */
  categoryOf: Map<number, number>;
  /** Display unit of the summed column, when the measure is a sum. */
  unit?: string;
}
