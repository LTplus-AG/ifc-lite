/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Compound history for commits that rewrite or forget earlier overlay
 * entities (#6232 D5). A raw mutation journal cannot reconstruct those graphs. */
import { cooperativeOverlay } from './cooperative-overlay-access.js';
import { captureCompoundInverse, restoreCompoundInverse, type CompoundInverse } from './compound-inverse.js';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation } from './types.js';

interface CompoundRecord {
  inverse: CompoundInverse;
  written: string[];
}
const records = new WeakMap<MutablePropertyView, Map<string, CompoundRecord>>();

/** Run a synchronous compound edit atomically and retain its complete
 * touched-entry inverse as one undo operation. The callback must write through
 * the supplied draft; external effects belong after this call returns. */
export function recordCompoundMutation<T>(view: MutablePropertyView, edit: (draft: MutablePropertyView) => T): T {
  const before = structuredClone(cooperativeOverlay(view).capture());
  const seen = new Set(before.mutationHistory.map(m => m.id));
  let written: string[] = [];
  let inverse: CompoundInverse | undefined;
  const result = view.runAtomic(draft => {
    const value = edit(draft);
    written = draft.getMutations().filter(m => !seen.has(m.id)).map(m => m.id);
    if (written.length === 0 && !cooperativeOverlay(draft).matches(before)) {
      throw new Error('A compound edit must record its mutations');
    }
    if (written.length) inverse = captureCompoundInverse(before, cooperativeOverlay(draft).capture());
    return value;
  });
  if (inverse) {
    let map = records.get(view);
    if (!map) records.set(view, map = new Map());
    const record = { inverse, written };
    for (const id of written) map.set(id, record);
  }
  return result;
}

/** Undo the last N operations atomically. A recorded compound restores the
 * entire earlier graph and journal, including forgotten overlay records.
 * Other journal entries use the caller's inverse dispatcher. Returns the
 * number of mutation records reverted; a compound counts as one operation.
 * Allocated express IDs remain monotonic, so stale references cannot target
 * a different entity created after an undo. */
export function undoRecordedMutationOperations(
  view: MutablePropertyView,
  count: number,
  revertRaw: (draft: MutablePropertyView, mutation: Mutation) => void,
): number {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('Undo operation count must be a non-negative integer');
  const map = records.get(view);
  const consumed = new Set<CompoundRecord>();
  const reverted = view.runAtomic(draft => {
    let reverted = 0;
    for (let step = 0; step < count; step++) {
      const history = draft.getMutations();
      const last = history.at(-1);
      if (!last) break;
      const record = map?.get(last.id);
      const access = cooperativeOverlay(draft);
      if (record) {
        // A later raw operation must be undone first, never erased by a
        // checkpoint. Matching the current tail establishes this order.
        const suffix = history.slice(-record.written.length).map(m => m.id);
        if (suffix.length !== record.written.length || suffix.some((id, i) => id !== record.written[i])) {
          throw new Error('Compound history changed; refusing to erase intervening mutations');
        }
        const state = access.capture();
        restoreCompoundInverse(state, record.inverse, record.written.length);
        access.publish(state);
        consumed.add(record);
        reverted += record.written.length;
      } else {
        const result: unknown = revertRaw(draft, last);
        if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && 'then' in result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(error => console.error('Discarded asynchronous undo failed', error));
          throw new TypeError('Undo dispatchers must be synchronous');
        }
        const state = access.capture();
        state.mutationHistory = history.slice(0, -1);
        access.publish(state);
        reverted++;
      }
    }
    return reverted;
  });
  // A failed inverse publishes neither IFC changes nor ledger changes.
  for (const record of consumed) for (const id of record.written) map?.delete(id);
  return reverted;
}
