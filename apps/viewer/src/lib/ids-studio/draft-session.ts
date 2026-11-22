/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StudioDocument } from '@ifc-lite/ids-authoring';
import { encodeIdsStudioDraft, type IdsStudioDraft } from './draft-codec.js';
import { readIdsDraftDocument } from './draft-document.js';

export const IDS_DRAFT_DEBOUNCE_MS = 400;

export type IdsDraftFeedback = 'pending' | 'tooLarge' | 'serialize' | 'conflict';

interface DraftWrite {
  timer?: ReturnType<typeof setTimeout>;
  promise?: Promise<boolean>;
  doc: StudioDocument;
}

export function createIdsDraftAutosave(
  put: (draft: IdsStudioDraft) => Promise<boolean | 'conflict'>,
  report: (id: string, feedback: IdsDraftFeedback | null) => void,
) {
  const jobs = new Map<string, DraftWrite>();
  const flush = (id: string): Promise<boolean> => {
    const job = jobs.get(id);
    if (!job) return Promise.resolve(true);
    if (job.promise) return job.promise;
    clearTimeout(job.timer);
    const encoded = encodeIdsStudioDraft(id, job.doc);
    if (!encoded.ok) {
      report(id, encoded.reason);
      return Promise.resolve(false);
    }
    job.promise = put(encoded.draft).then(result => {
      if (jobs.get(id) === job) {
        if (result === true) jobs.delete(id);
        report(id, result === 'conflict' ? result : null);
      }
      job.promise = undefined;
      return result === true;
    });
    return job.promise;
  };
  return {
    schedule(id: string, doc: StudioDocument): void {
      clearTimeout(jobs.get(id)?.timer);
      jobs.set(id, { doc, timer: setTimeout(() => { void flush(id); }, IDS_DRAFT_DEBOUNCE_MS) });
      report(id, 'pending');
    },
    flush,
    async flushAll(): Promise<boolean> { return (await Promise.all([...jobs.keys()].map(flush))).every(Boolean); },
    forget(id: string): void {
      clearTimeout(jobs.get(id)?.timer);
      jobs.delete(id);
    },
  };
}

/** An IDS opened while storage loads owns the editor until the user chooses a draft. */
export async function restoreInitialIdsDraft(
  initialize: () => Promise<boolean>,
  read: () => { revision: number; drafts: readonly IdsStudioDraft[] },
  restore: (draft: IdsStudioDraft) => boolean,
): Promise<void> {
  if (read().revision !== 0 || !(await initialize())) return;
  const { revision, drafts } = read();
  if (revision !== 0) return;
  for (const draft of [...drafts].sort((left, right) => right.savedAt - left.savedAt)) {
    if (restore(draft)) return;
  }
}

export function restoreIdsDraft(draft: IdsStudioDraft, open: (doc: StudioDocument, id: string) => void): boolean {
  try {
    open(readIdsDraftDocument(draft), draft.id);
    return true;
  } catch (error) {
    console.warn('[IDS Studio] Saved draft is unreadable; original preserved', error);
    return false;
  }
}
