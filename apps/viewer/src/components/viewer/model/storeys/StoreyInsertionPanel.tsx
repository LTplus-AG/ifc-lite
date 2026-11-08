/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react';
import type { StoreySummary } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { formatElevation, formatHeight } from '@/lib/storeys/storey-length';
import { refusalText } from '@/lib/storeys/storey-text';
import { commitStoreyInsertion, type StoreyInsertion } from './insert-storey';
import { StoreyImpact } from './StoreyImpact';

// The row loads the planner and its review UI together on first use.
export { reviewStoreyInsertion } from './insert-storey';

interface Props {
  modelId: string;
  review: StoreyInsertion;
  rows: readonly StoreySummary[];
  readOnly: boolean;
  onSelect: (ids: readonly number[]) => void;
  onAdded: (storeyId: number) => void;
  onCancel: () => void;
}

export function StoreyInsertionPanel({ modelId, review, rows, readOnly, onSelect, onAdded, onCancel }: Props) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollIntoView?.({ block: 'nearest' }); panel.current?.focus(); }, []);
  const title = t('storeyManager.addAboveOf', { storey: rows.find(row => row.expressId === review.plan.edit.storeyId)?.Name ?? '' });
  return <section ref={panel} tabIndex={-1} aria-label={title} data-storey-insertion className="space-y-2 border-t border-border p-2">
    <p className="text-xs font-medium">{title}</p>
    <p className="text-xs">{t('storeyManager.insert.summary', { storey: review.params.Name, elevation: formatElevation(review.params.Elevation), count: review.plan.storeys.length, height: formatHeight(review.height) })}</p>
    <ul className="max-h-24 overflow-y-auto text-xs">
      {review.plan.storeys.map(move => <li key={move.expressId}>{t('storeyManager.insert.move', { storey: move.Name, from: formatElevation(move.from), to: formatElevation(move.to) })}</li>)}
    </ul>
    {review.plan.refusals[0] && <p role="alert" className="text-xs text-danger">{refusalText(t, review.plan.refusals[0])}</p>}
    <StoreyImpact reboundWallIds={review.reboundWallIds} previewHint={false} draft={{ storeyId: review.plan.edit.storeyId, field: 'height', plan: review.plan, previewing: false, error: null }} rows={rows} onSelect={onSelect} />
    <div className="flex gap-2">
      <Button size="sm" disabled={readOnly || review.plan.refusals.length > 0} onClick={() => {
        const result = commitStoreyInsertion(modelId, review);
        if (!result.ok) { toast.error(t('storeyManager.refusal.other', { reason: result.reason })); return; }
        onCancel();
        if (result.storeyId !== null) onAdded(result.storeyId);
      }}>{t('storeyManager.insert.confirm')}</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>{t('storeyManager.copy.cancel')}</Button>
    </div>
  </section>;
}
