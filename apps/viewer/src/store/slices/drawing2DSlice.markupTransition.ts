/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE single choke point every `activeModelId` transition that has
 * consequences for 2D drawing markup must go through (#4159 bug 5).
 *
 * ## Why this file exists
 * `measure2DResults` and its four siblings are flat, federation-wide store
 * fields — not scoped per model — so whatever they hold is only meaningful
 * for whichever model is CURRENTLY active. Three shipped rounds of this issue
 * all trace back to the same shape: more than one place can move
 * `activeModelId`, and each one had to independently remember to clear/carry
 * the five fields along with it. `modelSlice.ts`'s `setActiveModel` got it
 * right (bugs 2 and 4). `modelSlice.teardown.ts`'s `'model-removed'` arm —
 * the ONLY other place `activeModelId` moves in production — did not: it
 * writes `activeModelId: scope.nextActiveModelId` directly, and
 * `drawing2DSlice.teardown.ts`'s own `'model-removed'` arm was `notApplicable`
 * (a deliberate no-op for the "removed model is not the active one" case,
 * but silently ALSO a no-op for "removed model IS the active one", which is
 * bug 5). `lib/sources/syncSourceModel.ts` calls the same `removeModel`
 * action, so it inherited the identical hole — see that module's own comment
 * for the concrete failure it produces when the model being synced is the
 * active one.
 *
 * Rather than teach the teardown arm the same clear-and-suppress incantation
 * `setActiveModel` uses (a FOURTH copy of the convention this class of bug
 * keeps breaking), both now call the ONE function below.
 *
 * A later pass (#4159 bug 3) found a THIRD production writer this doc
 * previously missed: `modelSlice.ts`'s `addModel`, in its
 * `state.models.size === 0` branch, sets `activeModelId: model.id` directly
 * when the very first model of a session (or of a post-`clearAllModels`
 * federation) is added. That branch now also calls `markupTransitionPatch`.
 * As far as this codebase's own action layer goes, all three of
 * `activeModelId`'s writers with markup consequences —
 * `modelSlice.ts`'s `setActiveModel` and `addModel`, and
 * `modelSlice.teardown.ts`'s `'model-removed'` arm — call
 * `markupTransitionPatch` in the same `set()` that moves the id. That is
 * a property of the action layer, not a guarantee this file can enforce: a
 * caller reaching `useViewerStore.setState()` directly still bypasses it —
 * see "What this does NOT eliminate" below.
 *
 * ## The in-session live cache
 * Beyond closing bug 5, this also strengthens bug 4's fix: an in-memory,
 * session-scoped `Map<modelId, fields>` remembers each model's live markup
 * the moment it stops being active. Switching BACK to a model visited earlier
 * this session restores that snapshot synchronously, in the SAME `set()` call
 * that moves `activeModelId` — a real, immediate restore, not a
 * clear-to-defaults that waits on `useDrawing2DPersistence.ts`'s async,
 * content-hash-keyed `localStorage` lookup to paper over it a tick later.
 *
 * That hook is DELIBERATELY untouched by this file and keeps running exactly
 * as before (see its own doc) — it owns `sectionConfig` (which this cache
 * does not carry) and remains the authority for a model's FIRST activation
 * this session, when nothing is cached here yet. Its unconditional clear +
 * hash-keyed reload, run again immediately after a cache-hit restore, is
 * therefore redundant but not harmful: the hash is already resolved for any
 * model this cache remembers (it cannot hold an entry for a model whose own
 * activation never ran the hook's hash lookup), so the reload is synchronous
 * and settles on the same data this module already restored — see
 * `drawing2DSlice.markupTransition.test.ts` and
 * `useDrawing2DPersistence.test.tsx` for the interaction pinned end to end.
 *
 * ## What this does NOT eliminate
 * A caller that changes `activeModelId` via `useViewerStore.setState()`
 * directly — bypassing both `setActiveModel` and `removeModel` — still
 * bypasses this too; nothing in Zustand can prevent that from outside the
 * store. `useDrawing2DPersistence.ts`'s own doc already names that same
 * limitation for the pre-existing suppression mechanism this builds on. What
 * changed here is that the PRODUCTION call graph now has exactly one correct
 * implementation instead of an easy-to-forget copy at every call site.
 */

import {
  defaultMarkupPatch,
  suppressNextSaveFor,
  type Drawing2DMarkupPatch,
} from './drawing2DSlice.persistence.js';

/**
 * Session-scoped only — never written to or read from `localStorage`
 * directly (that stays `drawing2DSlice.persistence.ts`'s job). Cleared
 * implicitly by a full page reload; a stale entry for a model id that no
 * longer exists is harmless (ids are `crypto.randomUUID()`, never reused) and
 * bounded by how many distinct models this session has ever activated.
 */
const liveMarkupCache = new Map<string, Drawing2DMarkupPatch>();

export interface MarkupTransitionState extends Drawing2DMarkupPatch {
  readonly activeModelId: string | null;
}

/**
 * `true` when `modelId` was active earlier THIS session — i.e. a switch onto
 * it will be restored synchronously from the in-memory cache rather than via
 * `useDrawing2DPersistence.ts`'s async `localStorage` path. Exported for
 * tests; production code has no other reason to call it.
 */
export function wasLiveMarkupCached(modelId: string): boolean {
  return liveMarkupCache.has(modelId);
}

/**
 * Build the markup patch for an `activeModelId` transition from
 * `state.activeModelId` to `nextModelId`. Call sites: `modelSlice.ts`'s
 * `setActiveModel` and `drawing2DSlice.teardown.ts`'s `'model-removed'` arm
 * — see this file's module doc.
 *
 * Returns `{}` when the id is not actually changing (re-selecting the
 * already-active model, or a `model-removed` scope whose removed model was
 * not the active one) — the same "untouched" contract every other teardown
 * arm in this codebase follows.
 */
export function markupTransitionPatch(
  state: MarkupTransitionState,
  nextModelId: string | null,
): Partial<Drawing2DMarkupPatch> {
  if (nextModelId === state.activeModelId) return {};

  if (state.activeModelId) {
    liveMarkupCache.set(state.activeModelId, {
      measure2DResults: state.measure2DResults,
      polygonArea2DResults: state.polygonArea2DResults,
      textAnnotations2D: state.textAnnotations2D,
      cloudAnnotations2D: state.cloudAnnotations2D,
      drawing2DDisplayOptions: state.drawing2DDisplayOptions,
    });
  }

  if (nextModelId === null) return defaultMarkupPatch();

  const cached = liveMarkupCache.get(nextModelId);
  if (cached) return cached;

  // Genuinely new to this session: nothing to restore synchronously.
  // `useDrawing2DPersistence.ts`'s restore effect owns the async,
  // content-hash-keyed `localStorage` lookup for this case, and needs its
  // own upcoming defaults-clear not mistaken for a real edit.
  suppressNextSaveFor(nextModelId);
  return defaultMarkupPatch();
}

/** Test-only: drop every cached snapshot so tests don't leak state between runs. */
export function __resetLiveMarkupCacheForTests(): void {
  liveMarkupCache.clear();
}
