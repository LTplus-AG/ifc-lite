/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { useViewerStore } from '@/store';
import type { IdsStudioDraft } from './draft-codec.js';
import { idsStudioDraftLibrary, useIdsStudioDraftLibrary } from './draft-library.js';
import { createIdsDraftAutosave, restoreIdsDraft, restoreInitialIdsDraft } from './draft-session.js';

type DraftError = 'tooLarge' | 'serialize' | 'unreadable' | 'conflict';
export const useIdsDraftErrors = create<Record<string, DraftError | undefined>>(() => Object.create(null));
const report = (id: string, error?: DraftError) => useIdsDraftErrors.setState(errors => ({ ...errors, [id]: error }));
const baselines = new Map<string, string>();
const autosave = createIdsDraftAutosave(async draft => {
  const known = baselines.get(draft.id);
  const visible = useIdsStudioDraftLibrary.getState().entries.find(entry => entry.id === draft.id);
  // Refreshes can advance the library revision while the editor still owns an older snapshot.
  if (known !== undefined && visible?.document !== known) {
    report(draft.id, 'conflict');
    return false;
  }
  baselines.set(draft.id, draft.document);
  return idsStudioDraftLibrary.put(draft.id, draft);
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
  const live = useIdsStudioDraftLibrary.getState().entries.find(entry => entry.id === draft.id);
  if (!live || live.document !== draft.document) return;
  restoring = live.id;
  try {
    const opened = restoreIdsDraft(live, useViewerStore.getState().idsStudioOpen);
    if (opened) baselines.set(live.id, live.document);
    report(live.id, opened ? undefined : 'unreadable');
  } finally {
    restoring = null;
  }
}

export function flushIdsDrafts(): Promise<boolean> { return autosave.flushAll(); }

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
  if (id && !(await autosave.flush(id))
    && (useViewerStore.getState().idsStudioRevision !== revision || !(await confirmUnsaved()))) return;
  const live = useViewerStore.getState();
  if (live.idsStudioRevision === revision) live.idsStudioClose();
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
