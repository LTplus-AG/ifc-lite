/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seam viewer-state teardown never had.
 *
 * Four hand-written implementations decide today what a model switch, a model
 * removal, a full federation clear and a source resync each wipe:
 *
 *   - `store/index.ts` `resetViewerState`        186 keys, 26 slices
 *   - `slices/modelSlice.ts` `removeModel`        24 keys
 *   - `slices/modelSlice.ts` `clearAllModels`     18 keys
 *   - `lib/sources/syncSourceModel.ts` `purgeStaleEntityState`  14 keys
 *
 * Every one of those keys is owned by a slice that ALREADY declares its
 * initial value one file over; the teardown paths restate the value a second
 * time, in a file that cannot see the slice. `modelSlice` even declared 16
 * fields it did not own (`ModelCrossSliceState`) purely so its teardown could
 * type-check its reach into five other slices — that interface is gone, and
 * its disappearance from PRODUCTION is the measure of this change. Be precise
 * about the word: the same 16-field list still exists in `modelSlice.test.ts`
 * as `ModelHarnessCrossState`, and it is the sole reason `TeardownState` below
 * is `Partial` rather than total, which in turn is why model-removed
 * contributions carry `?? new Set()` fallbacks. Giving that harness a real
 * store would delete the list and the fallbacks together. The four copies were held
 * together by prose: "same shape as `purgeStaleEntityState`", twice.
 *
 * This module replaces the prose with a contract. Each slice contributes
 * ONE function that answers "what do I clear under this scope, and nothing
 * else"; the entry points compose those contributions into a single patch and
 * hand it to the store's `set`.
 *
 * ## What a teardown MAY NOT do
 *
 * A `SliceTeardown` is a PURE function of `(scope, state)`. It returns a
 * patch. It does not call `set`, does not call another slice's action, and
 * does not touch the renderer or the federation registry, and does not WRITE
 * `localStorage`. It may READ a persisted preference: Trap B below requires it
 * (`visibilitySlice` re-reads `typeVisibility` / `typeViewMode`), which is why
 * `viewerTeardown` is not a pure function of its arguments alone.
 *
 * That is not stylistic. Three of the four entry points sequence ORDERED side
 * effects around their `set()`, and the order is load-bearing and tested:
 *
 *   - `endClashScenePresentation` must RELEASE the shared visibility channels
 *     before the clash slice's own clear nulls `clashVisibilityOwned`
 *     (`lib/clash/visibility-ownership.ts` documents the mutation that proves
 *     it: 8 tests across three files).
 *   - `clearIdsValidationReport` releases before it nulls its record, for the
 *     same reason.
 *   - `resetViewerState` calls `clearLastSectionMode()` (localStorage),
 *     `invalidateVisibleBasketCache()` and `get().resetAllMeasurementState()`
 *     BEFORE its `set`, and `endClashScenePresentation` AFTER it.
 *   - `removeModel` runs `clearMutations` / `clearMutationView` /
 *     `removeSourceTag` / the clash + IDS releases BEFORE its `set`.
 *
 * Those stay exactly where they are, in the entry point, in the same order.
 * Only the `set()` PAYLOAD moves behind this seam.
 *
 * ## Where a contribution lives
 *
 * Inline at the bottom of the slice, or in a sibling `<slice>.teardown.ts`. The
 * rule is the module-size ratchet and nothing else: sibling file iff the slice
 * plus its contribution would cross ~400 lines, inline otherwise. Two files
 * (`addElementSlice.teardown.ts` at 341, `annotationsSlice.teardown.ts` at 365)
 * are split despite fitting, for group uniformity; that reason does not survive
 * contact with the nine inline contributions on larger hosts, and folding those
 * two back in would make the rule exceptionless.
 *
 * ## Trap A: a teardown returns an EXPLICIT field list, never a whole state
 *
 * `scripts/check-whole-state-reset.mjs` (proposal, issue #2802) documents
 * three bugs of this class that landed in one day: `sheetSlice.clearSheet`
 * did `set(getDefaultState())` and destroyed `savedSheetTemplates`;
 * `drawing2DSlice.clearDrawing2D` destroyed custom override rules,
 * `overridesEnabled`, text annotations and DXF underlays.
 *
 * So: `owns` is a hand-written list, and the returned object names its fields
 * one by one. `...initialState` and `...getDefaultState()` are forbidden as
 * the body of a teardown. Fields that legitimately outlive a session reset —
 * `savedSheetTemplates`, `graphicOverridePresets`, `dxfUnderlays`, `bcfProject`,
 * `bcfAuthor`, `idsDocument`, `savedLenses`, clash presets, zone SETS,
 * `playbackSpeed` / `playbackLoop` / `ganttTimeScale` — are simply absent from
 * both `owns` and the body. `owns` is the reviewable artefact: it is the list
 * of everything this slice is willing to destroy.
 *
 * ## Trap B: persisted fields survive their session-scoped neighbours
 *
 * `sectionPlane` is one value holding both kinds. `axis` / `position` /
 * `enabled` / `flipped` are model-relative and meaningless after a file swap;
 * `showCap` / `showOutlines` / `capStyle` round-trip to localStorage and are
 * the user's cut-surface appearance. `store/index.ts` therefore SPREADS the
 * live plane and overwrites only the first four (`sectionSlice.ts` documents
 * why). `typeVisibility` / `typeViewMode` are the mirror image: re-READ from
 * localStorage on every reset so a new model never reverts the user's choices.
 *
 * A blanket per-slice reset destroys both. The scope parameter is what encodes
 * the distinction, and every such case must be carried over verbatim, comment
 * included.
 *
 * ## The visibility-ownership middleware
 *
 * `store/index.ts` wraps the store in `withVisibilityOwnershipInvalidation`
 * (`store/visibility-invalidation.ts`), which is the one place
 * `isolatedEntities` / `ghostExceptEntities` can be written. Its own doc makes
 * the same argument this module does — a middleware "rather than a helper each
 * writing action remembers to call" — and it is already accepted here.
 *
 * Nothing below fights it: teardown produces a patch, and the ENTRY POINT
 * applies that patch through the wrapped `set` / `setState`, so the
 * invalidation fires for teardown writes exactly as it does for every other
 * write. Never apply a composed patch through an unwrapped setter.
 */

import type { ViewerState } from './index.js';

/**
 * Which teardown is running.
 *
 * `model-removed` covers BOTH the federation removal (`modelSlice.removeModel`)
 * and the source resync purge in `syncSourceModel`. That
 * is the point of `isStale`: the two paths differed only in how they computed
 * the survivor set, and passing the predicate in is what collapses two
 * implementations into one.
 */
export type TeardownScope =
  | { kind: 'session-reset' }
  | {
      kind: 'model-removed';
      modelId: string;
      isStale: (id: number) => boolean;
      /**
       * Which model holds `activeModelId` once this one is gone, resolved ONCE
       * by the entry point. Federation knowledge, so it belongs to whoever
       * builds the scope rather than to each slice that has to follow it.
       *
       * Two slices need it and they own different keys, so the disjointness
       * proof cannot see them: `modelSlice` writes `activeModelId`, `dataSlice`
       * writes the `ifcDataStore` / `geometryResult` that must follow it. When
       * each derived the successor for itself, changing the rule in one file
       * left the data pointing at a model the active id did not name — a blank
       * properties panel over a live model list, and no gate would catch it.
       */
      nextActiveModelId: string | null;
    }
  | { kind: 'all-models-cleared' };

/**
 * The state a teardown reads.
 *
 * `Partial` is deliberate and is a compile-time gate, not pessimism:
 * `slices/modelSlice.test.ts` drives `removeModel` through a harness that
 * stubs `get()` with the model slice ALONE, so every other slice's fields are
 * genuinely absent on a path that reaches this composition. Today's code
 * handles that by hand (`sel.selectedEntities ?? []`, every field of the local
 * cast optional); making it part of the type means a teardown cannot forget.
 *
 * Fall back to the slice's OWN initial value — by definition the correct
 * answer, and the value is already in the file.
 *
 * `Readonly` because a teardown must not mutate what it was handed: `set` has
 * not run yet and the object is the live state.
 */
export type TeardownState = Readonly<Partial<ViewerState>>;

/**
 * The patch a slice owning keys `K` is allowed to return.
 *
 * The second half is not decoration. `Partial<Pick<…>>` alone does NOT reject
 * a foreign key here: excess-property checking does not reach a fresh object
 * literal returned from a callback whose contextual type comes from an
 * inference site, so a body returning a key outside `owns` compiled clean
 * (measured, before this was added). Typing every OTHER key as `never` is what
 * actually makes "return only the keys you own" a compiler error rather than a
 * comment — which is the whole point of declaring `owns` separately.
 */
export type TeardownContribution<K extends keyof ViewerState> =
  Partial<Pick<ViewerState, K>> & { [P in Exclude<keyof ViewerState, K>]?: never };

/**
 * One slice's answer to "what do I clear under this scope".
 *
 * `owns` is DECLARED, not inferred from the body, which is what makes
 * ownership checkable: {@link createTeardownRegistry} proves the declarations
 * are disjoint at module init, and `Pick<ViewerState, K>` makes the compiler
 * reject a body that returns a key outside them.
 */
export interface SliceTeardown<K extends keyof ViewerState = keyof ViewerState> {
  /** Source file basename, e.g. `'uiSlice'`. Used in conflict messages. */
  readonly slice: string;
  /** Every key this slice is willing to destroy. Reviewable on its own. */
  readonly owns: readonly K[];
  /**
   * @returns the fields to assign, or `{}` for "this scope does not touch me".
   *
   * Return a key ONLY when its value actually changes. Today's `removeModel`
   * spreads its groups conditionally (`...(selectionTouchedRemoved ? {…} : {})`)
   * precisely so an untouched group is not rewritten; keeping that habit is
   * what makes `model-removed` idempotent, which in turn is what lets
   * `syncSourceModel` runs the SAME composition after `removeModel`
   * without undoing or re-allocating anything.
   *
   * {@link composeTeardown} drops `Object.is`-unchanged entries as a backstop,
   * but a contribution that rebuilds an equal-but-new `Map` defeats it.
   */
  readonly teardown: (scope: TeardownScope, state: TeardownState) => TeardownContribution<K>;
}

/** A teardown in a heterogeneous registry, where `K` is no longer known. */
export type AnySliceTeardown = SliceTeardown<keyof ViewerState>;

/**
 * Declare a slice's teardown.
 *
 * The `const` type parameter infers `K` as the literal union of `owns`, so the
 * body is checked against exactly those keys — no `as const` needed at the
 * call site, and no way to widen `K` by accident.
 *
 * @example
 * export const uiTeardown = defineSliceTeardown(
 *   'uiSlice',
 *   ['activeTool', 'editEnabled', 'pendingPropertyFocus'],
 *   (scope) => scope.kind !== 'session-reset' ? {} : {
 *     activeTool: UI_DEFAULTS.ACTIVE_TOOL,
 *     editEnabled: false,
 *     // Drop any one-shot bSDD "jump to property" focus armed before the
 *     // load — a new file reuses ids, so a stale focus could match an
 *     // unrelated entity (issue #1107).
 *     pendingPropertyFocus: null,
 *   },
 * );
 */
export function defineSliceTeardown<const K extends keyof ViewerState>(
  slice: string,
  owns: readonly K[],
  teardown: (scope: TeardownScope, state: TeardownState) => TeardownContribution<NoInfer<K>>,
): SliceTeardown<K> {
  return { slice, owns, teardown };
}

/**
 * Freeze a set of slice teardowns into the store's registry, proving on the
 * way that no two slices claim the same key.
 *
 * Thrown at MODULE INIT, not at teardown time. That matters: a contribution is
 * conditional, so a runtime overlap check would fire only for particular data,
 * in production, in the middle of removing a model. A declaration overlap is
 * data-independent, so checking the DECLARATIONS turns "two owners for one
 * key" — the exact defect this refactor exists to remove — into a failure
 * every single test sees on import.
 *
 * @throws if any key appears in more than one slice's `owns`.
 */
export function createTeardownRegistry(
  entries: readonly AnySliceTeardown[],
): readonly AnySliceTeardown[] {
  const owner = new Map<keyof ViewerState, string>();
  const conflicts: string[] = [];
  const duplicated: string[] = [];

  for (const entry of entries) {
    const seen = new Set<keyof ViewerState>();
    for (const key of entry.owns) {
      if (seen.has(key)) {
        duplicated.push(`${entry.slice} lists '${String(key)}' twice`);
        continue;
      }
      seen.add(key);
      const previous = owner.get(key);
      if (previous !== undefined) {
        conflicts.push(`'${String(key)}' is claimed by both ${previous} and ${entry.slice}`);
      } else {
        owner.set(key, entry.slice);
      }
    }
  }

  const problems = [...conflicts, ...duplicated];
  if (problems.length > 0) {
    throw new Error(
      `Teardown ownership is not disjoint — a key must have exactly one owning slice:\n  ${problems.join('\n  ')}`,
    );
  }

  return entries;
}

/**
 * Every key the registry is willing to destroy, and who destroys it.
 *
 * Exported so a test can pin the set: a migrator quietly dropping a key from
 * `owns` is otherwise invisible — the key simply stops being cleared, and
 * "state that was not cleared" is the failure mode with no smell.
 */
export function teardownOwnedKeys(
  registry: readonly AnySliceTeardown[],
): ReadonlyMap<keyof ViewerState, string> {
  const owner = new Map<keyof ViewerState, string>();
  for (const entry of registry) {
    for (const key of entry.owns) owner.set(key, entry.slice);
  }
  return owner;
}

/**
 * Build the one patch an entry point hands to `set`.
 *
 * Contributions are merged in registry order. Ownership is disjoint (proved by
 * {@link createTeardownRegistry}), so the order cannot decide a value — it only
 * decides key insertion order, which nothing observes.
 *
 * An entry whose value is already `Object.is`-identical to the live state is
 * DROPPED. That keeps a composed patch as close as possible to today's
 * conditional spreads: a key that is not in the patch is not written, so no
 * subscriber is notified for a non-change, and the visibility-ownership
 * middleware does not run its invalidation for a channel nobody actually
 * moved. It also makes a `model-removed` teardown safe to run twice, which
 * `syncSourceModel` does immediately after `removeModel`.
 *
 * A key absent from `state` (the partial-store test harness) is never
 * "unchanged" — `Object.is(undefined, value)` is false unless the teardown also
 * returns `undefined`.
 *
 * About a dozen contributions DO return `undefined` - most of `visibilitySlice`
 * and `selectionSlice`'s model-removed arms, plus `dataSlice`'s
 * `purgeRemovedModelsBackup`. Do not audit that as a list; audit the RULE, which
 * is narrower than "never return it": every one of them passes THROUGH a value
 * read from `state`, so `undefined` appears only where the live value is
 * `undefined` too and the entry is dropped. Returning a SYNTHESIZED `undefined` would survive the
 * filter, and `writeKey` would set it, and zustand's shallow merge would blank
 * the field.
 */
export function composeTeardown(
  registry: readonly AnySliceTeardown[],
): (scope: TeardownScope, state: TeardownState) => Partial<ViewerState> {
  return (scope, state) => {
    const patch: Partial<ViewerState> = {};
    for (const entry of registry) {
      const contribution = entry.teardown(scope, state);
      for (const key of Object.keys(contribution) as (keyof ViewerState)[]) {
        const next = contribution[key];
        if (Object.is(state[key], next)) continue;
        writeKey(patch, key, next);
      }
    }
    return patch;
  };
}

/**
 * One indexed write, with the key held as a type PARAMETER.
 *
 * `patch[key] = value` inline does not type-check when `key` is the full
 * `keyof ViewerState` union: TS distributes the target over ~1000 members and
 * narrows the assignable type to their intersection (`undefined`). Binding the
 * key to `K` keeps target and value on the same member, which is the honest
 * fix — the alternative here is an `as any`, which this repo does not allow.
 */
function writeKey<K extends keyof ViewerState>(
  patch: Partial<ViewerState>,
  key: K,
  value: ViewerState[K] | undefined,
): void {
  patch[key] = value;
}
