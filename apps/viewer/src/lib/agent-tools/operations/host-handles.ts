/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ModelChangeReceipt } from '@/lib/actions/model-change-commit';

/**
 * Make room for one more host-owned handle (run, candidate) by dropping the oldest.
 * Handles are never freed by the agent, so a hard cap would lock the host out.
 */
export function evictOldest<K, V>(handles: Map<K, V>, cap: number): void {
  while (handles.size >= cap) handles.delete(handles.keys().next().value as K);
}

/**
 * Make room for one more reviewed candidate. Only `pending` candidates count against `cap`, and a host full of
 * them is refused with `refusal`. Candidates that can never apply (`gone`) are dropped and `release`d; applied ones share the
 * cap and the oldest goes first. Call it again after any await: a concurrent prepare may have taken the room.
 */
export function admitCandidate<K, V>(handles: Map<K, V>, { cap, refusal, pending, gone = () => false, release = () => {} }: {
  cap: number; refusal: string; pending: (value: V) => boolean; gone?: (value: V) => boolean; release?: (value: V) => void;
}): void {
  let open = 0;
  for (const [key, value] of handles) {
    if (gone(value)) { handles.delete(key); release(value); }
    else if (pending(value)) open++;
  }
  if (open >= cap) throw new Error(refusal);
  for (const [key, value] of handles) {
    if (handles.size < cap) break;
    if (!pending(value)) handles.delete(key);
  }
}

/** Write an applied candidate's receipt once. A replay returns it unwritten, so it never overwrites the
 * library row the Changes panel has since marked undone; only a failed first write is retried. */
export function persistReceipt(holder: { persisting?: Promise<boolean>; persisted?: boolean }, receipt: ModelChangeReceipt): Promise<boolean> {
  // Held while in flight too, so a concurrent replay never issues a second write. `persisted` marks the candidate
  // settled: until then a replay is its only way to retry the write, so admission must not evict it.
  holder.persisting ??= import('@/lib/actions/receipts').then(({ modelChangeLibrary }) => modelChangeLibrary.put(receipt.id, receipt))
    .then(ok => { if (ok) holder.persisted = true; else holder.persisting = undefined; return ok; },
      (error: unknown) => { holder.persisting = undefined; throw error; });
  return holder.persisting;
}
