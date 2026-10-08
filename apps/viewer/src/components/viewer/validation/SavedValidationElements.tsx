/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react';
import type { IdsReportBlock } from '@/lib/document/ids-report-types';
import { useTranslation } from '@/i18n';

/** Immutable native facts only: old express/model ids never select the live scene. */
export function SavedValidationElements({ snapshot, rowId, request }: {
  snapshot: IdsReportBlock; rowId: string | null; request: object | null;
}) {
  const { t } = useTranslation();
  const focused = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!request || !rowId) return;
    focused.current?.focus();
    focused.current?.scrollIntoView?.({ block: 'nearest' });
  }, [request, rowId, snapshot]);
  const evidence = snapshot.elementEvidence;
  if (!evidence) return null;
  const rows = evidence.rows.slice(0, 50);
  const original = evidence.rows.find(row => row.id === rowId);
  if (original && !rows.includes(original)) rows.splice(49, 1, original);
  return <div data-saved-validation-elements className="flex flex-col gap-2">
    <p className="text-muted-foreground">{t('validationPanel.history.elements', {
      shown: rows.length, saved: evidence.rows.length, omitted: evidence.omitted,
    })}</p>
    {evidence.gaps.map(gap => <p key={gap} className="text-amber-600 dark:text-amber-400">{gap}</p>)}
    {rows.map(row => <article key={row.id} ref={row.id === rowId ? focused : undefined} tabIndex={-1}
      aria-current={row.id === rowId ? 'true' : undefined} data-saved-validation-row={row.id}
      className="rounded border border-border p-2 focus:outline focus:outline-2 focus:outline-primary">
      <p className="font-medium">{row.title} · {row.nativeStatus}</p>
      <p>{row.modelName} · {row.ifcType}{row.Name !== undefined ? ` · ${row.Name}` : ''}</p>
      {row.GlobalId && <p>{t('validationPanel.history.globalId', { value: row.GlobalId })}</p>}
      {row.detail.map((line, index) => <p key={index}>{line}</p>)}
    </article>)}
  </div>;
}
