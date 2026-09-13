/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inline editor for one chart spec: title, type, dimension (a column of
 * the dataset), an optional stack column, the measure, and top-N. Native
 * selects, like the clash panel's — nothing here needs a portal.
 */
import { useState } from 'react';
import type { ChartDataset, ChartDatasetColumn, ChartSource, ChartSpec, ChartType } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';

const TYPE_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  stackedBar: 'Stacked bar',
  pie: 'Pie',
  treemap: 'Treemap',
  histogram: 'Histogram',
  timeline: 'Timeline (per week)',
};

const SOURCE_LABELS: Record<ChartSource, string> = {
  elements: 'Elements',
  clash: 'Clash results',
  bcf: 'BCF topics',
  schedule: 'Schedule tasks',
  ids: 'IDS results',
  compare: 'Model compare',
};

export interface ChartEditorProps {
  spec: ChartSpec;
  datasets: Record<ChartSource, ChartDataset>;
  onSave: (spec: ChartSpec) => void;
  onCancel: () => void;
}

/** The columns a chart type can bucket by. */
function dimensionColumns(type: ChartType, columns: readonly ChartDatasetColumn[]): ChartDatasetColumn[] {
  if (type === 'histogram') return columns.filter((c) => c.kind === 'number');
  if (type === 'timeline') return columns.filter((c) => c.kind === 'date');
  return columns.filter((c) => c.kind === 'category' || c.kind === 'boolean');
}

export function ChartEditor({ spec, datasets, onSave, onCancel }: ChartEditorProps) {
  const [draft, setDraft] = useState<ChartSpec>(spec);
  const columns = datasets[draft.source].columns;
  const rowCount = datasets[draft.source].rows.length;
  const numberColumns = columns.filter((c) => c.kind === 'number');
  const categoryColumns = columns.filter((c) => c.kind === 'category');
  const dims = dimensionColumns(draft.type, columns);
  const dimensionOk = dims.some((c) => c.id === draft.dimension);
  const measureOk = draft.measure.agg === 'count' || numberColumns.some((c) => c.id === draft.measure.column);
  const stackOk = draft.type !== 'stackedBar' || categoryColumns.some((c) => c.id === draft.stackBy);
  const valid = draft.title.trim().length > 0 && dimensionOk && measureOk && stackOk;

  const setSource = (source: ChartSource): void => {
    const cols = datasets[source].columns;
    const allowed = dimensionColumns(draft.type, cols);
    setDraft({ ...draft, source, dimension: allowed[0]?.id ?? '', stackBy: undefined, measure: { agg: 'count' } });
  };

  const setType = (type: ChartType): void => {
    const next = { ...draft, type };
    const allowed = dimensionColumns(type, columns);
    if (!allowed.some((c) => c.id === next.dimension)) next.dimension = allowed[0]?.id ?? next.dimension;
    if (type === 'stackedBar' && !next.stackBy) next.stackBy = categoryColumns.find((c) => c.id !== next.dimension)?.id;
    setDraft(next);
  };

  const field = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';

  return (
    <form
      className="flex w-full max-w-3xl flex-col gap-2 p-2 text-xs"
      data-chart-editor
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ ...draft, title: draft.title.trim() });
      }}
    >
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">Title</span>
        <input className={field} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Chart title" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Source{rowCount === 0 ? ' (nothing loaded for this source yet)' : ` (${rowCount.toLocaleString()} rows)`}</span>
          <select className={field} value={draft.source} onChange={(e) => setSource(e.target.value as ChartSource)} aria-label="Source">
            {(Object.keys(SOURCE_LABELS) as ChartSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Chart</span>
          <select className={field} value={draft.type} onChange={(e) => setType(e.target.value as ChartType)} aria-label="Chart type">
            {(Object.keys(TYPE_LABELS) as ChartType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Group by</span>
          <select className={field} value={draft.dimension} onChange={(e) => setDraft({ ...draft, dimension: e.target.value })} aria-label="Group by">
            {!dimensionOk && <option value={draft.dimension}>—</option>}
            {dims.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        {draft.type === 'stackedBar' && (
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Stack by</span>
            <select className={field} value={draft.stackBy ?? ''} onChange={(e) => setDraft({ ...draft, stackBy: e.target.value || undefined })} aria-label="Stack by">
              <option value="">—</option>
              {categoryColumns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Measure</span>
          <select
            className={field}
            value={draft.measure.agg === 'count' ? 'count' : `sum:${draft.measure.column ?? ''}`}
            onChange={(e) => {
              const v = e.target.value;
              setDraft({ ...draft, measure: v === 'count' ? { agg: 'count' } : { agg: 'sum', column: v.slice(4) } });
            }}
            aria-label="Measure"
          >
            <option value="count">Count</option>
            {numberColumns.map((c) => <option key={c.id} value={`sum:${c.id}`}>Sum of {c.label}{c.unit ? ` (${c.unit})` : ''}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Top N (rest as Other)</span>
          <input
            className={field}
            type="number"
            min={0}
            value={draft.topN ?? ''}
            onChange={(e) => setDraft({ ...draft, topN: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
            aria-label="Top N"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Order</span>
          <select className={field} value={draft.sort ?? 'value'} onChange={(e) => setDraft({ ...draft, sort: e.target.value as 'value' | 'label' })} aria-label="Order">
            <option value="value">Largest first</option>
            <option value="label">By label</option>
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" className="h-6 px-2 text-xs" disabled={!valid}>Save chart</Button>
      </div>
    </form>
  );
}
