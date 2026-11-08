/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey manager (#9013), in the Model inspector, reached from the
 * storey chip and the plan's storey picker. Storeys highest first, each
 * edited in place; the active one is the storey being drawn on. Adding one
 * keeps the active drawing plane; its toast offers Draw on. Elevation and floor-to-floor edits preview
 * in 3D and the plan while typing, with the impact beside them, and apply as
 * one undo step.
 */

import { useRef, useState } from 'react';
import { effectiveStoreyElevation, type StoreyDeletePlan } from '@ifc-lite/create';
import { ChevronLeft, Layers, Plus } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { toGlobalIdFromModels } from '@/store/globalId';
import { commitStoreyOp } from '@/store/slices/mutation-storey';
import { activateStorey, deleteStorey, reviewStoreyDeletion } from '@/lib/storeys/storey-actions';
import { formatElevation, formatHeight } from '@/lib/storeys/storey-length';
import { refusalText } from '@/lib/storeys/storey-text';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { addStoreyKeepingSession } from './add-storey';
import { StoreyRow } from './StoreyRow';
import { StoreyDeletePanel } from './StoreyDeletePanel';
import { StoreySectionStrip } from './StoreySectionStrip';
import { StoreyImpact } from './StoreyImpact';
import { commitStoreyInsertion, reviewStoreyInsertion, type StoreyInsertion } from './insert-storey';
import { useStoreyEditDenial, useStoreyLevelEditing, useStoreyRename, useStoreyRows } from './useStoreyManager';

/** The batch (or the lone record) on top of a model's undo stack. */
function topUndoStep(modelId: string): string | null {
  const s = useViewerStore.getState();
  const top = s.undoStacks.get(modelId)?.at(-1);
  return top ? s.mutationBatchTags.get(top.id) ?? top.id : null;
}

export function StoreyManager({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const session = useViewerStore((s) => s.session);
  const modelName = useViewerStore((s) => (s.session ? s.models.get(s.session.modelId)?.name ?? '' : ''));
  const modelId = session?.modelId ?? null;
  const rowsState = useStoreyRows(modelId);
  const denial = useStoreyEditDenial(modelId);
  const editing = useStoreyLevelEditing(modelId);
  const renaming = useStoreyRename(modelId);
  // `reviewed`: what the open delete panel shows, and all that confirming it may delete.
  const [inserting, setInserting] = useState<{ modelId: string; review: StoreyInsertion } | null>(null);
  const [deletingState, setDeleting] = useState<{
    modelId: string | null; storeyId: number; error: string | null; reviewed: StoreyDeletePlan | null;
  } | null>(null);
  // Choices opened for another model's storey (express ids repeat across models) are not this model's.
  const deleting = deletingState?.modelId === modelId ? deletingState : null;
  const review = (storeyId: number) => (modelId ? reviewStoreyDeletion(useViewerStore.getState(), modelId, storeyId) : null);
  const radios = useRef(new Map<number, HTMLButtonElement>());
  const insertionPanel = useRef<HTMLElement>(null);
  const names = useRef(new Map<number, HTMLInputElement>());
  const fallbackName = (index: number) => t('storeyManager.fallbackName', { index });
  const rows = rowsState.status === 'ready' ? rowsState.rows : [];
  const activeId = session?.storeyId ?? null;
  const readOnly = denial !== null;

  const focusName = (storeyId: number) => requestAnimationFrame(() => names.current.get(storeyId)?.focus());
  const activate = (storeyId: number) => { if (modelId) activateStorey(useViewerStore.getState(), modelId, storeyId); };
  const arrow = (index: number, direction: 1 | -1) => {
    const next = rows[index + direction];
    if (!next) return;
    activate(next.expressId);
    requestAnimationFrame(() => radios.current.get(next.expressId)?.focus());
  };

  const added = (storeyId: number) => {
    if (!modelId) return;
    const state = useViewerStore.getState();
    const entity = state.mutationViews.get(modelId)?.getNewEntity(storeyId);
    const name = typeof entity?.attributes[2] === 'string' ? entity.attributes[2] : '';
    const store = state.models.get(modelId)?.ifcDataStore;
    const elevation = store ? formatElevation(effectiveStoreyElevation(store, state.mutationViews.get(modelId), storeyId)) : '';
    toast.success(t('storeyManager.added', { storey: name, elevation }), {
      label: t('storeyManager.drawOn'),
      onClick: () => activateStorey(useViewerStore.getState(), modelId, storeyId),
    }, `storey-added:${modelId}`);
    focusName(storeyId);
  };

  const add = (referenceId: number, side: 'above' | 'below') => {
    if (!modelId) return;
    const outcome = addStoreyKeepingSession(modelId, referenceId, side, fallbackName);
    if (!outcome.ok) { toast.error(t('storeyManager.refusal.other', { reason: outcome.reason })); return; }
    if (outcome.storeyId !== null) added(outcome.storeyId);
  };

  const addAtEnd = (side: 'above' | 'below') => {
    if (!modelId) return;
    const levels = modelStoreys(useViewerStore.getState(), modelId);
    const reference = side === 'above' ? levels.at(-1) : levels[0];
    if (reference) add(reference.expressId, side);
  };

  const remove = (storeyId: number, mode: Parameters<typeof deleteStorey>[3], expected?: StoreyDeletePlan) => {
    if (!modelId) return;
    const row = rows.find((candidate) => candidate.expressId === storeyId);
    const outcome = deleteStorey(useViewerStore, modelId, storeyId, mode, expected);
    if (!outcome.ok) {
      const message = outcome.refusals[0] ? refusalText(t, outcome.refusals[0]) : t('storeyManager.refusal.other', { reason: outcome.reason });
      // A refused panel shows the storey as it is now, so a second confirm deletes what it lists.
      if (deleting?.storeyId === storeyId) setDeleting({ modelId, storeyId, error: message, reviewed: review(storeyId) });
      else toast.error(message);
      return;
    }
    setDeleting(null);
    // The toast stays until dismissed: its Undo reverts this deletion only, never a later edit.
    const step = topUndoStep(modelId);
    toast.success(t('storeyManager.deleted', { storey: row?.Name ?? '' }), {
      label: t('storeyManager.undo'),
      onClick: () => {
        if (step !== null && topUndoStep(modelId) === step) useViewerStore.getState().undo(modelId);
        else toast.error(t('storeyManager.undoStale'));
      },
    });
  };

  const askDelete = (storeyId: number) => {
    const row = rows.find((candidate) => candidate.expressId === storeyId);
    if (!row) return;
    // An empty storey goes straight away (with Undo); one with elements asks what to do with them.
    if (row.elementCount === 0) remove(storeyId, { kind: 'empty' });
    else setDeleting({ modelId, storeyId, error: null, reviewed: review(storeyId) });
  };

  const selectElements = (ids: readonly number[]) => {
    if (!modelId) return;
    const state = useViewerStore.getState();
    state.setSelectedEntityIds(ids.map((id) => toGlobalIdFromModels(state.models, modelId, id)));
  };

  const header = (
    <div className="flex items-center gap-1.5 border-b border-border px-2 py-2">
      <IconButton label={t('storeyManager.back')} size="icon-xs" onClick={onBack}>
        <ChevronLeft aria-hidden className="h-4 w-4" />
      </IconButton>
      <Layers aria-hidden className="h-4 w-4 shrink-0 text-overlay-accent" />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-xs font-medium">{t('storeyManager.title')}</h2>
        {modelName && rowsState.status === 'ready' && (
          <p className="truncate text-2xs text-muted-foreground">{t('storeyManager.subtitle', { model: modelName, count: rows.length })}</p>
        )}
      </div>
    </div>
  );

  if (!modelId) {
    return <div data-storey-manager className="flex h-full flex-col">{header}<p className="p-4 text-xs text-muted-foreground">{t('storeyManager.noModel')}</p></div>;
  }
  if (rowsState.status === 'loading') {
    return (
      <div data-storey-manager className="flex h-full flex-col">
        {header}
        <output className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Spinner className="h-3.5 w-3.5" />{t('storeyManager.loading')}</output>
      </div>
    );
  }
  if (rowsState.status === 'error') {
    return <div data-storey-manager className="flex h-full flex-col">{header}<p role="alert" className="p-4 text-xs text-danger">{t('storeyManager.error', { reason: rowsState.reason })}</p></div>;
  }

  const activeIndex = Math.max(0, rows.findIndex((row) => row.expressId === activeId));
  const deletingRow = deleting ? rows.find((row) => row.expressId === deleting.storeyId) ?? null : null;
  return (
    <div data-storey-manager className="flex h-full min-h-0 flex-col">
      {header}
      {readOnly && <p className="border-b border-warn-border bg-warn-surface px-3 py-1.5 text-2xs text-warn">{t('storeyManager.readOnly', { reason: denial ?? '' })}</p>}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-xs text-muted-foreground">{t('storeyManager.empty')}</p>
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={() => {
              const outcome = commitStoreyOp(useViewerStore, modelId, { kind: 'add', params: { Name: fallbackName(1), Elevation: 0 } });
              if (!outcome.ok) toast.error(t('storeyManager.refusal.other', { reason: outcome.reason }));
              else if (outcome.storeyId !== null) activate(outcome.storeyId);
            }}>
              <Plus aria-hidden className="h-3.5 w-3.5" />{t('storeyManager.addFirst')}
            </Button>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!readOnly && (
            <div className="flex gap-1 px-2 pt-2">
              <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => addAtEnd('above')}>
                <Plus aria-hidden className="h-3.5 w-3.5" />{t('storeyManager.addAbove')}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => addAtEnd('below')}>
                {t('storeyManager.addBelow')}
              </Button>
            </div>
          )}
          <ul role="radiogroup" aria-label={t('storeyManager.activeGroup')} className="space-y-0.5 p-2">
            {rows.map((row, index) => (
              <StoreyRow
                key={row.expressId}
                row={row}
                active={row.expressId === activeId}
                tabbable={index === activeIndex}
                readOnly={readOnly}
                draft={editing.draft}
                onActivate={() => activate(row.expressId)}
                onArrow={(direction) => arrow(index, direction)}
                onRename={(name) => renaming.rename(row.expressId, name)}
                nameError={renaming.error?.storeyId === row.expressId ? renaming.error.message : null}
                onNameEdit={renaming.clear}
                onLevelDraft={(field, text) => editing.onDraft(row.expressId, field, text)}
                onLevelCommit={(field, text) => editing.onCommit(row.expressId, field, text)}
                onLevelCancel={editing.onCancel}
                onAdd={(side) => {
                  editing.onCancel();
                  const review = reviewStoreyInsertion(modelId, row.expressId, fallbackName, side);
                  if (review) { setInserting({ modelId, review }); requestAnimationFrame(() => { insertionPanel.current?.scrollIntoView?.({ block: 'nearest' }); insertionPanel.current?.focus(); }); }
                  else add(row.expressId, side);
                }}
                onDelete={() => askDelete(row.expressId)}
                radioRef={(element) => { if (element) radios.current.set(row.expressId, element); else radios.current.delete(row.expressId); }}
                nameRef={(element) => { if (element) names.current.set(row.expressId, element); else names.current.delete(row.expressId); }}
              >
                {deletingRow?.expressId === row.expressId && (
                  <StoreyDeletePanel
                    row={deleting?.reviewed ? { ...row, elementCount: deleting.reviewed.elementCount } : row}
                    others={rows.filter((other) => other.expressId !== row.expressId)}
                    defaultTargetId={(rows[index + 1] ?? rows[index - 1])?.expressId ?? null}
                    error={deleting?.error ?? null}
                    onMove={(targetStoreyId) => remove(row.expressId, { kind: 'move', targetStoreyId }, deleting?.reviewed ?? undefined)}
                    onDeleteContents={() => remove(row.expressId, { kind: 'deleteContents' }, deleting?.reviewed ?? undefined)}
                    onCancel={() => setDeleting(null)}
                  />
                )}
              </StoreyRow>
            ))}
          </ul>
          {inserting?.modelId === modelId && <section ref={insertionPanel} tabIndex={-1} aria-label={t('storeyManager.addAboveOf', { storey: rows.find(row => row.expressId === inserting.review.plan.edit.storeyId)?.Name ?? '' })} data-storey-insertion className="space-y-2 border-t border-border p-2">
            <p className="text-xs font-medium">{t('storeyManager.addAboveOf', { storey: rows.find(row => row.expressId === inserting.review.plan.edit.storeyId)?.Name ?? '' })}</p>
            <p className="text-xs">{t('storeyManager.insert.summary', { storey: inserting.review.params.Name, elevation: formatElevation(inserting.review.params.Elevation), count: inserting.review.plan.storeys.length, height: formatHeight(inserting.review.height) })}</p>
            <ul className="max-h-24 overflow-y-auto text-xs">
              {inserting.review.plan.storeys.map(move => <li key={move.expressId}>{t('storeyManager.insert.move', { storey: move.Name, from: formatElevation(move.from), to: formatElevation(move.to) })}</li>)}
            </ul>
            {inserting.review.plan.refusals[0] && <p role="alert" className="text-xs text-danger">{refusalText(t, inserting.review.plan.refusals[0])}</p>}
            <StoreyImpact insertion previewHint={false} draft={{ storeyId: inserting.review.plan.edit.storeyId, field: 'height', plan: inserting.review.plan, previewing: false, error: null }} rows={rows} onSelect={selectElements} />
            <div className="flex gap-2">
              <Button size="sm" disabled={readOnly || inserting.review.plan.refusals.length > 0} onClick={() => {
                const result = commitStoreyInsertion(modelId, inserting.review);
                if (!result.ok) { toast.error(t('storeyManager.refusal.other', { reason: result.reason })); return; }
                setInserting(null);
                if (result.storeyId !== null) added(result.storeyId);
              }}>{t('storeyManager.insert.confirm')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setInserting(null)}>{t('storeyManager.copy.cancel')}</Button>
            </div>
          </section>}
          {editing.draft && (
            <StoreyImpact draft={editing.draft} rows={rows} onSelect={selectElements} />
          )}
          <div className="border-t border-border px-2 py-2">
            <StoreySectionStrip rows={rows} activeId={activeId} plan={inserting?.modelId === modelId ? inserting.review.plan : editing.draft?.previewing ? editing.draft.plan : null} onActivate={activate} />
          </div>
        </div>
      )}
    </div>
  );
}
