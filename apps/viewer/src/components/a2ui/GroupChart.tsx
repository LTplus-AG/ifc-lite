/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GroupChart: bar or pie over a live query grouped by a field path (or over
 * `[{label, value, refs}]` a script bound). Picking a bar, a slice, or the
 * matching button below the chart selects that group in 3D. The buttons make
 * every group reachable from the keyboard and by screen readers.
 */

import { Component, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { createComponentImplementation } from '@a2ui/react';
import { encodeRef } from '@ifc-lite/a2ui';
import { GroupChartApi } from '@ifc-lite/a2ui/catalog';
import type { ChartItem, EChartsOptionObject } from '@ifc-lite/charts';
import { LENS_PALETTE } from '@ifc-lite/lens';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { readChartTheme, useEChart, type ChartSelectEvent } from '@/components/viewer/charts/useEChart';
import { aggregatePool, groupRows } from '@/lib/a2ui/query-eval';
import { weightStyle } from './basic-layout';
import { Note, ResultNotes } from './notes';
import { A2uiChartRendererContext, formatValue, useQueryResult, useRunFunction } from './runtime';

interface ChartGroup {
  label: string;
  value: number;
  refs: string[];
}

const NONE: readonly ChartItem[] = [];

/** A chart that cannot draw (no canvas, a context refusal) costs the chart, not the surface: the group buttons stay. */
class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.warn('[a2ui] chart unavailable', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

function ChartCanvas({ kind, groups, label, onPick }: { kind: 'bar' | 'pie'; groups: ChartGroup[]; label: string; onPick: (group: ChartGroup | undefined) => void }) {
  const chartRenderer = useContext(A2uiChartRendererContext);
  const option = useCallback(() => (groups.length ? buildOption(kind, groups) : null), [groups, kind]);
  const onSelect = useCallback((e: ChartSelectEvent) => onPick(groups[e.items[0]?.dataIndex ?? -1]), [groups, onPick]);
  const canClear = useCallback(() => true, []);
  const { ref } = useEChart({ option, selected: NONE, partial: NONE, onSelect, canClearSelection: canClear, ...(chartRenderer ? { renderer: chartRenderer } : {}) });
  // The canvas is visual only; the group buttons below are its accessible form.
  return <div ref={ref} aria-hidden="true" title={label} className="h-48 w-full" />;
}

/** Keep the largest `max - 1` groups in their given order and fold the rest into one. */
export function foldGroups(groups: ChartGroup[], max: number, otherLabel: string): ChartGroup[] {
  if (groups.length <= max) return groups;
  const largest = new Set([...groups].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, Math.max(1, max - 1)));
  const head = groups.filter((g) => largest.has(g));
  const rest = groups.filter((g) => !largest.has(g));
  return [...head, { label: otherLabel, value: rest.reduce((a, g) => a + g.value, 0), refs: rest.flatMap((g) => g.refs) }];
}

/** Script data: `[{label, value, refs?}]`, malformed entries dropped. */
function groupsFromData(data: unknown): ChartGroup[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((d) => {
    const item = d as { label?: unknown; value?: unknown; refs?: unknown };
    if (typeof item?.value !== 'number' || !Number.isFinite(item.value)) return [];
    const refs = Array.isArray(item.refs) ? item.refs.filter((r): r is string => typeof r === 'string') : [];
    return [{ label: String(item.label ?? ''), value: item.value, refs }];
  });
}

function buildOption(kind: 'bar' | 'pie', groups: ChartGroup[]): EChartsOptionObject {
  const theme = readChartTheme();
  const textStyle = { color: theme.text, fontFamily: theme.fontFamily, fontSize: 11 };
  if (kind === 'pie') {
    return {
      color: [...LENS_PALETTE],
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie', radius: ['35%', '70%'], selectedMode: 'single', label: { ...textStyle, overflow: 'truncate', width: 90 },
        data: groups.map((g) => ({ name: g.label, value: g.value })),
      }],
    } as EChartsOptionObject;
  }
  return {
    color: [LENS_PALETTE[1]],
    tooltip: { trigger: 'axis' },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: groups.map((g) => g.label), axisLabel: { ...textStyle, overflow: 'truncate', width: 70, interval: 0, rotate: groups.length > 4 ? 30 : 0 }, axisLine: { lineStyle: { color: theme.axis } } },
    yAxis: { type: 'value', axisLabel: textStyle, splitLine: { lineStyle: { color: theme.grid } } },
    series: [{ type: 'bar', selectedMode: 'single', data: groups.map((g) => g.value), select: { itemStyle: { color: LENS_PALETTE[0] } } }],
  } as EChartsOptionObject;
}

export const GroupChartImpl = createComponentImplementation(GroupChartApi, ({ props }) => {
  const { t } = useTranslation();
  const run = useRunFunction();
  const { result, reader } = useQueryResult(props.data === undefined ? props.query ?? {} : undefined);
  const kind = props.kind === 'pie' ? 'pie' : 'bar';
  const max = typeof props.maxGroups === 'number' && props.maxGroups > 1 ? Math.floor(props.maxGroups) : 12;
  const sumPath = props.aggregate === 'sum' && typeof props.path === 'string' ? props.path : undefined;
  const emptyLabel = t('a2ui.noGroupValue');
  const otherLabel = t('a2ui.chart.other');

  const groups = useMemo(() => {
    const raw = props.data !== undefined
      ? groupsFromData(props.data)
      : result
        ? groupRows(reader, aggregatePool(result), props.groupBy, emptyLabel, sumPath ? { kind: 'sum', path: sumPath } : { kind: 'count' })
          .map((g) => ({ label: g.label, value: g.value, refs: g.rows.map((r) => encodeRef(r.ref)) }))
        : [];
    return foldGroups(raw, max, otherLabel);
  }, [props.data, result, reader, props.groupBy, emptyLabel, sumPath, max, otherLabel]);

  const selectGroup = useCallback((group: ChartGroup | undefined) => {
    if (group?.refs.length) run('select', { refs: group.refs });
  }, [run]);
  const title = typeof props.title === 'string' ? props.title : '';

  return (
    <div style={weightStyle(props.weight)} className="flex min-w-0 flex-col gap-1.5">
      {title && <div className="text-sm font-semibold">{title}</div>}
      <ResultNotes result={result} shown={result?.total} />
      {groups.length === 0 && !result?.unloadedModel && <Note>{t('a2ui.empty')}</Note>}
      {groups.length > 0 && (
        <ChartBoundary>
          <ChartCanvas kind={kind} groups={groups} label={t('a2ui.chart.label', { title: title || props.groupBy })} onPick={selectGroup} />
        </ChartBoundary>
      )}
      {groups.length > 0 && (
        <ul aria-label={t('a2ui.chart.groups')} className="flex flex-wrap gap-1">
          {groups.map((g, i) => (
            <li key={`${g.label}:${i}`}>
              <Button
                variant="outline"
                size="segment"
                disabled={g.refs.length === 0}
                data-a2ui-group={g.label}
                aria-label={t('a2ui.chart.selectGroup', { group: g.label, value: formatValue(g.value, '') })}
                onClick={() => selectGroup(g)}
                className="gap-1"
              >
                <span className="max-w-40 truncate">{g.label}</span>
                <span className="tabular-nums text-muted-foreground">{formatValue(g.value, '')}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
