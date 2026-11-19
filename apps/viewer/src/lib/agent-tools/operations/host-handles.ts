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
  // Refused before any candidate that can still apply is evicted (only stale ones are gone by now).
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

/** Where an applied candidate's receipt is. Absent: nothing the library holds (not applied, or its write failed
 * before the library recorded it), so a replay puts it. `writing`: a write in flight, which a replay shares.
 * `handed-off`: the library took it (kept as an unsaved draft, which only its `retry` writes again). `saved`: done. */
export type ReceiptPersistence = { state: 'writing'; write: Promise<boolean> } | { state: 'handed-off' } | { state: 'saved' };
export interface ReceiptHolder { persistence?: ReceiptPersistence }
const SAVED: ReceiptPersistence = { state: 'saved' }, HANDED_OFF: ReceiptPersistence = { state: 'handed-off' };
/** Admission may evict a candidate once the library holds its receipt, because the receipt survives it. */
export const libraryHoldsReceipt = (holder: ReceiptHolder) => holder.persistence?.state === 'handed-off' || holder.persistence?.state === 'saved';

/**
 * Save an applied candidate's receipt. A saved one is never written again, so a replay never overwrites the library
 * row the Changes panel has since marked undone. A draft the library holds is written only through its `retry`, which
 * saves the library's latest draft (an undone mark included), never this receipt again. Each write ends in the state
 * the library reports for the receipt, so a failure at any point leaves a state the next replay can act on.
 */
export function persistReceipt(holder: ReceiptHolder, receipt: ModelChangeReceipt): Promise<boolean> {
  const before = holder.persistence;
  if (before?.state === 'writing') return before.write;
  if (before?.state === 'saved') return Promise.resolve(true);
  const write = import('@/lib/actions/receipts').then(async ({ modelChangeLibrary, useModelChangeReceipts }) => {
    const status = () => useModelChangeReceipts.getState().status.items[receipt.id];
    // A write that saved is done, even while a newer write of the same row (the panel's undo) is still in flight.
    // Once handed off, the library owns the receipt: if it later drops it (a restore), a replay never puts it back.
    const settle = (saved = false) => {
      const now = status();
      holder.persistence = saved || now === 'saved' ? SAVED : now !== undefined || before?.state === 'handed-off' ? HANDED_OFF : undefined;
      return holder.persistence === SAVED;
    };
    try {
      if (before?.state !== 'handed-off') return settle(await modelChangeLibrary.put(receipt.id, receipt));
      if (status() !== 'saved') await modelChangeLibrary.retry(); // the panel's Retry may have saved it already
      return settle();
    } catch (error) { settle(); throw error; }
  }, (error: unknown) => { holder.persistence = before; throw error; });
  holder.persistence = { state: 'writing', write };
  return write;
}
