/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { useViewerStore } from '@/store';
import type { IdsStudioDraft } from './draft-codec.js';
import { idsStudioDraftLibrary, useIdsStudioDraftLibrary } from './draft-library.js';
import { createIdsDraftAutosave, restoreIdsDraft, restoreInitialIdsDraft, type IdsDraftFeedback } from './draft-session.js';

type DraftFeedback = IdsDraftFeedback | 'unreadable';
export const useIdsDraftFeedback = create<Record<string, DraftFeedback | undefined>>(() => Object.create(null));
const report = (id: string, feedback?: DraftFeedback) => useIdsDraftFeedback.setState(state => ({ ...state, [id]: feedback }));
interface DraftBaseline {
  durable?: string;
  staged?: string;
}
const baselines = new Map<string, DraftBaseline>();
const autosave = createIdsDraftAutosave(async draft => {
  const visible = useIdsStudioDraftLibrary.getState().entries.find(entry => entry.id === draft.id)?.document;
  const baseline = baselines.get(draft.id) ?? { durable: visible };
  // The library may show an optimistic draft after a refusal. Recognize that
  // draft and the last committed snapshot while still rejecting an external change.
  if (visible !== baseline.durable && (baseline.staged === undefined || visible !== baseline.staged)) return 'conflict';
  baseline.staged = draft.document;
  baselines.set(draft.id, baseline);
  const saved = await idsStudioDraftLibrary.put(draft.id, draft);
  if (saved) {
    baseline.durable = draft.document;
    if (baseline.staged === draft.document) baseline.staged = undefined;
  }
  return saved;
}, (id, reason) => report(id, reason ?? undefined));
let installed = false;
let restoring: string | null = null;

export function startIdsDraftAutosave(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  useViewerStore.subscribe((state, previous) => {
    const id = state.idsStudioDraftId;
    const previousId = previous.idsStudioDraftId;
    if (previousId && previousId !== id) void autosave.flush(previousId);
    const doc = state.idsStudioState?.doc;
    if (id && doc && doc !== previous.idsStudioState?.doc && restoring !== id) autosave.schedule(id, doc);
  });
  window.addEventListener('pagehide', () => { void autosave.flushAll(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void autosave.flushAll();
  });
}

function openIdsDraft(draft: IdsStudioDraft): void {
  const { entries, status } = useIdsStudioDraftLibrary.getState();
  const live = entries.find(entry => entry.id === draft.id);
  if (!live || live.document !== draft.document) return;
  restoring = live.id;
  try {
    const saveState = status.items[live.id];
    const opened = restoreIdsDraft(live, (doc, id) => {
      useViewerStore.getState().idsStudioOpen(doc, id);
      if (saveState && saveState !== 'saved') {
        // Reopening a library entry left visible after a failed save still requires a write.
        if (!baselines.has(id)) baselines.set(id, { staged: live.document });
        autosave.schedule(id, doc);
      } else {
        baselines.set(id, { durable: live.document });
        report(id);
      }
    });
    if (!opened) report(live.id, 'unreadable');
  } finally {
    restoring = null;
  }
}

export function flushIdsDrafts(): Promise<boolean> { return autosave.flushAll(); }

/** `refused` and `unavailable` may pass on retry; the others persist until the user closes the draft in the panel. */
type IdsDraftUnsavedReason = 'refused' | 'unavailable' | 'tooLarge' | 'serialize' | 'invalid' | 'conflict';
const RETRY = ' Retry (with a new idempotency_key if you sent one) once storage accepts writes, or ask';
const UNSAVED_DETAIL: Record<IdsDraftUnsavedReason, string> = {
  refused: `browser storage refused the write.${RETRY}`,
  unavailable: `browser storage is unavailable.${RETRY}`,
  tooLarge: 'the document is too large for a draft. Ask',
  serialize: 'the document could not be serialized as a draft. Ask',
  invalid: 'browser storage rejected the draft as invalid. Ask',
  conflict: 'another tab changed the saved draft. Ask',
};

class IdsDraftUnsavedError extends Error {
  constructor(readonly reason: IdsDraftUnsavedReason) {
    super(`The open IDS draft could not be saved and remains open: ${UNSAVED_DETAIL[reason]} `
      + 'the user to close it from the IDS Studio panel and confirm discarding the unsaved changes.');
    this.name = 'IdsDraftUnsavedError';
  }
}

function unsavedReason(id: string): IdsDraftUnsavedReason {
  const feedback = useIdsDraftFeedback.getState()[id];
  if (feedback === 'tooLarge' || feedback === 'serialize' || feedback === 'conflict') return feedback;
  const { phase, items } = useIdsStudioDraftLibrary.getState().status;
  if (items[id] === 'conflict' || items[id] === 'invalid') return items[id];
  return phase === 'unavailable' ? 'unavailable' : 'refused';
}

/** Agent close and replace cannot ask the user, so an unsaved open draft refuses them. */
export async function saveOpenIdsDraft(): Promise<void> {
  const id = useViewerStore.getState().idsStudioDraftId;
  if (id && !(await autosave.flush(id))) throw new IdsDraftUnsavedError(unsavedReason(id));
}

export function checkInitialIdsDraft(isMounted: () => boolean): Promise<void> {
  return restoreInitialIdsDraft(idsStudioDraftLibrary.initialize,
    () => ({ revision: isMounted() ? useViewerStore.getState().idsStudioRevision : -1, drafts: useIdsStudioDraftLibrary.getState().entries }),
    draft => {
      openIdsDraft(draft);
      return useViewerStore.getState().idsStudioDraftId === draft.id;
    });
}

export async function switchIdsDraft(draft: IdsStudioDraft): Promise<void> {
  const { idsStudioDraftId: id, idsStudioRevision: revision } = useViewerStore.getState();
  if (id && !(await autosave.flush(id))) return;
  if (useViewerStore.getState().idsStudioRevision === revision) openIdsDraft(draft);
}

export async function closeIdsDraft(confirmUnsaved: () => Promise<boolean>): Promise<void> {
  const { idsStudioDraftId: id, idsStudioRevision: revision } = useViewerStore.getState();
  const saved = !id || await autosave.flush(id);
  if (!saved && (useViewerStore.getState().idsStudioRevision !== revision || !(await confirmUnsaved()))) return;
  const live = useViewerStore.getState();
  if (live.idsStudioRevision !== revision) return;
  if (!saved && id) {
    autosave.forget(id);
    report(id);
  }
  live.idsStudioClose();
}

/** Only closed drafts can be discarded. Check again when the queued write gets its turn. */
export async function discardClosedIdsDraft(draft: IdsStudioDraft): Promise<void> {
  const stillClosed = () => useViewerStore.getState().idsStudioDraftId !== draft.id;
  const unchanged = () => stillClosed() && useIdsStudioDraftLibrary.getState().entries.some(
    entry => entry.id === draft.id && entry.document === draft.document,
  );
  if (!unchanged()) return;
  if (await idsStudioDraftLibrary.put(draft.id, null, unchanged)) {
    if (stillClosed()) autosave.forget(draft.id);
    baselines.delete(draft.id);
    report(draft.id);
  }
}
