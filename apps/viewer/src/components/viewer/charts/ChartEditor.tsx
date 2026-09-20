/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inline editor for one chart spec: title, type, dimension (a column of
 * the dataset), an optional stack column, the measure, and top-N. Native
 * selects, like the clash panel's — nothing here needs a portal.
 */
import { useMemo, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { trimSelectorWhitespace } from '@ifc-lite/query';
import { CHART_FILTER_NOT_APPLICABLE_SOURCES, elementFieldColumn, elementFieldColumnId, type ChartDataset, type ChartDatasetColumn, type ChartSource, type ChartSpec, type ChartType, type ElementFieldBinding } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';
import { readChartFilter } from '@/lib/charts/source-filter';
import { DOCS_URL, useActiveSchemaVersion } from '../SearchModal.filter.selector';
import { SelectorFeedbackList, type SelectorFeedback } from '../SearchModal.filter.feedback';
import { ElementFieldPicker } from './ElementFieldPicker';
import type { ElementFieldCatalog } from '@/lib/charts/element-field-reader';

const FILTER_PLACEHOLDER = 'IfcWall, Pset_WallCommon.FireRating=/REI.*/';

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
  elementFieldCatalog: ElementFieldCatalog;
  elementFieldCatalogLoading: boolean;
}

/**
 * The columns the draft can bind to. Other charts' IFC field columns are
 * hidden; the draft's own field is a synthesized column, NOT a column of the
 * shared dataset: an unsaved edit must never rebuild the dashboard's
 * datasets, because every card re-aggregates over them and reconciles its
 * live selection against the result (#4833). The resolved display unit is
 * the card's concern once saved; here the binding's own unit labels the sum.
 */
export function editorColumns(dataset: ChartDataset, draft: ChartSpec): ChartDatasetColumn[] {
  if (draft.source !== 'elements') return dataset.columns;
  const builtIn = dataset.columns.filter((column) => !column.id.startsWith('ifc-field:'));
  return draft.elementField ? [...builtIn, elementFieldColumn(draft.elementField)] : builtIn;
}

/** The columns a chart type can bucket by. */
function dimensionColumns(type: ChartType, columns: readonly ChartDatasetColumn[]): ChartDatasetColumn[] {
  if (type === 'histogram') return columns.filter((c) => c.kind === 'number');
  if (type === 'timeline') return columns.filter((c) => c.kind === 'date');
  return columns.filter((c) => c.kind === 'category' || c.kind === 'boolean');
}

export function ChartEditor({ spec, datasets, onSave, onCancel, elementFieldCatalog, elementFieldCatalogLoading }: ChartEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ChartSpec>(spec);
  const schemaVersion = useActiveSchemaVersion();
  const [filterText, setFilterText] = useState(spec.filter?.selector ?? '');
  const [filterFeedback, setFilterFeedback] = useState<SelectorFeedback | null>(null);
  const filterApplicable = !CHART_FILTER_NOT_APPLICABLE_SOURCES.has(draft.source);
  // `null` means "no filter typed" — always valid; a real reading is either
  // ok or a refusal message (#4946's all-or-nothing rule, `readChartFilter`).
  const filterReading = useMemo(
    () => (filterApplicable && trimSelectorWhitespace(filterText).length > 0 ? readChartFilter(filterText, { schemaVersion }) : null),
    [filterApplicable, filterText, schemaVersion],
  );
  const filterValid = filterReading === null || filterReading.ok;
  const columns = editorColumns(datasets[draft.source], draft);
  const rowCount = datasets[draft.source].rows.length;
  const numberColumns = columns.filter((c) => c.kind === 'number');
  const categoryColumns = columns.filter((c) => c.kind === 'category' || c.kind === 'boolean');
  const dims = dimensionColumns(draft.type, columns);
  const dimensionOk = dims.some((c) => c.id === draft.dimension);
  const measureOk = draft.measure.agg === 'count' || numberColumns.some((c) => c.id === draft.measure.column);
  const stackOk = draft.type !== 'stackedBar' || categoryColumns.some((c) => c.id === draft.stackBy);
  const valid = draft.title.trim().length > 0 && dimensionOk && measureOk && stackOk && filterValid;

  const setSource = (source: ChartSource): void => {
    const cols = datasets[source].columns;
    const allowed = dimensionColumns(draft.type, cols);
    setDraft({ ...draft, source, elementField: undefined, dimension: allowed[0]?.id ?? '', stackBy: undefined, measure: { agg: 'count' } });
    // Not every source can be filtered (#4946); switching to one clears the
    // field rather than leave text behind that the next save would drop
    // silently.
    setFilterText('');
    setFilterFeedback(null);
  };

  const setElementField = (elementField: ElementFieldBinding | undefined): void => {
    const oldId = draft.elementField ? elementFieldColumnId(draft.elementField) : undefined;
    const nextId = elementField ? elementFieldColumnId(elementField) : undefined;
    const next: ChartSpec = { ...draft, elementField };
    if (nextId && elementField?.valueKind === 'number') {
      next.type = 'histogram';
      next.dimension = nextId;
      next.stackBy = undefined;
      next.measure = { agg: 'count' };
    } else if (nextId) {
      if (next.type === 'histogram' || next.type === 'timeline') next.type = 'bar';
      next.dimension = nextId;
      next.stackBy = undefined;
      if (oldId && next.measure.column === oldId) next.measure = { agg: 'count' };
    }
    else {
      // Back to the built-in columns: a histogram over the cleared numeric
      // field has no number column left, so it would sit unsaveable (#4833).
      if (next.type === 'histogram' || next.type === 'timeline') next.type = 'bar';
      const columns = editorColumns(datasets.elements, next);
      if (!dimensionColumns(next.type, columns).some((column) => column.id === next.dimension)) {
        next.dimension = columns.find((column) => column.kind === 'category')?.id ?? '';
      }
      if (oldId && next.stackBy === oldId) next.stackBy = undefined;
      if (oldId && next.measure.column === oldId) next.measure = { agg: 'count' };
    }
    setDraft(next);
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
        if (filterReading && !filterReading.ok) {
          setFilterFeedback({ tone: 'error', lines: [filterReading.message] });
          return;
        }
        if (!valid) return;
        const filter = filterApplicable && trimSelectorWhitespace(filterText).length > 0 ? { selector: trimSelectorWhitespace(filterText) } : undefined;
        onSave({ ...draft, title: draft.title.trim(), filter });
      }}
    >
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">{t('chartEditor.titleLabel')}</span>
        <input className={field} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label={t('chartEditor.titleAriaLabel')} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{rowCount === 0 ? t('chartEditor.sourceLabelEmpty') : t('chartEditor.sourceLabelWithCount', { count: rowCount.toLocaleString() })}</span>
          <select className={field} value={draft.source} onChange={(e) => setSource(e.target.value as ChartSource)} aria-label={t('chartEditor.sourceAriaLabel')}>
            {(Object.keys(SOURCE_LABELS) as ChartSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
          </select>
        </label>
        {draft.source === 'elements' && (
          <ElementFieldPicker value={draft.elementField} catalog={elementFieldCatalog} loading={elementFieldCatalogLoading} className={field} onChange={setElementField} />
        )}
        <label className="col-span-2 flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('chartEditor.sourceFilterLabel')}</span>
          {filterApplicable ? (
            <>
              <div className="flex items-center gap-1">
                <input
                  className={`${field} flex-1 font-mono`}
                  value={filterText}
                  onChange={(e) => {
                    setFilterText(e.target.value);
                    // A blur error describes the previous reading. Do not leave it
                    // visible while the user has already corrected the selector.
                    setFilterFeedback(null);
                  }}
                  onBlur={() => setFilterFeedback(filterReading && !filterReading.ok ? { tone: 'error', lines: [filterReading.message] } : null)}
                  placeholder={FILTER_PLACEHOLDER}
                  aria-label={t('chartEditor.sourceFilterAriaLabel')}
                  spellCheck={false}
                />
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('chartEditor.selectorSyntaxReference')}
                  title={t('chartEditor.selectorSyntaxReference')}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </a>
              </div>
              {filterFeedback && <SelectorFeedbackList feedback={filterFeedback} />}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t('chartEditor.sourceFilterNotApplicable', { source: SOURCE_LABELS[draft.source] })}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('chartEditor.chartTypeLabel')}</span>
          <select className={field} value={draft.type} onChange={(e) => setType(e.target.value as ChartType)} aria-label={t('chartEditor.chartTypeAriaLabel')}>
            {(Object.keys(TYPE_LABELS) as ChartType[]).map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('chartEditor.groupByLabel')}</span>
          <select className={field} value={draft.dimension} onChange={(e) => setDraft({ ...draft, dimension: e.target.value })} aria-label={t('chartEditor.groupByAriaLabel')}>
            {!dimensionOk && <option value={draft.dimension}>—</option>}
            {dims.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        {draft.type === 'stackedBar' && (
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{t('chartEditor.stackByLabel')}</span>
            <select className={field} value={draft.stackBy ?? ''} onChange={(e) => setDraft({ ...draft, stackBy: e.target.value || undefined })} aria-label={t('chartEditor.stackByAriaLabel')}>
              <option value="">—</option>
              {categoryColumns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('chartEditor.measureLabel')}</span>
          <select
            className={field}
            value={draft.measure.agg === 'count' ? 'count' : `sum:${draft.measure.column ?? ''}`}
            onChange={(e) => {
              const v = e.target.value;
              setDraft({ ...draft, measure: v === 'count' ? { agg: 'count' } : { agg: 'sum', column: v.slice(4) } });
            }}
            aria-label={t('chartEditor.measureAriaLabel')}
          >
            <option value="count">{t('chartEditor.countOption')}</option>
            {numberColumns.map((c) => <option key={c.id} value={`sum:${c.id}`}>{t('chartEditor.sumOfOption', { column: c.label, unit: c.unit ? ` (${c.unit})` : '' })}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('chartEditor.topNLabel')}</span>
          <input
            className={field}
            type="number"
            min={0}
            value={draft.topN ?? ''}
            onChange={(e) => setDraft({ ...draft, topN: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
            aria-label={t('chartEditor.topNAriaLabel')}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('chartEditor.orderLabel')}</span>
          <select className={field} value={draft.sort ?? 'value'} onChange={(e) => setDraft({ ...draft, sort: e.target.value as 'value' | 'label' })} aria-label={t('chartEditor.orderAriaLabel')}>
            <option value="value">{t('chartEditor.orderValueOption')}</option>
            <option value="label">{t('chartEditor.orderLabelOption')}</option>
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>{t('chartEditor.cancelButton')}</Button>
        <Button type="submit" size="sm" className="h-6 px-2 text-xs" disabled={!valid}>{t('chartEditor.saveButton')}</Button>
      </div>
    </form>
  );
}
