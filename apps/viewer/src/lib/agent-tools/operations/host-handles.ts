/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import type { ToolHost } from '../types';

/**
 * Make room for one more host-owned handle (run, candidate) by dropping the oldest.
 * Handles are never freed by the agent, so a hard cap would lock the host out.
 */
export function evictOldest<K, V>(handles: Map<K, V>, cap: number): void {
  while (handles.size >= cap) handles.delete(handles.keys().next().value as K);
}

/**
 * Make room for one more reviewed candidate. Every admission site answers one question, `canApply`: could this
 * candidate still apply (or, once applied, replay)? Those that cannot are dropped and `release`d. Of the rest, only
 * `pending` ones count against `cap`, and a host full of them is refused with `refusal`; settled ones share the cap
 * and the oldest goes first. Call it again after any await: a concurrent prepare may have taken the room.
 */
export function admitCandidate<K, V>(handles: Map<K, V>, { cap, refusal, pending, canApply, release = () => {} }: {
  cap: number; refusal: string; pending: (value: V) => boolean; canApply: (value: V) => boolean; release?: (value: V) => void;
}): void {
  let open = 0;
  for (const [key, value] of handles) {
    if (!canApply(value)) { handles.delete(key); release(value); }
    else if (pending(value)) open++;
  }
  if (open >= cap) throw new Error(refusal);
  for (const [key, value] of handles) {
    if (handles.size < cap) break;
    if (!pending(value)) handles.delete(key);
  }
}

/** True while the model a candidate was prepared on is still loaded with the same store. The host's own model list
 * also covers the single-model session, whose store is not in `models`. */
export function liveModelStores(host: ToolHost): (modelId: string, store: unknown) => boolean {
  const live = new Map(host.models().map(model => [model.id, model.store]));
  return (modelId, store) => live.get(modelId) === store;
}

/** An applied candidate's receipt write. `settled` once it resolved: admission may then evict the candidate. */
export interface ReceiptHolder { persisting?: Promise<boolean>; settled?: boolean }

/** Write an applied candidate's receipt once. A replay returns the first write's result unwritten, so it never
 * overwrites the library row the Changes panel has since marked undone. A write that resolved `false` is not
 * lost: `createContentLibrary`'s put keeps the receipt as a dirty draft and its `retry` writes it again
 * (lib/storage/content-library.ts). Only a write that threw is retried, by the next replay. */
export function persistReceipt(holder: ReceiptHolder, receipt: ModelChangeReceipt): Promise<boolean> {
  holder.persisting ??= import('@/lib/actions/receipts').then(({ modelChangeLibrary }) => modelChangeLibrary.put(receipt.id, receipt))
    .then(ok => { holder.settled = true; return ok; }, (error: unknown) => { holder.persisting = undefined; throw error; });
  return holder.persisting;
}
