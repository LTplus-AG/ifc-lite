/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mapping card for an AI-drafted `table.mapping` (P15): every column target
 * is editable, problems (unknown columns, duplicate targets, units on text)
 * block review, and the first rows are converted live so the person sees the
 * exact before → after values before producing the full change batch.
 */

import { useMemo } from 'react';
import { Table2, Trash2 } from 'lucide-react';
import type { CsvRow } from '@ifc-lite/mutations';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { ChangeConversion } from '@/lib/actions/change-conversion';
import { changeField } from '@/lib/actions/model-change-commit';
import { EDITABLE_ATTRIBUTES, type EditableAttribute } from '@/lib/actions/model-change';
import { tableToModelChanges } from '@/lib/actions/table-changes';
import {
  COLUMN_VALUE_TYPES, IDENTITY_KEYS, TABLE_UNITS, validateTableMapping, type ColumnValueType, type IdentityKey,
  type TableColumnTarget, type TableMapping, type TableUnit,
} from '@/lib/actions/table-mapping';
import { ConversionSummary } from './ChangeReviewDialog';

const SAMPLE = 5;
const SELECT = 'h-7 rounded border border-border bg-transparent px-1 text-xs';

function retarget(column: TableColumnTarget, target: TableColumnTarget['target']): TableColumnTarget {
  if (target === 'attribute') return { column: column.column, target, name: 'Name' };
  const set = column.target === 'property' ? column.pset : column.target === 'quantity' ? column.qset : '';
  const name = column.target === 'attribute' ? '' : column.name;
  return target === 'property' ? { column: column.column, target, pset: set, name, valueType: 'text' }
    : { column: column.column, target, qset: set, name };
}

function ColumnRow({ column, headers, onChange, onRemove }: { column: TableColumnTarget; headers: readonly string[];
  onChange: (next: TableColumnTarget) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const unit = (value: string) => value ? { unit: value as TableUnit } : { unit: undefined };
  return <li className="flex flex-wrap items-center gap-1 border-b border-border/60 py-1 last:border-0">
    <select aria-label={t('tableMapping.column')} className={SELECT} value={column.column} onChange={(e) => onChange({ ...column, column: e.target.value })}>
      {[...new Set([column.column, ...headers])].map((h) => <option key={h} value={h}>{h}</option>)}
    </select>
    <select aria-label={t('tableMapping.target')} className={SELECT} value={column.target}
      onChange={(e) => onChange(retarget(column, e.target.value as TableColumnTarget['target']))}>
      {(['property', 'quantity', 'attribute'] as const).map((kind) => <option key={kind} value={kind}>{t(`tableMapping.target.${kind}`)}</option>)}
    </select>
    {column.target === 'attribute' ? <select aria-label={t('tableMapping.name')} className={SELECT} value={column.name}
      onChange={(e) => onChange({ ...column, name: e.target.value as EditableAttribute })}>
      {EDITABLE_ATTRIBUTES.map((name) => <option key={name} value={name}>{name}</option>)}
    </select> : <>
      <Input aria-label={t('tableMapping.set')} className="h-7 w-36 text-xs" value={column.target === 'property' ? column.pset : column.qset}
        onChange={(e) => onChange(column.target === 'property' ? { ...column, pset: e.target.value } : { ...column, qset: e.target.value })} />
      <Input aria-label={t('tableMapping.name')} className="h-7 w-32 text-xs" value={column.name} onChange={(e) => onChange({ ...column, name: e.target.value })} />
      {column.target === 'property' && <select aria-label={t('tableMapping.valueType')} className={SELECT} value={column.valueType}
        onChange={(e) => onChange({ ...column, valueType: e.target.value as ColumnValueType })}>
        {COLUMN_VALUE_TYPES.map((type) => <option key={type} value={type}>{t(`tableMapping.valueType.${type}`)}</option>)}
      </select>}
      <select aria-label={t('tableMapping.unit')} className={SELECT} value={column.unit ?? ''} onChange={(e) => onChange({ ...column, ...unit(e.target.value) })}>
        <option value="">{t('tableMapping.noUnit')}</option>
        {Object.keys(TABLE_UNITS).map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
      </select>
    </>}
    <IconButton label={t('tableMapping.remove', { column: column.column })} className="h-7 w-7" onClick={onRemove}>
      <Trash2 className="h-3.5 w-3.5" /></IconButton>
  </li>;
}

export function TableMappingCard({ modelId, headers, rows, mapping, onChange, onReview, onDiscard }: {
  modelId: string; headers: readonly string[]; rows: readonly CsvRow[]; mapping: TableMapping;
  onChange: (next: TableMapping) => void; onReview: (conversion: ChangeConversion) => void; onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const problems = useMemo(() => validateTableMapping(mapping, headers), [mapping, headers]);
  const sample = useMemo(() => problems.length > 0 ? null
    : tableToModelChanges(useViewerStore.getState(), { modelId, rows, mapping, limit: SAMPLE }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the live store; mutationVersion is its input
  [problems, modelId, rows, mapping, mutationVersion]);
  const setColumn = (index: number, next: TableColumnTarget | null) => onChange({ ...mapping,
    columns: next ? mapping.columns.map((c, i) => i === index ? next : c) : mapping.columns.filter((_, i) => i !== index) });
  return <section aria-label={t('tableMapping.title')} className="rounded border border-primary/30 bg-primary/5 p-2 space-y-2 text-xs">
    <h3 className="flex items-center gap-1.5 font-semibold"><Table2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('tableMapping.title')}</h3>
    <p className="text-muted-foreground">{t('tableMapping.description')}</p>
    {mapping.rationale && <p className="break-words">{mapping.rationale}</p>}
    <div className="flex flex-wrap items-center gap-1">
      <select aria-label={t('tableMapping.identityColumn')} className={SELECT} value={mapping.identity.column}
        onChange={(e) => onChange({ ...mapping, identity: { ...mapping.identity, column: e.target.value } })}>
        {[...new Set([mapping.identity.column, ...headers])].map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <select aria-label={t('tableMapping.identityKey')} className={SELECT} value={mapping.identity.key}
        onChange={(e) => onChange({ ...mapping, identity: { ...mapping.identity, key: e.target.value as IdentityKey } })}>
        {IDENTITY_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
      </select>
    </div>
    <ul>{mapping.columns.map((column, index) => <ColumnRow key={index} column={column} headers={headers}
      onChange={(next) => setColumn(index, next)} onRemove={() => setColumn(index, null)} />)}</ul>
    {problems.length > 0 && <ul role="alert" className="space-y-0.5 text-amber-700 dark:text-amber-400">
      {problems.map((problem, index) => <li key={index}>{t(`tableMapping.problem.${problem.kind}`,
        { column: problem.column, field: 'field' in problem ? problem.field : '' })}</li>)}</ul>}
    {sample && <div className="space-y-1">
      <p className="font-medium">{t('tableMapping.sampleTitle', { count: Math.min(SAMPLE, rows.length) })}</p>
      {sample.total === 0 ? <p className="text-muted-foreground">{t('tableMapping.sampleEmpty')}</p>
        : <ul className="space-y-0.5">{sample.batches.flatMap((batch) => batch.changes).map((change, index) => <li key={index} className="break-words font-mono text-2xs">
          {change.target.globalId} · {changeField(change)}: {String(change.expected ?? '∅')} → {change.op === 'property.delete' ? '∅' : String(change.value)}</li>)}</ul>}
      {sample.issues.length > 0 && <ConversionSummary conversion={sample} />}
    </div>}
    <div className="flex gap-2">
      <Button size="sm" className="h-7" disabled={problems.length > 0}
        onClick={() => onReview(tableToModelChanges(useViewerStore.getState(), { modelId, rows, mapping }))}>{t('tableChanges.reviewButton')}</Button>
      <Button size="sm" variant="outline" className="h-7" onClick={onDiscard}>{t('tableMapping.discard')}</Button>
    </div>
  </section>;
}
