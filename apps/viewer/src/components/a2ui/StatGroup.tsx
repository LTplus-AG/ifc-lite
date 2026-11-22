/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StatGroup: KPI tiles. Each number is a count / sum / avg / min / max over a
 * live query, or a number a script bound into the data model. Never a literal.
 */

import { useMemo } from 'react';
import { createComponentImplementation } from '@a2ui/react';
import { StatGroupApi } from '@ifc-lite/a2ui/catalog';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { A2uiViewerHost } from '@/lib/a2ui/host';
import { aggregate, aggregatePool, evaluateQuery, type Aggregate, type FieldReader, type QueryResult } from '@/lib/a2ui/query-eval';
import { weightStyle } from './basic-layout';
import { ResultNotes, toneClass } from './notes';
import { formatValue, useA2uiRuntime, useFieldReader } from './runtime';

interface StatItem {
  label?: unknown;
  query?: unknown;
  aggregate?: Aggregate;
  path?: string;
  value?: unknown;
  unit?: string;
  tone?: string;
}

export interface StatValue {
  value: number | undefined;
  result: QueryResult | null;
}

export function statValue(host: A2uiViewerHost, reader: FieldReader, item: StatItem): StatValue {
  if (typeof item.value === 'number') return { value: item.value, result: null };
  if (item.query === undefined) return { value: undefined, result: null };
  const result = evaluateQuery(host, item.query, reader);
  if (result.unloadedModel) return { value: undefined, result };
  return { value: aggregate(reader, aggregatePool(result), item.aggregate ?? 'count', item.path), result };
}

export const StatGroupImpl = createComponentImplementation(StatGroupApi, ({ props }) => {
  const { t } = useTranslation();
  const { host } = useA2uiRuntime();
  const reader = useFieldReader();
  const items = (Array.isArray(props.items) ? props.items : []) as StatItem[];
  const key = JSON.stringify(items);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for items
  const computed = useMemo(() => items.map((item) => statValue(host, reader, item)), [host, reader, key]);
  return (
    <div style={weightStyle(props.weight)} className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2">
        {items.map((item, i) => {
          const { value } = computed[i];
          return (
            <div key={i} data-a2ui-stat={i} className={cn('flex flex-col gap-0.5 rounded-md border px-2.5 py-2', toneClass(item.tone))}>
              <span className="text-xs text-muted-foreground">{String(item.label ?? '')}</span>
              <span className="text-lg font-semibold tabular-nums">
                {value === undefined ? t('a2ui.stat.unavailable') : formatValue(value, t('a2ui.noValue'))}
                {value !== undefined && item.unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{item.unit}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {computed.map((c, i) => c.result && (c.result.unloadedModel || c.result.problems.length > 0)
        ? <ResultNotes key={i} result={c.result} shown={c.result.total} />
        : null)}
    </div>
  );
});
