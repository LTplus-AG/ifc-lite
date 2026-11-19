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
 * Make room for `count` more reviewed candidates (one by default). Every admission site answers one question, `canApply`: could this
 * candidate still apply (or, once applied, replay)? Those that cannot are dropped and `release`d. Of the rest, only
 * `pending` ones count against `cap`, and a host full of them is refused with `refusal`; the others share the cap
 * and the oldest goes first. Call it again after any await: a concurrent prepare may have taken the room.
 */
export function admitCandidate<K, V>(handles: Map<K, V>, { cap, refusal, pending, canApply, release = () => {}, count = 1 }: {
  cap: number; refusal: string; pending: (value: V) => boolean; canApply: (value: V) => boolean; release?: (value: V) => void; count?: number;
}): void {
  let open = 0;
  for (const [key, value] of handles) {
    if (canApply(value)) { if (pending(value)) open++; continue; }
    handles.delete(key);
    try { release(value); } catch (error) { console.warn('[viewer operations] Releasing a stale candidate failed:', error); }
  }
  // Refused before anything settled is evicted, so a refusal leaves the host as it was.
  if (open + count > cap) throw new Error(refusal);
  for (const [key, value] of handles) {
    if (handles.size + count <= cap) break;
    if (!pending(value)) handles.delete(key);
  }
}

/**
 * The one staleness test every admission site passes as `canApply`: a candidate can still apply while the model it
 * was prepared on is loaded with the same store (the host's model list also covers the single-model session) and it
 * either already applied (a replay) or is `unchanged` since its prepare, by the same permanent check its own apply
 * makes. Temporary refusals such as Edit mode being off are not staleness, so they keep the candidate.
 */
export function candidateStillApplies(host?: ToolHost) {
  const live = host ? new Map(host.models().map(model => [model.id, model.store])) : null;
  return (applied: boolean, unchanged: () => boolean, bound?: { modelId: string; store: unknown }): boolean =>
    (!live || !bound || live.get(bound.modelId) === bound.store) && (applied || unchanged());
}

/** An applied candidate's receipt write. `handedOff` once the library holds the receipt (saved, or kept as its draft):
 * admission may then evict the candidate, because the receipt survives it. */
export interface ReceiptHolder { persisting?: Promise<boolean>; handedOff?: boolean }

/**
 * Save an applied candidate's receipt. The first write puts it; a successful one is cached, so a replay never
 * overwrites the library row the Changes panel has since marked undone. An unsaved one is kept by the library as a
 * dirty draft that only its `retry` writes again (the panel's Retry button), so a replay retries through `retry`,
 * which saves the library's latest draft (an undone mark included), never this receipt again.
 */
export function persistReceipt(holder: ReceiptHolder, receipt: ModelChangeReceipt): Promise<boolean> {
  holder.persisting ??= import('@/lib/actions/receipts').then(async ({ modelChangeLibrary, useModelChangeReceipts }) => {
    if (!holder.handedOff) { holder.handedOff = true; return modelChangeLibrary.put(receipt.id, receipt); }
    const saved = () => useModelChangeReceipts.getState().status.items[receipt.id] === 'saved';
    if (saved()) return true; // the panel's Retry may have saved it already
    await modelChangeLibrary.retry();
    return saved();
  }).then(saved => { if (!saved) holder.persisting = undefined; return saved; },
    (error: unknown) => { holder.persisting = undefined; throw error; });
  return holder.persisting;
}
