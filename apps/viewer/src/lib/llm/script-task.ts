/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One explicit scripting task; Continue and automatic repair spend its same budget (#7093). */
import { useViewerStore } from '@/store';
import { createRootBudget } from './root-budget';
import type { RootBudget } from '@ifc-lite/ai';

export interface ScriptTask {
  budget: RootBudget; truncated: boolean; continuationText?: string; cancel?: () => void;
  /** The editor state the truncated turn's edit ops target. */
  continuationScript?: { revision: number; content: string };
}
let current: ScriptTask | null = null;

export function beginScriptTask(): ScriptTask {
  current = { budget: createRootBudget(), truncated: false };
  return current;
}
export function currentScriptTask(): ScriptTask | null { return current; }
export function ownsScriptTask(task: ScriptTask): boolean { return current === task; }
/**
 * Continue replays the truncated turn's ops, which carry the revision that turn began at.
 * Rollback restored that content under a newer revision (revisions never repeat), so the
 * old token is honoured only while the editor still holds exactly that content.
 */
export function continuationRevision(task: ScriptTask, continuing: boolean, live: { scriptEditorContent: string; scriptEditorRevision: number }): number {
  const base = continuing ? task.continuationScript : undefined;
  return base?.content === live.scriptEditorContent ? base.revision : live.scriptEditorRevision;
}

// Module ownership survives panel remounts. Clearing/changing the conversation
// ends the task, so a delayed script execution cannot start a repair in a new chat.
useViewerStore.subscribe((state, previous) => {
  if ((previous.chatMessages.length > 0 && state.chatMessages.length === 0)
    || state.chatStorageUserId !== previous.chatStorageUserId) {
    const task = current;
    // Abort while it still owns its edit transaction; its listener rolls back
    // before revocation prevents later completion/repair from publishing.
    task?.cancel?.();
    if (current === task) current = null;
  }
});
