/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What every catalog component reads besides its own props: the viewer host
 * and the follow-up handler. `A2uiSurface` renders implementations inside the
 * app's React tree, so plain context reaches them.
 */

import { createContext, useCallback, useContext, useMemo } from 'react';
import { registerEnglish, useTranslation } from '@/i18n';
import { a2uiEn } from '@/i18n/catalogues/a2ui.en';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import type { A2uiViewerHost } from '@/lib/a2ui/host';
import type { FollowUpHandler } from '@/lib/a2ui/actions';
import type { ChartRenderer } from '@/components/viewer/charts/useEChart';
import { PolicyRefusal, runIfcFunction, resolveTarget, type Target } from '@/lib/a2ui/functions';
import { evaluateQuery, FieldReader, type QueryResult } from '@/lib/a2ui/query-eval';

registerEnglish(a2uiEn);

export interface A2uiRuntime {
  host: A2uiViewerHost;
  onFollowUp?: FollowUpHandler;
}

export const A2uiRuntimeContext = createContext<A2uiRuntime | null>(null);

/** Chart engine for GroupChart; unset means the viewer's lazy ECharts bundle. Tests supply a recorder. */
export const A2uiChartRendererContext = createContext<ChartRenderer | undefined>(undefined);

export function useA2uiRuntime(): A2uiRuntime {
  const runtime = useContext(A2uiRuntimeContext);
  if (!runtime) throw new Error('A2UI components render inside <A2uiRuntimeContext.Provider>');
  return runtime;
}

/** Changes whenever loaded models or their edits change, so bound results recompute. */
export function useModelsVersion(): unknown {
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  return useMemo(() => ({ models, mutationVersion }), [models, mutationVersion]);
}

/** One reader per models version: field caches never outlive the data they read. */
export function useFieldReader(): FieldReader {
  const { host } = useA2uiRuntime();
  const version = useModelsVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the version is the cache key
  return useMemo(() => new FieldReader(host), [host, version]);
}

/** Evaluate a bound query live against the loaded models. */
export function useQueryResult(query: unknown): { result: QueryResult | null; reader: FieldReader } {
  const { host } = useA2uiRuntime();
  const reader = useFieldReader();
  const key = query === undefined ? '' : JSON.stringify(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `query`
  const result = useMemo(() => (query === undefined ? null : evaluateQuery(host, query, reader)), [host, reader, key]);
  return { result, reader };
}

export function useTarget(args: { refs?: unknown; query?: unknown }): Target {
  const { host } = useA2uiRuntime();
  const version = useModelsVersion();
  const key = JSON.stringify([args.refs ?? null, args.query ?? null]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for args
  return useMemo(() => resolveTarget(host, args), [host, version, key]);
}

/**
 * Run an IFC function from a click. The click is the user gesture, so file
 * functions are allowed; refusals and failures are reported, never swallowed.
 */
export function useRunFunction(): (name: string, args: Record<string, unknown>) => void {
  const { host } = useA2uiRuntime();
  const { t } = useTranslation();
  return useCallback((name, args) => {
    try {
      runIfcFunction(host, name, args, { caller: 'renderer', userActivated: true });
    } catch (error) {
      reportActionError(error, t);
    }
  }, [host, t]);
}

type T = ReturnType<typeof useTranslation>['t'];

export function reportActionError(error: unknown, t: T): void {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof PolicyRefusal) toast.error(t('a2ui.action.refused', { reason }));
  else {
    console.error('[a2ui] action failed', error);
    toast.error(t('a2ui.action.failed', { reason }));
  }
}

/** Display a field value: numbers rounded for reading, booleans as words, empty as a dash. */
export function formatValue(value: unknown, noValue: string): string {
  if (value === undefined || value === null || value === '') return noValue;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return noValue;
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  return String(value);
}
