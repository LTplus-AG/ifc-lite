/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One dashboard card's aggregation, outside React (#6833): the card's own
 * source filter, the cross-chart slice it honours, and `aggregate`. The
 * `ChartCard` and the assistant's charts evidence both call these, so the
 * numbers a conversation cites are the numbers the card draws.
 */

import { aggregate, type AggregateResult, type ChartDataset, type ChartSpec, type PaletteAssignment } from '@ifc-lite/charts';
import { applyChartFilter, applyClashRuleFilter, chartElementFilterKey } from './source-filter';

/** Async resolution of a chart's element filter (`useChartSourceFilters`). */
export type ChartFilterResolution =
  | { status: 'resolving' }
  | { status: 'ok'; ids: ReadonlySet<number> }
  | { status: 'error'; message: string };

/** The card's element-filter description, or undefined when it has none (trimmed-empty is none). */
export function chartFilterSelector(spec: ChartSpec): string | undefined {
  if (!chartElementFilterKey(spec.filter)) return undefined;
  return spec.filter?.groups?.length ? `${spec.filter.groups.reduce((sum, group) => sum + group.rules.length, 0)} rules` : spec.filter?.selector;
}

/** Only meaningful on `clash` — `validate.ts` refuses it elsewhere (#5156). */
export function chartClashRule(spec: ChartSpec): string | undefined {
  return spec.source === 'clash' ? spec.filter?.clashRule : undefined;
}

/**
 * The rows a card aggregates. Resolving or erred: an EMPTY dataset, never the
 * unfiltered rows under a filter (#4946) — a card must not show the whole
 * model's numbers while its filter is running, or after it fails.
 */
export function chartCardDataset(spec: ChartSpec, dataset: ChartDataset, filter: ChartFilterResolution | undefined): ChartDataset {
  let result = dataset;
  if (chartFilterSelector(spec)) {
    if (filter?.status !== 'ok') return { ...dataset, rows: [] };
    result = applyChartFilter(result, filter.ids);
  }
  const clashRule = chartClashRule(spec);
  if (clashRule) result = applyClashRuleFilter(result, clashRule);
  return result;
}

/** A chart never filters itself, and a recorded (saved comparison) chart is never sliced. */
export function chartCardSlice(spec: ChartSpec, recorded: boolean, chartSlice: ReadonlySet<number> | null, chartSliceSource: string | null): ReadonlySet<number> | null {
  return recorded || chartSliceSource === spec.id ? null : chartSlice;
}

/** `aggregate` for one card; null (logged) when the spec cannot aggregate its dataset. */
export function chartCardAggregation(spec: ChartSpec, dataset: ChartDataset, slice: ReadonlySet<number> | null, palette?: PaletteAssignment): AggregateResult | null {
  try {
    return aggregate(spec, dataset, { slice, palette });
  } catch (err) {
    console.warn(`[Charts] chart "${spec.title}" cannot aggregate`, err);
    return null;
  }
}
