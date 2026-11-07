/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * State behind the storey manager (#9013): the live rows, and the one level
 * edit being typed with its preview. A typed elevation or height is planned
 * and previewed 250 ms after the last keystroke (`storey-preview.ts`); Enter
 * keeps the preview as the single undo step, Escape reverts it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoreyLevelEdit, StoreyLevelPlan, StoreySummary } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { mutationDenial } from '@/store/mutation-permission';
import { commitStoreyOp } from '@/store/slices/mutation-storey';
import { keepStoreyPreview, previewStoreyLevel, revertStoreyPreview } from '@/lib/storeys/storey-preview';
import { parseStoreyLength } from '@/lib/storeys/storey-length';
import { refusalText } from '@/lib/storeys/storey-text';
import { storeyRows } from '@/lib/storeys/storey-actions';

export type LevelField = 'elevation' | 'height';

export interface LevelDraft {
  readonly storeyId: number;
  readonly field: LevelField;
  readonly error: string | null;
  readonly plan: StoreyLevelPlan | null;
  /** The model shows the edit now (live preview). */
  readonly previewing: boolean;
}

export type RowsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly StoreySummary[] }
  | { readonly status: 'error'; readonly reason: string };

const PREVIEW_DELAY_MS = 250;
const LOADING: RowsState = { status: 'loading' };

/** The live storey rows of a model, highest first; read off the main thread's critical path. */
export function useStoreyRows(modelId: string | null): RowsState {
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [state, setState] = useState<{ readonly modelId: string | null; readonly rows: RowsState }>({ modelId: null, rows: { status: 'loading' } });
  useEffect(() => {
    if (!modelId) return undefined;
    // Defer the read one task so a large model paints its loading state first.
    const timer = setTimeout(() => {
      try {
        setState({ modelId, rows: { status: 'ready', rows: storeyRows(useViewerStore.getState(), modelId) } });
      } catch (error) {
        console.error('[storeys] could not read the storeys', error);
        setState({ modelId, rows: { status: 'error', reason: error instanceof Error ? error.message : String(error) } });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [modelId, models, mutationVersion]);
  // Another model's rows are never shown (or acted on) for this one: until its own read lands, it is loading.
  return state.modelId === modelId ? state.rows : LOADING;
}

function levelEdit(storeyId: number, field: LevelField, metres: number): StoreyLevelEdit {
  return field === 'elevation'
    ? { kind: 'elevation', storeyId, Elevation: metres }
    : { kind: 'floorHeight', storeyId, Height: metres };
}

export function useStoreyLevelEditing(modelId: string | null) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<LevelDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewed = useRef<string | null>(null);
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };

  const parse = useCallback((field: LevelField, text: string) => {
    const metres = parseStoreyLength(text, { signed: field === 'elevation' });
    if (metres === null || (field === 'height' && metres <= 0)) {
      return { metres: null, error: t(field === 'height' ? 'storeyManager.invalid.height' : 'storeyManager.invalid.length') };
    }
    return { metres, error: null };
  }, [t]);

  const preview = useCallback((storeyId: number, field: LevelField, metres: number) => {
    if (!modelId) return;
    const edit = levelEdit(storeyId, field, metres);
    const result = previewStoreyLevel(useViewerStore, modelId, edit);
    previewed.current = result.applied ? JSON.stringify(edit) : null;
    const refusal = result.plan?.refusals[0];
    setDraft({ storeyId, field, plan: result.plan, previewing: result.applied, error: refusal ? refusalText(t, refusal) : null });
  }, [modelId, t]);

  /** A keystroke: validate now, preview once typing pauses. */
  const onDraft = useCallback((storeyId: number, field: LevelField, text: string) => {
    clearTimer();
    const { metres, error } = parse(field, text);
    if (metres === null) {
      revertStoreyPreview(useViewerStore);
      previewed.current = null;
      setDraft({ storeyId, field, plan: null, previewing: false, error });
      return;
    }
    setDraft((current) => ({ storeyId, field, plan: current?.storeyId === storeyId ? current.plan : null, previewing: false, error: null }));
    timer.current = setTimeout(() => preview(storeyId, field, metres), PREVIEW_DELAY_MS);
  }, [parse, preview]);

  /** Enter or blur: keep the preview, or apply the edit now. False keeps the field open with why. */
  const onCommit = useCallback((storeyId: number, field: LevelField, text: string): boolean => {
    clearTimer();
    if (!modelId) return false;
    const { metres, error } = parse(field, text);
    if (metres === null) { setDraft({ storeyId, field, plan: null, previewing: false, error }); return false; }
    const edit = levelEdit(storeyId, field, metres);
    if (previewed.current === JSON.stringify(edit) && keepStoreyPreview(useViewerStore)) {
      previewed.current = null;
      setDraft(null);
      return true;
    }
    revertStoreyPreview(useViewerStore);
    previewed.current = null;
    const outcome = commitStoreyOp(useViewerStore, modelId, { kind: 'level', edit });
    if (!outcome.ok) {
      const message = outcome.refusals[0] ? refusalText(t, outcome.refusals[0]) : t('storeyManager.refusal.other', { reason: outcome.reason });
      setDraft({ storeyId, field, plan: null, previewing: false, error: message });
      return false;
    }
    setDraft(null);
    return true;
  }, [modelId, parse, t]);

  const onCancel = useCallback(() => {
    clearTimer();
    const refused = revertStoreyPreview(useViewerStore);
    previewed.current = null;
    setDraft(null);
    // A buried preview that cannot be put back stays applied: say so rather than close quietly.
    if (refused && !refused.ok) {
      toast.error(refused.refusals[0] ? refusalText(t, refused.refusals[0]) : t('storeyManager.refusal.other', { reason: refused.reason }));
    }
  }, [t]);

  // Leaving the manager (or the model) never leaves a provisional edit behind.
  useEffect(() => () => { clearTimer(); revertStoreyPreview(useViewerStore); }, [modelId]);
  // Nor a draft or refusal: express ids repeat across models, so another model's
  // storey would show it. (Its rows load first, so nothing renders it meanwhile.)
  useEffect(() => { previewed.current = null; setDraft(null); }, [modelId]);

  return { draft, onDraft, onCommit, onCancel };
}

export interface RenameError { readonly modelId: string; readonly storeyId: number; readonly message: string }

/**
 * Rename, with a refusal (an empty name, or the core's reason) shown beside
 * the name field it came from until the name is typed again or cancelled.
 */
export function useStoreyRename(modelId: string | null) {
  const { t } = useTranslation();
  const [error, setError] = useState<RenameError | null>(null);
  const rename = useCallback((storeyId: number, name: string): boolean => {
    if (!modelId) return false;
    if (!name.trim()) { setError({ modelId, storeyId, message: t('storeyManager.invalid.name') }); return false; }
    const outcome = commitStoreyOp(useViewerStore, modelId, { kind: 'rename', storeyId, Name: name });
    setError(outcome.ok ? null : { modelId, storeyId, message: t('storeyManager.refusal.other', { reason: outcome.reason }) });
    return outcome.ok;
  }, [modelId, t]);
  const clear = useCallback(() => setError(null), []);
  // A refusal belongs to the model it came from: express ids repeat across models.
  return { rename, error: error?.modelId === modelId ? error : null, clear };
}

/** Why storeys cannot be edited right now, or null. */
export function useStoreyEditDenial(modelId: string | null): string | null {
  return useViewerStore((s) => (modelId ? mutationDenial(s, modelId) : null));
}
