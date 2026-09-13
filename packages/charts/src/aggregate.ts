/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bucket a dataset by a spec. One typed-array-friendly pass over the rows;
 * no query engine — count/sum by one or two keys over a million
 * dictionary-encoded rows is tens of milliseconds, and keeping the member
 * ids per bucket is what a chart library cannot do for us.
 *
 * `slice` restricts the rows to those whose ids intersect it — that is how
 * one chart's selection re-aggregates every other chart on a dashboard.
 */
import { assignColors, OTHER_BUCKET_COLOR, OTHER_BUCKET_KEY, type PaletteAssignment } from './palette.js';
import type {
  Aggregation,
  Bucket,
  BucketSeries,
  CellValue,
  ChartDataset,
  ChartDatasetRow,
  ChartItem,
  ChartSpec,
} from './types.js';

export interface AggregateOptions {
  /** Only rows with at least one id in the slice count. */
  slice?: ReadonlySet<number> | null;
  /** Colours from the previous aggregation, kept by label. */
  palette?: PaletteAssignment;
}

export interface AggregateResult extends Aggregation {
  palette: PaletteAssignment;
}

const OTHER_LABEL = 'Other';
const MISSING_KEY = '__missing__';

interface Accumulator {
  key: string;
  label: string;
  value: number;
  count: number;
  ids: Set<number>;
  /** Sort helper for `label` order on date/number dimensions. */
  order: number;
  /** The synthetic folded tail — flagged, not keyed, so a real value spelled
   *  like the sentinel can never be mistaken for it. */
  isOther?: true;
}

/**
 * The bucket key + label + sort order for one row's dimension value, or
 * `null` when the row has no usable value. Histograms and timelines bin
 * the raw value; categories use it verbatim.
 */
type Keyer = (value: CellValue) => { key: string; label: string; order: number } | null;

function categoryKeyer(): Keyer {
  return (value) => {
    if (value === null || value === undefined || value === '') return null;
    const label = String(value);
    return { key: label, label, order: 0 };
  };
}

/** ISO week key (`2026-W37`) for a date value; weeks start on Monday. */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  // Shift to the Thursday of this ISO week (UTC), whose year is the ISO year.
  const day = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function timelineKeyer(): Keyer {
  return (value) => {
    if (value === null || value === undefined || value === '') return null;
    const ms = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(ms)) return null;
    const key = isoWeekKey(ms);
    // Order by the Monday of the week so labels sort chronologically.
    const d = new Date(ms);
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
    return { key, label: key, order: monday };
  };
}

/** Sturges' rule, the spreadsheet default: ⌈log2 n⌉ + 1 bins, at least 1. */
export function sturgesBins(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, n))) + 1);
}

function histogramKeyer(rows: readonly ChartDatasetRow[], column: number, bins: number | undefined): Keyer {
  let min = Infinity;
  let max = -Infinity;
  let n = 0;
  for (const row of rows) {
    const v = row.values[column];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    n += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // A saved spec can carry `bins: 0`; a non-positive count would produce
  // negative indices and `-Infinity` labels, so clamp to at least one bin.
  const count = Math.max(1, Math.floor(bins ?? sturgesBins(n)));
  const width = n === 0 || max === min ? 1 : (max - min) / count;
  const format = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    // The max value lands in the last bin, not one past it.
    const index = Math.min(count - 1, Math.floor((value - min) / width));
    const lo = min + index * width;
    const hi = index === count - 1 ? max : lo + width;
    return { key: String(index), label: `${format(lo)}–${format(hi)}`, order: index };
  };
}

function keyerFor(spec: ChartSpec, dataset: ChartDataset, column: number): Keyer {
  if (spec.type === 'histogram') return histogramKeyer(dataset.rows, column, spec.bins);
  if (spec.type === 'timeline') return timelineKeyer();
  return categoryKeyer();
}

function rowInSlice(row: ChartDatasetRow, slice: ReadonlySet<number> | null | undefined): boolean {
  if (!slice) return true;
  const ids = row.ids;
  for (let i = 0; i < ids.length; i++) if (slice.has(ids[i])) return true;
  return false;
}

function measureOf(row: ChartDatasetRow, spec: ChartSpec, measureColumn: number): number {
  if (spec.measure.agg === 'count') return 1;
  const v = row.values[measureColumn];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function orderBuckets(accs: Accumulator[], spec: ChartSpec): Accumulator[] {
  const byLabel = spec.sort === 'label' || spec.type === 'histogram' || spec.type === 'timeline';
  return [...accs].sort((a, b) =>
    byLabel
      ? a.order - b.order || a.label.localeCompare(b.label)
      : b.value - a.value || a.label.localeCompare(b.label),
  );
}

/** Fold everything past `topN` into one `Other` bucket. Never for binned dimensions. */
function applyTopN(accs: Accumulator[], spec: ChartSpec): Accumulator[] {
  if (!spec.topN || spec.topN <= 0 || accs.length <= spec.topN) return accs;
  if (spec.type === 'histogram' || spec.type === 'timeline') return accs;
  const kept = accs.slice(0, spec.topN);
  const other: Accumulator = { key: OTHER_BUCKET_KEY, label: OTHER_LABEL, value: 0, count: 0, ids: new Set(), order: Number.MAX_SAFE_INTEGER, isOther: true };
  for (const acc of accs.slice(spec.topN)) {
    other.value += acc.value;
    other.count += acc.count;
    for (const id of acc.ids) other.ids.add(id);
  }
  kept.push(other);
  return kept;
}

function toBucket(acc: Accumulator, color: string): Bucket {
  return { key: acc.key, label: acc.label, value: acc.value, count: acc.count, ids: Uint32Array.from(acc.ids), color };
}

export function aggregate(spec: ChartSpec, dataset: ChartDataset, options: AggregateOptions = {}): AggregateResult {
  const columnIndex = (id: string | undefined): number => (id ? dataset.columns.findIndex((c) => c.id === id) : -1);
  const dimension = columnIndex(spec.dimension);
  if (dimension < 0) throw new Error(`chart "${spec.id}": dimension column "${spec.dimension}" is not in the dataset`);
  const measureColumn = spec.measure.agg === 'sum' ? columnIndex(spec.measure.column) : -1;
  if (spec.measure.agg === 'sum' && measureColumn < 0) {
    throw new Error(`chart "${spec.id}": measure column "${spec.measure.column ?? ''}" is not in the dataset`);
  }
  const stackColumn = spec.type === 'stackedBar' ? columnIndex(spec.stackBy) : -1;
  const keyer = keyerFor(spec, dataset, dimension);

  // categories: dimension key → accumulator (all series folded together, for ordering + ids)
  const categories = new Map<string, Accumulator>();
  // series: stack key → (dimension key → accumulator)
  const series = new Map<string, { label: string; cells: Map<string, Accumulator> }>();
  let total = 0;
  let unbucketed = 0;

  const bump = (acc: Accumulator, row: ChartDatasetRow, measure: number): void => {
    acc.value += measure;
    acc.count += 1;
    for (let i = 0; i < row.ids.length; i++) acc.ids.add(row.ids[i]);
  };

  for (const row of dataset.rows) {
    if (!rowInSlice(row, options.slice)) continue;
    const keyed = keyer(row.values[dimension]);
    if (!keyed) {
      unbucketed += 1;
      continue;
    }
    const measure = measureOf(row, spec, measureColumn);
    total += measure;
    let cat = categories.get(keyed.key);
    if (!cat) {
      cat = { ...keyed, value: 0, count: 0, ids: new Set() };
      categories.set(keyed.key, cat);
    }
    bump(cat, row, measure);

    if (stackColumn >= 0) {
      const raw = row.values[stackColumn];
      const stackKey = raw === null || raw === undefined || raw === '' ? MISSING_KEY : String(raw);
      let s = series.get(stackKey);
      if (!s) {
        s = { label: stackKey === MISSING_KEY ? '(none)' : stackKey, cells: new Map() };
        series.set(stackKey, s);
      }
      let cell = s.cells.get(keyed.key);
      if (!cell) {
        cell = { ...keyed, value: 0, count: 0, ids: new Set() };
        s.cells.set(keyed.key, cell);
      }
      bump(cell, row, measure);
    }
  }

  const ordered = applyTopN(orderBuckets([...categories.values()], spec), spec);
  const keptKeys = new Set(ordered.filter((o) => !o.isOther).map((o) => o.key));
  const folded = new Set([...categories.keys()].filter((k) => !keptKeys.has(k)));

  // Colours: a stacked bar keys colour by SERIES (the legend), a plain chart by
  // category; the Other bucket always gets the neutral grey.
  const colorLabels = stackColumn >= 0 ? [...series.values()].map((s) => s.label) : ordered.filter((o) => !o.isOther).map((o) => o.label);
  const palette = assignColors(colorLabels, options.palette);
  const colorFor = (acc: Accumulator): string => (acc.isOther ? OTHER_BUCKET_COLOR : palette.colors.get(acc.label) ?? OTHER_BUCKET_COLOR);

  const categoryBuckets = ordered.map((acc) => toBucket(acc, colorFor(acc)));
  // An element can sit in several categories (a clash element under two
  // rules, a task product in two tasks), so the reverse index keeps them all.
  const categoryOf = new Map<number, number[]>();
  categoryBuckets.forEach((bucket, index) => {
    for (let i = 0; i < bucket.ids.length; i++) {
      const id = bucket.ids[i];
      const list = categoryOf.get(id);
      if (list) list.push(index);
      else categoryOf.set(id, [index]);
    }
  });

  let seriesOut: BucketSeries[];
  if (stackColumn >= 0) {
    seriesOut = [...series.entries()].map(([stackKey, s]) => {
      const color = palette.colors.get(s.label) ?? OTHER_BUCKET_COLOR;
      const buckets = ordered.map((cat) => {
        if (cat.isOther) {
          // The Other column of this series: its cells for every folded category.
          const other: Accumulator = { key: OTHER_BUCKET_KEY, label: OTHER_LABEL, value: 0, count: 0, ids: new Set(), order: 0, isOther: true };
          for (const [k, cell] of s.cells) if (folded.has(k)) { other.value += cell.value; other.count += cell.count; for (const id of cell.ids) other.ids.add(id); }
          return toBucket(other, color);
        }
        const cell = s.cells.get(cat.key);
        return cell ? toBucket(cell, color) : { key: cat.key, label: cat.label, value: 0, count: 0, ids: new Uint32Array(0), color };
      });
      return { key: stackKey, label: s.label, buckets };
    });
  } else {
    seriesOut = [{ key: spec.dimension, label: spec.title, buckets: categoryBuckets }];
  }

  const unit = measureColumn >= 0 ? dataset.columns[measureColumn].unit : undefined;
  return { spec, categories: categoryBuckets, series: seriesOut, total, unbucketed, categoryOf, unit, palette };
}

/** The element ids behind a set of category indices — what a chart click selects in 3D. */
export function idsForCategories(aggregation: Aggregation, indices: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const index of indices) {
    const bucket = aggregation.categories[index];
    if (!bucket) continue;
    for (let i = 0; i < bucket.ids.length; i++) out.add(bucket.ids[i]);
  }
  return out;
}

/**
 * The category indices a 3D selection touches, with how much of each bucket
 * is selected — `full` buckets are what a chart marks selected, `partial`
 * ones what it emphasises.
 */
export function categoriesForIds(aggregation: Aggregation, ids: Iterable<number>): { full: number[]; partial: number[] } {
  const hits = new Map<number, number>();
  for (const id of ids) {
    const indices = aggregation.categoryOf.get(id);
    if (!indices) continue;
    for (const index of indices) hits.set(index, (hits.get(index) ?? 0) + 1);
  }
  const full: number[] = [];
  const partial: number[] = [];
  for (const [index, n] of hits) {
    (n >= aggregation.categories[index].ids.length ? full : partial).push(index);
  }
  full.sort((a, b) => a - b);
  partial.sort((a, b) => a - b);
  return { full, partial };
}

/** The element ids behind a set of chart items: a stacked segment selects only its own series' share of the category. */
export function idsForItems(aggregation: Aggregation, items: Iterable<ChartItem>): Set<number> {
  const out = new Set<number>();
  for (const { seriesIndex, dataIndex } of items) {
    const bucket = aggregation.series[seriesIndex]?.buckets[dataIndex];
    if (!bucket) continue;
    for (let i = 0; i < bucket.ids.length; i++) out.add(bucket.ids[i]);
  }
  return out;
}

/**
 * The chart items a 3D selection touches, per series: `full` items have every
 * id selected, `partial` ones some. For a single-series chart this is
 * {@link categoriesForIds} with `seriesIndex: 0`.
 */
export function itemsForIds(aggregation: Aggregation, ids: Iterable<number>): { full: ChartItem[]; partial: ChartItem[] } {
  const selected = ids instanceof Set ? (ids as Set<number>) : new Set(ids);
  const full: ChartItem[] = [];
  const partial: ChartItem[] = [];
  aggregation.series.forEach((series, seriesIndex) => {
    series.buckets.forEach((bucket, dataIndex) => {
      if (bucket.ids.length === 0) return;
      let hits = 0;
      for (let i = 0; i < bucket.ids.length; i++) if (selected.has(bucket.ids[i])) hits += 1;
      if (hits === 0) return;
      (hits === bucket.ids.length ? full : partial).push({ seriesIndex, dataIndex });
    });
  });
  return { full, partial };
}
