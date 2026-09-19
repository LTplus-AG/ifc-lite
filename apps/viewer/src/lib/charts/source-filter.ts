/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A chart's own source filter (#4946): selector text, read the SAME way the
 * search Filter tab reads it (`readSelector`) and run through the SAME
 * evaluator every other selector-driven feature runs
 * (`evaluateFilterRulesFederated`), exactly as `lib/clash/set-filter-resolve.ts`
 * does for a clash set filter. There is deliberately no second matcher for
 * charts to drift from the first.
 *
 * `readChartFilter` applies the chart's all-or-nothing reading rule: a
 * parse error, a reading with no rules, or ANY unsupported construct is
 * refused outright rather than run on the readable remainder — a chart that
 * silently narrowed to what it could read would be the #4091 defect class
 * over again, just one field over. `resolveChartFilter` runs a refused
 * reading's message as a thrown `Error`, which is what the resolution hook
 * (`useChartSourceFilters`) turns into the card's error state.
 */
import { readSelector } from '@/lib/search/selector-to-rules';
import { evaluateFilterRulesFederated, type EvaluatorModel } from '@/lib/search/filter-evaluate';
import type { Combinator, FilterRule } from '@/lib/search/filter-rules';
import { describeSelectorParseError } from '@/components/viewer/SearchModal.filter.feedback';
import type { ChartDataset, ChartDatasetRow, ChartSourceFilter } from '@ifc-lite/charts';

export type ChartFilterReading =
  | { ok: true; rules: FilterRule[]; combinator: Combinator }
  | { ok: false; message: string };

/** Read + adapt selector text with the chart's refuse-don't-narrow rule.
 *  `text` is trimmed; an all-whitespace string is never passed in by a
 *  caller (both the editor and the resolver skip an empty filter). */
export function readChartFilter(text: string, options: { schemaVersion?: string } = {}): ChartFilterReading {
  const query = text.trim();
  const reading = readSelector(query, options);
  if (!reading.ok) return { ok: false, message: describeSelectorParseError(query, reading.error) };
  if (reading.rules.length === 0) {
    return {
      ok: false,
      message: `Nothing in this selector maps to a filter rule${reading.unsupported.length > 0 ? `: ${reading.unsupported.join('; ')}` : ''}.`,
    };
  }
  if (reading.unsupported.length > 0) {
    return {
      ok: false,
      message: `Refused rather than run on the readable part alone: ${reading.unsupported.join('; ')}.`,
    };
  }
  return { ok: true, rules: reading.rules, combinator: reading.combinator };
}

export interface ResolveChartFilterOptions {
  schemaVersion?: string;
  definedModelTagIds?: ReadonlySet<string>;
  /** Largest match count the evaluator is allowed to return before it stops
   *  scanning; callers pass the federation's element count so a filter that
   *  matches everything is never silently truncated. */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Resolve one chart's `filter` to the renderer (federated) global ids it
 * matches. `undefined` / blank selector text resolves to `null` — "no
 * filter" — which `applyChartFilter` must tell apart from an empty `Set`
 * ("matched nothing"): rounding the two together would show unfiltered rows
 * under a filter that matched zero elements.
 *
 * Throws when the reading is refused (see `readChartFilter`); the caller
 * (`useChartSourceFilters`) is expected to catch this into an error state,
 * exactly as `resolveClashSetFilter` does for a clash set filter.
 */
export async function resolveChartFilter(
  models: readonly EvaluatorModel[],
  filter: ChartSourceFilter | undefined,
  toGlobalId: (modelId: string, expressId: number) => number,
  options: ResolveChartFilterOptions = {},
): Promise<Set<number> | null> {
  if (!filter || filter.selector.trim().length === 0) return null;
  const reading = readChartFilter(filter.selector, { schemaVersion: options.schemaVersion });
  if (!reading.ok) throw new Error(reading.message);
  const matched = await evaluateFilterRulesFederated(models, reading.rules, reading.combinator, {
    limit: options.limit,
    signal: options.signal,
    definedModelTagIds: options.definedModelTagIds,
  });
  const ids = new Set<number>();
  for (const m of matched) ids.add(toGlobalId(m.modelId, m.expressId));
  return ids;
}

function rowMatchesAny(rowIds: ArrayLike<number>, ids: ReadonlySet<number>): boolean {
  for (let i = 0; i < rowIds.length; i += 1) if (ids.has(rowIds[i])) return true;
  return false;
}

/**
 * ONE post-filter, shared by every chart source: keep a row if ANY of its
 * ids is in the matched set. For `elements` a row is one element, so this is
 * the same answer as intersecting `includeSets()`; for `clash` ("clashes
 * involving a matched element") and `schedule` (a task's products) it is the
 * any-match reading the plan settled on. Never called for `bcf` / `compare`
 * — `validate.ts` refuses a `filter` on those sources.
 */
export function applyChartFilter(dataset: ChartDataset, ids: ReadonlySet<number>): ChartDataset {
  const rows: ChartDatasetRow[] = dataset.rows.filter((row) => rowMatchesAny(row.ids, ids));
  return { ...dataset, rows, fingerprint: `filtered:${ids.size}:${dataset.fingerprint}` };
}
