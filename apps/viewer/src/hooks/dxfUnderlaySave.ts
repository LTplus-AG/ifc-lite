/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dxfUnderlays`'s half of the #4153 persistence bridge — the IndexedDB
 * counterpart to `drawingMarkupSave.ts`'s `localStorage` save subscription.
 * Split into its own module for the same module-size-budget reason as that
 * file and `useDrawing2DPersistence.ts`; wired into both from
 * `useDrawing2DPersistence.ts` (`ensureDxfUnderlaySaveSubscription` alongside
 * `ensureSaveSubscription`, and {@link restoreDxfUnderlaysFor} from inside
 * that hook's `applyHash`).
 *
 * ## Why this does NOT reuse `drawingMarkupSave.ts`'s suppress/restoring-model
 * guards
 * Those guards (`suppressNextSaveFor`, `restoringModelId`) exist because the
 * five markup fields are cleared to defaults and re-restored on EVERY
 * `activeModelId` transition (`FIELD_CLASSIFICATION`'s `'committed'`), which
 * creates a window where an atomic clear looks identical to a genuine edit.
 * `dxfUnderlays` is classified `'preserved'` — `markupTransitionPatch` never
 * touches it on a switch — so there is no accompanying clear for a save
 * listener to mistake for a real change, and no restore-vs-genuine-edit
 * ambiguity to suppress. The only guard this module needs is the same
 * `stillCurrent()` check `useDrawing2DPersistence.ts` already threads through
 * every other async step in its restore effect, so a slow IndexedDB lookup
 * for a model the user has since switched away from can never land on the
 * wrong model's state.
 *
 * ## Save coalescing
 * IndexedDB writes are async; a rapid sequence of edits to the same model
 * (e.g. dragging a placement slider) must not queue unboundedly many
 * overlapping writes. `enqueueSave` keeps at most one write per hash
 * in-flight and one pending value behind it — any edits arriving while a
 * write is already running simply replace the pending value, so the pending
 * write loop below always ends up persisting whatever was most recently set,
 * without executing every intermediate value or adding a debounce timer.
 */

import { useViewerStore } from '@/store';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice.js';
import {
  loadDxfUnderlaysEntry,
  saveDxfUnderlaysEntry,
  mergeDxfUnderlays,
} from '@/store/slices/drawing2DSlice.dxfPersistence.js';
import { getCachedHash } from './drawingMarkupRestorePrecedence.js';

// ── Save ─────────────────────────────────────────────────────────────

/** hash -> the most recently requested `dxfUnderlays` value not yet written. */
const pendingByHash = new Map<string, DxfUnderlayState[]>();
/** hash -> the write loop currently draining {@link pendingByHash} for it. */
const drainsByHash = new Map<string, Promise<void>>();
/** model id -> latest edit made while that model's content hash was unresolved. */
const pendingByModelId = new Map<string, DxfUnderlayState[]>();

function drain(hash: string): Promise<void> {
  const active = drainsByHash.get(hash);
  if (active) return active;

  const task = (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const value = pendingByHash.get(hash);
        if (value === undefined) break;
        pendingByHash.delete(hash);
        await saveDxfUnderlaysEntry(hash, value);
      }
    } finally {
      drainsByHash.delete(hash);
    }
  })();
  drainsByHash.set(hash, task);
  return task;
}

function enqueueSave(hash: string, dxfUnderlays: DxfUnderlayState[]): void {
  pendingByHash.set(hash, dxfUnderlays);
  void drain(hash);
}

/** Resolves once no write for `hash` is in flight or queued behind one. */
export async function waitForPendingDxfUnderlaySave(hash: string): Promise<void> {
  const active = drainsByHash.get(hash);
  if (active) await active;
}

/** Registers the raw store subscription that saves `dxfUnderlays` on every change, scoped to the active model's already-resolved content hash. Idempotent — module-level, subscribed once regardless of how many components mount `useDrawing2DPersistence`. */
let saveSubscriptionStarted = false;
export function ensureDxfUnderlaySaveSubscription(): void {
  if (saveSubscriptionStarted) return;
  saveSubscriptionStarted = true;
  let prev = useViewerStore.getState();
  useViewerStore.subscribe((state) => {
    const changed = state.dxfUnderlays !== prev.dxfUnderlays;
    const modelId = state.activeModelId;
    prev = state;
    if (!changed || !modelId) return;
    // Retain the latest value while hashing. Dropping it here loses edits
    // made immediately after model activation because no later store change
    // is guaranteed to replay them once the hash resolves.
    const hash = getCachedHash(modelId);
    if (hash === undefined) {
      pendingByModelId.set(modelId, state.dxfUnderlays);
      return;
    }
    pendingByModelId.delete(modelId);
    if (!hash) return;
    enqueueSave(hash, state.dxfUnderlays);
  });
}

/** Flush the latest edit captured while `modelId` was still hashing. Returns whether a live value is pending and supersedes restore. */
export function settleDxfUnderlayHash(modelId: string, hash: string | null): boolean {
  const pending = pendingByModelId.get(modelId);
  pendingByModelId.delete(modelId);
  if (hash && pending !== undefined) enqueueSave(hash, pending);
  const skip = pending !== undefined || (hash !== null && drainsByHash.has(hash));
  return skip;
}

// ── Restore ──────────────────────────────────────────────────────────

/**
 * Load `hash`'s saved `dxfUnderlays` (if any) and additively merge them
 * into the live store — called from `useDrawing2DPersistence.ts`'s
 * `applyHash` once a model's content hash has resolved.
 *
 * `stillCurrent` is the SAME closure that hook's restore effect already
 * uses to guard its other async steps: it is only `true` while the effect
 * that started this call is still the latest one for the active model, so a
 * fast switch away (and possibly back) while this lookup is in flight
 * cannot let a stale result land on the wrong model's `dxfUnderlays`.
 *
 * A `null` load result (nothing saved for `hash`, or a corrupt stored
 * value) leaves the store's `dxfUnderlays` completely untouched — no
 * `setState` call at all — which is what "restores as absent, not as an
 * explicit empty array" means at this layer: {@link mergeDxfUnderlays}'s own
 * `saved.length === 0` branch would already no-op on an explicit `[]`, but
 * this function does not even reach that branch for `null`.
 */
export async function restoreDxfUnderlaysFor(
  hash: string,
  stillCurrent: () => boolean,
): Promise<void> {
  // A cached A→B→A switch can arrive while A's latest removal is coalesced
  // behind an in-flight write. Reading before that drain commits would merge
  // the older saved underlay back into the live workspace.
  await waitForPendingDxfUnderlaySave(hash);
  if (!stillCurrent()) return;
  const saved = await loadDxfUnderlaysEntry(hash);
  if (!stillCurrent()) return;
  if (!saved) return;

  const current = useViewerStore.getState().dxfUnderlays;
  const merged = mergeDxfUnderlays(current, saved.dxfUnderlays);
  if (merged !== current) useViewerStore.setState({ dxfUnderlays: merged });
}
