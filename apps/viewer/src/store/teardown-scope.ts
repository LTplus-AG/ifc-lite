/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place the `model-removed` scope — and the survivor predicate it
 * carries — is built.
 *
 * `store/teardown.ts` says what a scope IS; this says how the interesting one
 * is COMPUTED, because that computation needs federation knowledge (offsets,
 * parse ranges, overlay allocations) that the contract deliberately does not.
 *
 * Two call sites, one implementation, and that is the point: before this seam,
 * `modelSlice.removeModel` and `lib/sources/syncSourceModel.ts`'s
 * `purgeStaleEntityState` each carried their own copy of the loop below, held
 * together by a prose comment ("same shape as `purgeStaleEntityState`", twice).
 * They differed only in which models counted as survivors, which is exactly
 * what {@link modelRemovedScope}'s third argument expresses.
 */

import type { TeardownScope, TeardownState } from './teardown.js';
import { localIdInParseRange, localIdInOverlay } from './globalId.js';

/** The `model-removed` arm, once its predicate is known. */
export type ModelRemovedScope = Extract<TeardownScope, { kind: 'model-removed' }>;

/**
 * Build the scope for "this model is going away".
 *
 * The survivor predicate below calls `localIdInParseRange` / `localIdInOverlay`
 * (`store/globalId.ts`) — the same functions `modelSlice`'s unscoped and
 * scoped resolvers call (#2697) — instead of re-spelling the range/overlay
 * arithmetic a third time (#3343). `store/globalId.ts` is the cycle-free home:
 * this file cannot import `modelSlice` (that file imports this one), and
 * `globalId.ts` imports neither.
 *
 * The predicate mirrors the two-pass resolution in `modelSlice`'s
 * `resolveGlobalIdFromModels`: a global id survives if some SURVIVING model
 * owns it, either inside its parse-time range (`idOffset` ..
 * `idOffset + maxExpressId`) or as an overlay-allocated entity above that
 * range in its mutation view (StoreEditor duplicates, scripted adds). An id no
 * survivor owns is stale, and every global-id-keyed slice drops it. Unlike
 * `resolveGlobalIdFromModels`'s two full passes (parse range for every model,
 * THEN overlay for every model — needed there because it must pick a single
 * WINNING model), this only needs a yes/no per id, so it checks each survivor
 * fully (parse range, then overlay) before moving to the next: the two orders
 * agree on membership because "some survivor owns it via A or B" is the same
 * boolean regardless of which survivor or which check is tried first.
 *
 * @param state - the store as it stands BEFORE the teardown's `set`. Read-only
 *   and partial: `slices/modelSlice.test.ts` drives `removeModel` through a
 *   harness that stubs `get()` with the model slice alone, so `mutationViews`
 *   is genuinely absent on a path that reaches here. An absent map simply
 *   means no overlay ids exist to rescue.
 * @param modelId - the model being removed. Never a survivor, whether it is
 *   still in `models` (`removeModel` builds the scope before its own `set`) or
 *   already gone (`syncSourceModel` builds it after).
 * @param notYetASurvivor - a model that IS in `models` but must not count.
 *   `syncSourceModel` loads the replacement FIRST and swaps only on success,
 *   so by the time it purges, the replacement is loaded and holds a fresh
 *   offset range. Nothing can legitimately reference it yet, and a stale id —
 *   notably an old overlay id, which range-filtering on the removed model's
 *   own range would let escape — can land inside that new range and silently
 *   mis-highlight an unrelated entity. Omitted by `removeModel`, which has no
 *   such incoming model.
 */
export function modelRemovedScope(
  state: TeardownState,
  modelId: string,
  notYetASurvivor?: string,
): ModelRemovedScope {
  const survivors = Array.from(state.models?.values() ?? []).filter(
    (model) => model.id !== modelId && model.id !== notYetASurvivor,
  );
  const mutationViews = state.mutationViews;

  const isStale = (id: number): boolean => {
    for (const survivor of survivors) {
      if (localIdInParseRange(survivor, id) !== null) return false;
      if (localIdInOverlay(survivor, id, mutationViews?.get(survivor.id)) !== null) return false;
    }
    return true;
  };

  // Resolved here, once, because two slices owning different keys both have to
  // follow it (see `nextActiveModelId` on TeardownScope). Insertion order picks
  // the successor, exactly as `Array.from(newModels.keys())[0]` did before this
  // moved behind the seam. `notYetASurvivor` is deliberately NOT excluded: a
  // resync's replacement is a legitimate active model, it is only barred from
  // rescuing stale ids.
  const remaining = [...(state.models?.keys() ?? [])].filter((id) => id !== modelId);
  const nextActiveModelId =
    state.activeModelId === modelId ? (remaining[0] ?? null) : (state.activeModelId ?? null);

  return { kind: 'model-removed', modelId, isStale, nextActiveModelId };
}
