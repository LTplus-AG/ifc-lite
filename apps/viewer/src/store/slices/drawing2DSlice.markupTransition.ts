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
 *
 * A still later pass (#4159 bug 6) found a FOURTH: `modelSlice.ts`'s
 * `upsertModel` resolves `activeModelId` as `state.activeModelId ?? model.id`
 * — the identical "adopt the first model of the session" shape `addModel`
 * has — and wrote it directly. Routed in `modelSlice.upsert.ts` (a sibling
 * module, not inline, for the same module-size reason as this file).
 *
 * This doc has now named the complete set wrong twice — first two writers,
 * then three — each time by writing "the ONLY other place" or "all N" before
 * the next review round found one more. So the honest claim is narrower:
 * **these four writers** — `modelSlice.ts`'s `setActiveModel`, `addModel` and
 * `upsertModel`, and `modelSlice.teardown.ts`'s `'model-removed'` arm — are
 * everywhere `activeModelId` moves in the PRODUCTION action layer as of this
 * writing, each confirmed by grepping every `activeModelId:` write and every
 * `useViewerStore.setState()` call under `apps/viewer/src` (excluding tests)
 * at the time this paragraph was written, and each now calls
 * `markupTransitionPatch` in the same `set()` that moves the id. That is a
 * property of the action layer, enforced by convention and this file's own
 * review history, not a guarantee this file — or any grep — can make
 * permanent: nothing stops a FIFTH writer from being added tomorrow with the
 * same field-write shape and no compiler or lint signal pointing here. A
 * caller reaching `useViewerStore.setState()` directly bypasses this
 * regardless of how many production call sites currently behave — see "What
 * this does NOT eliminate" below.
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
 *
 * ## In-progress and selection state (#4196, #4199)
 * This function's `Drawing2DMarkupPatch` return type originally covered only
 * the five COMMITTED fields above — never the in-progress placement
 * (`polygonArea2DPoints`, `cloudAnnotation2DPoints`, `measure2DStart`/
 * `measure2DCurrent`) or the live `selectedAnnotation2D`/
 * `textAnnotation2DEditing`. A half-drawn polygon spanning two coordinate
 * frames computed a plausible but wrong area on `completePolygonArea2D`, and
 * a `selectedAnnotation2D` could dangle at an id absent from the new model's
 * arrays, making Delete a silent no-op. `inProgressClearPatch()` below closes
 * this by clearing those six on every real transition this function handles
 * — never cached, never restored, unlike the five committed fields.
 * `annotation2DActiveTool` is deliberately excluded: see that function's doc.
 *
 * #4199 (this PR's own review) found the same bug class a SIXTH time inside
 * the PR meant to end it: `measure2DSnapPoint` and `annotation2DCursorPos`
 * are both frame-dependent `Point2D | null` fields — consumed for rendering
 * as `measureSnapPoint`/`annotation2DCursorPos` props in `Section2DPanel.tsx`
 * — that were on `Drawing2DState` before this file's `#4196` pass and were
 * missed by it: neither the five committed fields nor the original six
 * in-progress fields covered them. A snap indicator or cursor preview
 * computed in the outgoing model's drawing coordinates would render at the
 * wrong place over the incoming model's drawing until the next mouse-move.
 * They are now the seventh and eighth fields `inProgressClearPatch()` clears.
 *
 * That is EIGHT fields, hand-picked by `Drawing2DTransitionClearPatch`
 * below, in a file that has now undercounted its own field list six times.
 * `FIELD_CLASSIFICATION` right below makes a seventh recurrence a compile
 * error instead of a silent gap: it is `satisfies Record<keyof
 * Drawing2DState, ...>`, so TypeScript refuses to build the moment
 * `Drawing2DState` gains a key this file hasn't classified. See the two
 * exported symbols immediately below for how the in-progress type and the
 * classification stay provably in sync with each other, not just with
 * `Drawing2DState`.
 */

import {
  defaultMarkupPatch,
  suppressNextSaveFor,
  type Drawing2DMarkupPatch,
} from './drawing2DSlice.persistence.js';
import type { Drawing2DState } from './drawing2DSlice.js';

/**
 * How this file treats EVERY key of `Drawing2DState` on an `activeModelId`
 * transition — the structural fix for the recurring bug class named in the
 * module doc (six rounds, most recently #4199 finding two more fields this
 * same PR had missed).
 *
 * - `'committed'`: cached per model in `liveMarkupCache` and restored on
 *   revisit — {@link Drawing2DMarkupPatch}'s five fields, owned by
 *   `drawing2DSlice.persistence.ts`.
 * - `'in-progress'`: frame-dependent or id-referencing state that is never
 *   cached and never restored — always reset by
 *   {@link inProgressClearPatch} on every real transition. See the module
 *   doc for why: it is expressed in, or references ids scoped to, the
 *   OUTGOING model.
 * - `'preserved'`: everything else. Not touched by the returned patch at
 *   all — a session-wide UI preference (e.g. `annotation2DActiveTool`, see
 *   its own doc) or drawing-generation state owned by a different code path.
 *
 * The `satisfies Record<keyof Drawing2DState, ...>` below is the actual
 * guard: it is a TYPE ERROR, not a lint warning or a convention, for
 * `Drawing2DState` to gain a key this object does not list. A field added
 * there with no row here fails the build before it can ship uncleared.
 */
const FIELD_CLASSIFICATION = {
  drawing2D: 'preserved',
  drawing2DStatus: 'preserved',
  drawing2DProgress: 'preserved',
  drawing2DPhase: 'preserved',
  drawing2DError: 'preserved',
  drawing2DPanelVisible: 'preserved',
  suppressNextSection2DPanelAutoOpen: 'preserved',
  drawing2DSvgContent: 'preserved',
  drawing2DDisplayOptions: 'committed',
  graphicOverridePresets: 'preserved',
  activePresetId: 'preserved',
  customOverrideRules: 'preserved',
  overridesEnabled: 'preserved',
  overridesPanelVisible: 'preserved',
  measure2DMode: 'preserved',
  measure2DStart: 'in-progress',
  measure2DCurrent: 'in-progress',
  measure2DShiftLocked: 'preserved',
  measure2DLockedAxis: 'preserved',
  measure2DResults: 'committed',
  measure2DSnapPoint: 'in-progress',
  annotation2DActiveTool: 'preserved',
  annotation2DCursorPos: 'in-progress',
  polygonArea2DPoints: 'in-progress',
  polygonArea2DResults: 'committed',
  textAnnotations2D: 'committed',
  textAnnotation2DEditing: 'in-progress',
  cloudAnnotation2DPoints: 'in-progress',
  cloudAnnotations2D: 'committed',
  selectedAnnotation2D: 'in-progress',
  dxfUnderlays: 'preserved',
} satisfies Record<keyof Drawing2DState, 'committed' | 'in-progress' | 'preserved'>;

/** Exported for `drawing2DSlice.markupTransition.test.ts` only — production code has no other reason to read the raw classification. */
export const drawing2DFieldClassificationForTests = FIELD_CLASSIFICATION;

/**
 * Keys of `FIELD_CLASSIFICATION` classified `'in-progress'`, derived by
 * TYPE from the object above rather than re-listed — the second half of the
 * structural fix. Reclassifying a field to or from `'in-progress'` changes
 * this type automatically, which in turn changes what
 * {@link inProgressClearPatch} is required to return: adding a key here
 * with no matching line in that function's return object is a compile
 * error, not a silent gap.
 */
type InProgressKey = {
  [K in keyof typeof FIELD_CLASSIFICATION]: (typeof FIELD_CLASSIFICATION)[K] extends 'in-progress' ? K : never;
}[keyof typeof FIELD_CLASSIFICATION];

/**
 * The in-progress and selection fields (#4196, #4199) — distinct from
 * {@link Drawing2DMarkupPatch}'s five COMMITTED fields, which are cached per
 * model and restored on revisit (see `liveMarkupCache` above). These are
 * never cached and never restored: they are always reset to their cleared
 * value on a real `activeModelId` transition, regardless of which model is
 * next or whether it has a live cache entry.
 *
 * A half-placed polygon or an in-flight measurement, or a snap/cursor
 * preview point, is expressed in the OUTGOING model's coordinate frame;
 * carrying it into the next model's `set()` would compute results (area,
 * perimeter, distance) or render a preview that silently mixes two frames —
 * see this file's module doc and the issues this closes. A dangling
 * `selectedAnnotation2D` is worse than merely meaningless: it can reference an
 * id absent from the new model's arrays, so Delete becomes a silent no-op
 * while the selection UI still shows something selected.
 *
 * `annotation2DActiveTool` is deliberately NOT in this list (classified
 * `'preserved'` above). Unlike the fields above, the chosen tool (measure /
 * polygon / cloud / text / none) carries no coordinate-frame data of its
 * own — it is a UI preference for "what happens on the next click", not a
 * value computed from points in a frame. A user switching models
 * mid-session keeps the tool they had selected; only the half-drawn shape
 * underneath it is discarded. Leaving it out of the returned patch means
 * `set()` never touches it, which is exactly "persist" for a Zustand
 * partial patch.
 */
type Drawing2DTransitionClearPatch = Pick<Drawing2DState, InProgressKey>;

/**
 * Exported for `drawing2DSlice.markupTransition.test.ts` only — production
 * code calls this indirectly through {@link markupTransitionPatch}. The test
 * asserts this function's own key set exactly matches `FIELD_CLASSIFICATION`'s
 * `'in-progress'` keys, so a reclassification with no matching line here (or
 * vice versa) fails at test time even though both already agree at compile
 * time via {@link InProgressKey}.
 */
export function inProgressClearPatch(): Drawing2DTransitionClearPatch {
  return {
    polygonArea2DPoints: [],
    cloudAnnotation2DPoints: [],
    measure2DStart: null,
    measure2DCurrent: null,
    measure2DSnapPoint: null,
    annotation2DCursorPos: null,
    selectedAnnotation2D: null,
    textAnnotation2DEditing: null,
  };
}

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
): Partial<Drawing2DMarkupPatch> & Partial<Drawing2DTransitionClearPatch> {
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

  // #4196: in-progress placement and any live selection belong to the
  // OUTGOING model's coordinate frame (or reference ids from its arrays) and
  // are never meaningful after `activeModelId` actually moves — on EVERY
  // arm below, not just the cache-miss "genuinely new model" case. See
  // `inProgressClearPatch`'s doc for why `annotation2DActiveTool` is
  // excluded from this and therefore persists across the switch.
  const clearInProgress = inProgressClearPatch();

  if (nextModelId === null) return { ...defaultMarkupPatch(), ...clearInProgress };

  const cached = liveMarkupCache.get(nextModelId);
  if (cached) return { ...cached, ...clearInProgress };

  // Genuinely new to this session: nothing to restore synchronously.
  // `useDrawing2DPersistence.ts`'s restore effect owns the async,
  // content-hash-keyed `localStorage` lookup for this case, and needs its
  // own upcoming defaults-clear not mistaken for a real edit.
  suppressNextSaveFor(nextModelId);
  return { ...defaultMarkupPatch(), ...clearInProgress };
}

/** Test-only: drop every cached snapshot so tests don't leak state between runs. */
export function __resetLiveMarkupCacheForTests(): void {
  liveMarkupCache.clear();
}
