/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Watch: renders any port value by its structure — item, list, group,
 * table — with counts and the first few entries. One component for every
 * shape is what a uniform data model buys (IFCflow's Watch node had to
 * special-case each producer).
 */

import { validateTable, type FlowData, type Table } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';

const LIMIT = 8;

function cell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') {
    const o = v as { globalId?: string; kind?: string; columns?: unknown };
    if (typeof o.globalId === 'string') return o.globalId;
    if (typeof o.kind === 'string') return `«${o.kind}»`;
    if (Array.isArray(v)) return `[${v.map(cell).join(', ')}]`;
    return JSON.stringify(v).slice(0, 40);
  }
  return String(v);
}

function TablePreview({ table }: { table: Table }) {
  const { t } = useTranslation();
  const rows = table.rows.slice(0, LIMIT);
  return (
    <div className="overflow-x-auto">
      <table className="text-2xs">
        <thead>
          <tr>{table.columns.map((c) => <th key={c.name} className="whitespace-nowrap px-1 text-left font-medium" title={`${c.type}${c.unit ? ` · ${c.unit}` : ''}`}>{c.name}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/50">{table.columns.map((c) => <td key={c.name} className="whitespace-nowrap px-1">{cell(r[c.name])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="text-muted-foreground">{t('flowPanel.preview.rows', { count: table.rows.length })}</div>
    </div>
  );
}

function Items({ items }: { items: readonly unknown[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return <span className="text-muted-foreground">{t('flowPanel.preview.empty')}</span>;
  const shown = items.slice(0, LIMIT);
  return (
    <ul className="font-mono text-2xs">
      {shown.map((v, i) => <li key={i} className="truncate">{cell(v)}</li>)}
      {items.length > LIMIT && <li className="text-muted-foreground">{t('flowPanel.preview.more', { count: items.length - LIMIT })}</li>}
    </ul>
  );
}

export function FlowValuePreview({ data }: { data: FlowData | undefined }) {
  const { t } = useTranslation();
  if (!data) return <span className="text-muted-foreground">—</span>;
  if (data.kind === 'item') {
    const v = data.value;
    if (v && typeof v === 'object' && !Array.isArray(v) && validateTable(v).length === 0) return <TablePreview table={v as Table} />;
    return <span className="font-mono text-2xs">{cell(v)}</span>;
  }
  if (data.kind === 'list') return <Items items={data.items} />;
  const branches = [...data.branches].slice(0, LIMIT);
  if (branches.length === 0) return <span className="text-muted-foreground">{t('flowPanel.preview.empty')}</span>;
  return (
    <div className="space-y-1">
      {branches.map(([key, items]) => (
        <div key={key}>
          <div className="font-mono text-2xs text-[#7dcfff]">{key || '""'} <span className="text-muted-foreground">· {items.length}</span></div>
          <div className="pl-2"><Items items={items} /></div>
        </div>
      ))}
      {data.branches.size > LIMIT && <div className="text-muted-foreground">{t('flowPanel.preview.more', { count: data.branches.size - LIMIT })}</div>}
    </div>
  );
}
