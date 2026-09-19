/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolving every chart's `filter` to the elements it matches (#4946).
 * Async, because it runs the federated evaluator; shared by `ChartsPanel`
 * (dashboard cards) and `useDocumentData` (document chart blocks) so a
 * document prints the same filtered numbers the panel shows.
 *
 * Identical selector text resolves ONCE per run, the same dedupe
 * `withResolvedClashSetFilters` uses for a clash set filter: "external
 * walls" as the filter of five charts is one federation scan, not five.
 *
 * Re-runs whenever the federation or a mutation changes; while a run is in
 * flight (or has thrown) every affected chart's state is `resolving` /
 * `error` rather than the STALE previous match — a chart must never show
 * matches computed against a model that has since been reloaded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSpec } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '@/lib/model-tags/evaluator-models';
import { resolveChartFilter } from '@/lib/charts/source-filter';
import { useActiveSchemaVersion } from '../SearchModal.filter.selector.js';

export type ChartSourceFilterState =
  | { status: 'resolving' }
  | { status: 'ok'; ids: ReadonlySet<number> }
  | { status: 'error'; message: string };

/** Keyed by selector TEXT, not chart id: two charts with the same selector
 *  share one entry, so a lookup is `sourceFilters.get(spec.filter?.selector)`. */
export type ChartSourceFilters = ReadonlyMap<string, ChartSourceFilterState>;

const EMPTY: ChartSourceFilters = new Map();

export function useChartSourceFilters(charts: readonly ChartSpec[]): ChartSourceFilters {
  const models = useViewerStore((s) => s.models);
  const modelTags = useViewerStore((s) => s.modelTags);
  const modelTagAssignments = useViewerStore((s) => s.modelTagAssignments);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const schemaVersion = useActiveSchemaVersion();

  const selectors = useMemo(() => {
    const set = new Set<string>();
    for (const chart of charts) {
      const text = chart.filter?.selector.trim();
      if (text) set.add(text);
    }
    return [...set];
  }, [charts]);

  const [state, setState] = useState<ChartSourceFilters>(EMPTY);
  const runId = useRef(0);

  useEffect(() => {
    if (selectors.length === 0) {
      setState((prev) => (prev.size === 0 ? prev : EMPTY));
      return;
    }
    const id = (runId.current += 1);
    setState((prev) => {
      const next = new Map<string, ChartSourceFilterState>();
      for (const text of selectors) next.set(text, prev.get(text) ?? { status: 'resolving' });
      return next;
    });

    const live = useViewerStore.getState();
    const evaluatorModels = evaluatorModelsFromState(live);
    const definedModelTagIds = definedModelTagIdsOf(live);
    // The evaluator's default cap (5,000) exists to bound an UNBOUNDED search;
    // a chart filter has a known, finite universe — every expressId the
    // federation could ever assign — so pass that instead of truncating a
    // federation with more than 5,000 matches (#4946 plan).
    let limit = 0;
    for (const m of live.models.values()) limit += (m.maxExpressId ?? 0) + 1;
    const toGlobalId = (modelId: string, expressId: number): number => toGlobalIdFromModels(live.models, modelId, expressId);

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        selectors.map(async (text): Promise<[string, ChartSourceFilterState]> => {
          try {
            const ids = await resolveChartFilter(evaluatorModels, { selector: text }, toGlobalId, {
              schemaVersion,
              definedModelTagIds,
              limit,
            });
            return [text, { status: 'ok', ids: ids ?? new Set<number>() }];
          } catch (err) {
            return [text, { status: 'error', message: err instanceof Error ? err.message : String(err) }];
          }
        }),
      );
      if (cancelled || runId.current !== id) return;
      setState(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [selectors, models, modelTags, modelTagAssignments, mutationVersion, schemaVersion]);

  return state;
}
