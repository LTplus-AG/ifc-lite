/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One explicit scripting task; Continue and automatic repair spend its same budget (#7093). */
import { useViewerStore } from '@/store';
import { createRootBudget } from './root-budget';
import type { RootBudget } from '@ifc-lite/ai';

export interface ScriptTask { budget: RootBudget; truncated: boolean }
let current: ScriptTask | null = null;

export function beginScriptTask(): ScriptTask {
  current = { budget: createRootBudget(), truncated: false };
  return current;
}
export function currentScriptTask(): ScriptTask | null { return current; }
export function ownsScriptTask(task: ScriptTask): boolean { return current === task; }

// Module ownership survives panel remounts. Clearing/changing the conversation
// ends the task, so a delayed script execution cannot start a repair in a new chat.
useViewerStore.subscribe((state, previous) => {
  if ((previous.chatMessages.length > 0 && state.chatMessages.length === 0)
    || state.chatStorageUserId !== previous.chatStorageUserId) current = null;
});
