/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review card for a reviewed authoring batch (P15A): every operation with its
 * before → after summary, status and the native refusal when there is one;
 * per-row approval (a row that uses an excluded creation is excluded with
 * it); a 3D ghost preview on the `proposal` overlay channel, cleared on
 * apply, hide and unmount; one grouped commit and the shared durable receipt
 * with undo (`ReceiptSummary`).
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Crosshair, Hammer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import type { ModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { authoringCounts, previewModelAuthoring, type AuthoringRow, type AuthoringRowStatus } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring, writableRows } from '@/lib/actions/model-authoring-commit';
import { authoringGhosts } from '@/lib/actions/model-authoring-ghost';
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { captureValidationBefore } from '@/lib/actions/validation-verdicts';
import { authoringRowSummary } from './authoring-row-summary';
import { ReceiptSummary, STATUS } from './ModelChangeReview';

const AUTHORING_STATUS: Record<AuthoringRowStatus, { key: TranslationKey; tone: string }> = {
  ...STATUS,
  invalid: { key: 'modelAuthoring.status.invalid', tone: 'border border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  blocked: { key: 'modelAuthoring.status.blocked', tone: 'border border-transparent bg-muted text-muted-foreground' },
};

function Row({ row, batch, checked, onToggle }: { row: AuthoringRow; batch: ModelAuthoringBatch; checked: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useTranslation();
  const summary = authoringRowSummary(row, batch, t);
  const operation = t(`modelAuthoring.op.${row.op.op}`);
  const status = AUTHORING_STATUS[row.status];
  return <li className="grid grid-cols-[auto_1fr_auto] items-start gap-x-2 gap-y-0.5 border-b border-border/60 py-1.5 last:border-0">
    <label className="-mt-0.5 inline-flex h-6 w-6 cursor-pointer items-center justify-center"><input type="checkbox" className="h-4 w-4" checked={checked} disabled={row.status !== 'ready'}
      aria-label={t('modelAuthoring.approveRow', { operation, subject: summary.subject })}
      onChange={(event) => onToggle(event.target.checked)} /></label>
    <div className="min-w-0">
      <p className="break-words"><span className="font-medium">{operation}</span> <span className="text-muted-foreground">{summary.subject}</span></p>
      <p className="break-words"><span className="line-through text-muted-foreground">{summary.before}</span>
        {' → '}<span className="font-medium">{summary.after}</span></p>
      {row.issue && <p className={row.status === 'denied' || row.status === 'blocked' ? 'text-muted-foreground break-words' : 'text-amber-700 dark:text-amber-400 break-words'}>{row.issue}</p>}
    </div>
    <div className="flex flex-col items-end gap-1">
      <span className={cn('rounded px-1.5 py-0.5 text-2xs font-medium', status.tone)}>{t(status.key)}</span>
      {row.modelId && row.expressId !== null && row.op.op !== 'element.delete' && <IconButton label={t('modelChanges.showElement')} className="h-6 w-6"
        onClick={() => selectChangedEntity(row.modelId!, row.expressId!)}><Crosshair className="h-3.5 w-3.5" /></IconButton>}
    </div>
  </li>;
}

/** Reviewing and applying one authoring batch. `origin` is recorded on the receipt (e.g. the assistant conversation). */
export function ModelAuthoringReview({ batch, origin }: { batch: ModelAuthoringBatch; origin: string }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const models = useViewerStore((s) => s.models);
  // Recomputed whenever the model or edit gate changes, so statuses (and the dry run) are always current.
  const preview = useMemo(() => previewModelAuthoring(useViewerStore.getState(), batch),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the preview reads the live store; these are its inputs
    [batch, mutationVersion, editEnabled, models]);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [receipt, setReceipt] = useState<ModelChangeReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState(false);
  const counts = authoringCounts(preview.rows);
  const chosen = writableRows(preview, new Set(preview.rows.filter((row) => !excluded.has(row.index)).map((row) => row.index)));
  const approved = new Set(chosen.map((row) => row.index));

  const showGhosts = ghosts && !receipt;
  useEffect(() => {
    if (!showGhosts) return;
    const state = useViewerStore.getState();
    state.cameraCallbacks.setAuthoringOverlayMeshes?.('proposal', authoringGhosts(state, { ...preview, rows: preview.rows.filter((row) => approved.has(row.index)) }));
    return () => useViewerStore.getState().cameraCallbacks.clearAuthoringOverlayMeshes?.('proposal');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `approved` is derived from these
  }, [showGhosts, preview, excluded]);

  const apply = () => {
    // As for reviewed changes: the loaded check's counts first, so Re-run validation can show what the apply changed.
    const validation = captureValidationBefore(useViewerStore.getState());
    const outcome = commitModelAuthoring(useViewerStore, preview, approved, origin);
    if (!outcome.ok) { setError(outcome.detail ?? t(`modelChanges.refused.${outcome.reason}`)); return; }
    setError(null);
    setGhosts(false);
    const applied = validation ? { ...outcome.receipt, validation } : outcome.receipt;
    setReceipt(applied);
    void modelChangeLibrary.put(applied.id, applied);
  };
  const toggle = (row: AuthoringRow, on: boolean) => setExcluded((current) => {
    const next = new Set(current);
    if (on) next.delete(row.index); else next.add(row.index);
    return next;
  });
  return <section aria-label={t('modelAuthoring.title')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <Hammer className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('modelAuthoring.title')}
    </h3>
    <div className="p-2 space-y-2">
      <div>
        <p className="font-medium break-words">{batch.title}</p>
        {batch.rationale && <p className="text-muted-foreground break-words">{batch.rationale}</p>}
        <p className="text-muted-foreground">{t('modelAuthoring.frame', { units: batch.units })}</p>
      </div>
      <p className="text-muted-foreground">{t('modelAuthoring.counts', { ready: counts.ready,
        attention: counts.conflict + counts['missing-target'] + counts['ambiguous-target'] + counts.invalid,
        other: counts.unchanged + counts.unsupported + counts.blocked + counts.denied })}</p>
      {!editEnabled && !receipt && <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
        <p>{t('modelChanges.editModeRequired')}</p>
        <Button size="sm" variant="outline" className="h-7" onClick={() => useViewerStore.getState().setEditEnabled(true)}>{t('modelChanges.turnOnEditMode')}</Button>
      </div>}
      {!receipt && <ul aria-label={t('modelAuthoring.rows')}>{preview.rows.map((row) => <Row key={row.index} row={row} batch={batch}
        checked={approved.has(row.index)} onToggle={(on) => toggle(row, on)} />)}</ul>}
      {!receipt && <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7" disabled={approved.size === 0} onClick={apply}>{t('modelAuthoring.apply', { count: approved.size })}</Button>
        <Button size="sm" variant="outline" className="h-7" aria-pressed={ghosts} disabled={approved.size === 0} onClick={() => setGhosts((on) => !on)}>
          <Box className="h-3 w-3 mr-1" aria-hidden="true" />{t(ghosts ? 'modelAuthoring.previewHide' : 'modelAuthoring.previewShow')}
        </Button>
      </div>}
      {showGhosts && <p className="text-muted-foreground">{t('modelAuthoring.previewHint')}</p>}
      {receipt && <ReceiptSummary receipt={receipt} />}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">{error}</p>}
    </div>
  </section>;
}
