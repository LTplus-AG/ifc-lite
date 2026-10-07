/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review card for a reviewed model change batch (P04): every change with its
 * before → after value and status, per-row approval, one grouped commit and a
 * durable receipt with undo. Shared by every producer of `model.changes`.
 */

import { useMemo, useState } from 'react';
import { Crosshair, PencilLine, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import type { ChangeScalar, ModelChangeBatch } from '@/lib/actions/model-change';
import { previewCounts, previewModelChanges, type PreviewRow, type RowStatus } from '@/lib/actions/model-change-preview';
import { changeField, commitModelChanges, undoModelChanges, type ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { captureValidationBefore } from '@/lib/actions/validation-verdicts';
import { ReceiptValidation } from './ReceiptValidation';

export const STATUS: Record<RowStatus, { key: TranslationKey; tone: string }> = {
  ready: { key: 'modelChanges.status.ready', tone: 'border border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  unchanged: { key: 'modelChanges.status.unchanged', tone: 'border border-transparent bg-muted text-muted-foreground' },
  conflict: { key: 'modelChanges.status.conflict', tone: 'border border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  'missing-target': { key: 'modelChanges.status.missing', tone: 'border border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  'ambiguous-target': { key: 'modelChanges.status.ambiguous', tone: 'border border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  denied: { key: 'modelChanges.status.denied', tone: 'border border-transparent bg-muted text-muted-foreground' },
  unsupported: { key: 'modelChanges.status.unsupported', tone: 'border border-transparent bg-muted text-muted-foreground' },
};

function shown(value: ChangeScalar | undefined, empty: string): string {
  if (value === undefined || value === null || value === '') return empty;
  return typeof value === 'string' ? value : String(value);
}

function Row({ row, checked, onToggle }: { row: PreviewRow; checked: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useTranslation();
  const name = useViewerStore((s) => row.modelId && row.expressId ? s.models.get(row.modelId)?.ifcDataStore?.entities.getName(row.expressId) : undefined);
  const after = row.change.op === 'property.delete' ? null : row.change.value;
  const status = STATUS[row.status];
  return <li className="grid grid-cols-[auto_1fr_auto] items-start gap-x-2 gap-y-0.5 border-b border-border/60 py-1.5 last:border-0">
    <label className="-mt-0.5 inline-flex h-6 w-6 cursor-pointer items-center justify-center"><input type="checkbox" className="h-4 w-4" checked={checked} disabled={row.status !== 'ready'}
      aria-label={t('modelChanges.approveRow', { field: changeField(row.change), element: name || row.change.target.globalId })}
      onChange={(event) => onToggle(event.target.checked)} /></label>
    <div className="min-w-0">
      <p className="truncate font-medium">{name || row.change.target.globalId}</p>
      <p className="text-muted-foreground break-words">{changeField(row.change)}</p>
      <p className="break-words"><span className="line-through text-muted-foreground">{shown(row.current, t('modelChanges.absent'))}</span>
        {' → '}<span className="font-medium">{shown(after, t('modelChanges.removed'))}</span></p>
      {row.status === 'conflict' && <p className="text-amber-700 dark:text-amber-400">{t('modelChanges.expectedWas', { value: shown(row.change.expected, t('modelChanges.absent')) })}</p>}
      {row.denial && <p className="text-muted-foreground">{row.denial}</p>}
    </div>
    <div className="flex flex-col items-end gap-1">
      <span className={cn('rounded px-1.5 py-0.5 text-2xs font-medium', status.tone)}>{t(status.key)}</span>
      {row.modelId && row.expressId !== null && <IconButton label={t('modelChanges.showElement')} className="h-6 w-6"
        onClick={() => selectChangedEntity(row.modelId!, row.expressId!)}><Crosshair className="h-3.5 w-3.5" /></IconButton>}
    </div>
  </li>;
}

export function ReceiptSummary({ receipt }: { receipt: ModelChangeReceipt }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const live = useModelChangeReceipts((s) => s.entries.find((entry) => entry.id === receipt.id)) ?? receipt;
  const undo = () => {
    const outcome = undoModelChanges(useViewerStore, live);
    if (!outcome.ok) { setError(t(`modelChanges.undoRefused.${outcome.reason}`)); return; }
    setError(null);
    // The stored copy may carry a later validation rerun; keep it.
    void modelChangeLibrary.put(live.id, { ...live, status: 'undone', undoneAt: new Date().toISOString() });
  };
  return <div aria-live="polite" className={cn('rounded border p-2 space-y-1.5',
    live.status === 'undone' ? 'border-border bg-muted/40' : 'border-emerald-500/40 bg-emerald-500/10')}>
    <p className="font-medium">{t(live.status === 'undone' ? 'modelChanges.receiptUndone' : 'modelChanges.receiptApplied', { count: live.applied.length })}</p>
    <p className="text-muted-foreground">{t('modelChanges.receiptDetail', { batches: live.batches.length, skipped: live.skipped.length })}</p>
    {live.status === 'applied' && <Button size="sm" variant="outline" className="h-7" onClick={undo}><Undo2 className="h-3 w-3 mr-1" />{t('modelChanges.undo')}</Button>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <ReceiptValidation receipt={live} />
  </div>;
}

/** Reviewing and applying one batch. `origin` is recorded on the receipt (e.g. the assistant conversation). */
export function ModelChangeReview({ batch, origin }: { batch: ModelChangeBatch; origin: string }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const models = useViewerStore((s) => s.models);
  // Recomputed whenever the model or edit gate changes, so statuses are always current.
  const preview = useMemo(() => previewModelChanges(useViewerStore.getState(), batch),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the preview reads the live store; these are its inputs
    [batch, mutationVersion, editEnabled, models]);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [receipt, setReceipt] = useState<ModelChangeReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counts = previewCounts(preview.rows);
  const approved = new Set(preview.rows.filter((row) => row.status === 'ready' && !excluded.has(row.index)).map((row) => row.index));
  const apply = () => {
    // The current check's verdict counts are recorded first, so a rerun can show what the apply changed.
    const validation = captureValidationBefore(useViewerStore.getState());
    const outcome = commitModelChanges(useViewerStore, preview, approved, origin);
    if (!outcome.ok) { setError(outcome.detail ?? t(`modelChanges.refused.${outcome.reason}`)); return; }
    setError(null);
    const applied = validation ? { ...outcome.receipt, validation } : outcome.receipt;
    setReceipt(applied);
    void modelChangeLibrary.put(applied.id, applied);
  };
  return <section aria-label={t('modelChanges.title')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <PencilLine className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('modelChanges.title')}
    </h3>
    <div className="p-2 space-y-2">
      <div>
        <p className="font-medium break-words">{batch.title}</p>
        {batch.rationale && <p className="text-muted-foreground break-words">{batch.rationale}</p>}
      </div>
      <p className="text-muted-foreground">{t('modelChanges.counts', { ready: counts.ready, conflict: counts.conflict + counts['missing-target'] + counts['ambiguous-target'],
        unchanged: counts.unchanged + counts.unsupported })}</p>
      {!editEnabled && !receipt && <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
        <p>{t('modelChanges.editModeRequired')}</p>
        <Button size="sm" variant="outline" className="h-7" onClick={() => useViewerStore.getState().setEditEnabled(true)}>{t('modelChanges.turnOnEditMode')}</Button>
      </div>}
      {!receipt && <ul aria-label={t('modelChanges.rows')}>{preview.rows.map((row) => <Row key={row.index} row={row} checked={approved.has(row.index)}
        onToggle={(on) => setExcluded((current) => { const next = new Set(current); if (on) next.delete(row.index); else next.add(row.index); return next; })} />)}</ul>}
      {!receipt && <Button size="sm" className="h-7" disabled={approved.size === 0} onClick={apply}>{t('modelChanges.apply', { count: approved.size })}</Button>}
      {receipt && <ReceiptSummary receipt={receipt} />}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    </div>
  </section>;
}
