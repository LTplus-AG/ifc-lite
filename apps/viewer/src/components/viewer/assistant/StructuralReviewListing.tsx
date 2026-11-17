/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n/useTranslation';

/** Rows a list renders; real models skip or leave unconnected hundreds of items. */
const SHOWN = 100;

/** A collapsible list of review rows, the first `SHOWN` of them. */
export function Listing<T>({ summary, rows, row, open }: { summary: string; rows: readonly T[]; row: (item: T) => ReactNode; open?: boolean }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return <details open={open}><summary>{summary}</summary>
    <ul className="space-y-1 max-h-48 overflow-auto">{rows.slice(0, SHOWN).map((item, index) => <li key={index}>{row(item)}</li>)}</ul>
    {rows.length > SHOWN && <p className="text-muted-foreground">{t('structuralDerive.more', { count: rows.length - SHOWN })}</p>}
  </details>;
}
