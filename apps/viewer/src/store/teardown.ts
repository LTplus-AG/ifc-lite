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
 *   - `slices/modelSlice.ts` `removeModel`        23 keys
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
 * contributions carry `?? new Set()` fallbacks — giving that harness a real
 * store would delete the list and the fallbacks together.
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
 * plus its contribution would cross ~400 lines, inline otherwise. `addElementSlice`
 * and `annotationsSlice` split despite fitting (341, 365 combined) for group
 * uniformity; folding them back inline would make the rule exceptionless.
 *
 * ## Trap A: a teardown returns an EXPLICIT field list, never a whole state
 *
 * `scripts/check-whole-state-reset.mjs` (proposal, issue #2802) documents
 * three bugs of this class in one day: `sheetSlice.clearSheet` did
 * `set(getDefaultState())` and destroyed `savedSheetTemplates`;
 * `drawing2DSlice.clearDrawing2D` destroyed custom override rules,
 * `overridesEnabled`, text annotations and DXF underlays.
 *
 * So: `owns` is a hand-written list, and the returned object names its fields
 * one by one. `...initialState` / `...getDefaultState()` are forbidden as a
 * teardown body. Fields that legitimately outlive a session reset —
 * `savedSheetTemplates`, `graphicOverridePresets`, `dxfUnderlays`, `bcfProject`,
 * clash presets, zone SETS, `playbackSpeed`/`playbackLoop`/`ganttTimeScale` —
 * are simply absent from both `owns` and the body, which is the reviewable
 * artefact: the list of everything this slice is willing to destroy.
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
 * (`store/visibility-invalidation.ts`), the one place `isolatedEntities` /
 * `ghostExceptEntities` can be written. Nothing below fights it: teardown
 * produces a patch, and the ENTRY POINT applies it through the wrapped `set` /
 * `setState`, so the invalidation fires for teardown writes exactly as it does
 * for every other write. Never apply a composed patch through an unwrapped setter.
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
       * by the entry point — federation knowledge, so it belongs to whoever
       * builds the scope. Two slices need it and own different keys, so the
       * disjointness proof cannot see them: `modelSlice` writes `activeModelId`,
       * `dataSlice` writes the `ifcDataStore` / `geometryResult` that must follow
       * it. Deriving the successor twice once left the data pointing at a model
       * the active id did not name — a blank properties panel over a live model
       * list, no gate would catch it.
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
 * answer, and the value is already in the file. `Readonly` because a teardown
 * must not mutate what it was handed: `set` has not run yet and the object is
 * the live state.
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
 * makes "return only the keys you own" a compiler error, not just a comment.
 */
export type TeardownContribution<K extends keyof ViewerState> =
  Partial<Pick<ViewerState, K>> & { [P in Exclude<keyof ViewerState, K>]?: never };

export type TeardownScopeKind = TeardownScope['kind'];
type ScopeOfKind<Kind extends TeardownScopeKind> = Extract<TeardownScope, { kind: Kind }>;
// WITHOUT TeardownContribution's excess-property trick (TS2590 across the
// registry, measured): composeTeardown enforces the foreign-key guarantee at runtime instead.
type ArmContribution<K extends keyof ViewerState> = Partial<Pick<ViewerState, K>>;
type Arm<Kind extends TeardownScopeKind, K extends keyof ViewerState> = (scope: ScopeOfKind<Kind>, state: TeardownState) => ArmContribution<K>;

// ONE ARM PER SCOPE KIND (#3345): a plain function let 22 of 28 open with
// `if (scope.kind !== 'session-reset') return {};`, a silent no-op for a
// fourth kind. Mapped over TeardownScopeKind — not a record naming the three
// kinds by hand — so a fourth TeardownScope kind is a compile error in every
// arms object that omits it, not just a runtime no-op.
export type SliceTeardownArms<K extends keyof ViewerState> = {
  readonly [Kind in TeardownScopeKind]: Arm<Kind, K>;
};

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
   * `syncSourceModel` run the SAME composition after `removeModel` without
   * undoing or re-allocating anything.
   *
   * {@link composeTeardown} drops unchanged entries as a backstop, including a
   * `Set` / `Map` / array / typed array / plain object rebuilt equal-but-new — a
   * should, not a must: {@link isUnchanged}'s structural check runs only after `Object.is` fails.
   */
  readonly teardown: (scope: TeardownScope, state: TeardownState) => TeardownContribution<K>;
}

/** A teardown in a heterogeneous registry, where `K` is no longer known. */
export type AnySliceTeardown = SliceTeardown<keyof ViewerState>;

/** "This scope does not touch me." */
export function notApplicable(): TeardownContribution<never> { return {}; }

// The cast below bridges ArmContribution to TeardownContribution once per slice.
export function defineSliceTeardown<const K extends keyof ViewerState>(
  slice: string,
  owns: readonly K[],
  arms: SliceTeardownArms<NoInfer<K>>,
): SliceTeardown<K> {
  // Indexed lookup, not a switch naming the three kinds by hand — the sync
  // hazard `SliceTeardownArms` closes at the type level, a forgotten switch
  // case would fall through to `default: throw`. `undefined` check keeps that
  // thrown message for a stale/untyped caller; `teardown-scope-completeness.test.ts` pins it.
  const teardown = (scope: TeardownScope, state: TeardownState): ArmContribution<K> => {
    const arm = (arms as Record<TeardownScopeKind, Arm<TeardownScopeKind, K>>)[scope.kind];
    if (arm === undefined) throw new Error(`no teardown arm for scope kind '${(scope as { kind: string }).kind}'`);
    return arm(scope, state);
  };
  return { slice, owns, teardown: teardown as (scope: TeardownScope, state: TeardownState) => TeardownContribution<K> };
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
 * Keys the equality filter below must never drop, on the two scopes whose
 * hand-written predecessor always carried both — `withVisibilityOwnershipInvalidation`
 * keys on PRESENCE in the patch, not value (`applyOwnershipInvalidation` tests
 * `'isolatedEntities' in patch`), so it must keep running even when both are
 * already `null`. `model-removed` is excluded: its `visibilitySlice.teardown.ts`
 * arm already gates presence on its own `touched` check, and forcing it here
 * would reproduce #3346 (a channel unwritten by anything of its own, forced
 * through because a SIBLING field's `touched` gate rebuilt it equal-but-new).
 */
const FORCED_PRESENCE_SCOPES: ReadonlySet<TeardownScope['kind']> = new Set([
  'session-reset',
  'all-models-cleared',
]);
const NEVER_DROPPED: ReadonlySet<keyof ViewerState> = new Set(['isolatedEntities', 'ghostExceptEntities']);

const MAX_ISUNCHANGED_DEPTH = 64; // no slice value nests this deep; past it a cyclic Map/array/object reports "changed"

/**
 * Whether `a`/`b` are equal, seeing through `Set`/`Map`/array/typed array/
 * plain object rebuilt equal-but-new (#3346), `depth`-bounded per {@link
 * MAX_ISUNCHANGED_DEPTH}. `Set` of objects NOT covered: reference-based `has`.
 */
function isUnchanged(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth >= MAX_ISUNCHANGED_DEPTH) return false;
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every((value) => b.has(value));
  }
  if (a instanceof Map && b instanceof Map) {
    return a.size === b.size && [...a].every(([k, v]) => b.has(k) && isUnchanged(v, b.get(k), depth + 1));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => isUnchanged(value, b[index], depth + 1));
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && 'length' in a && 'length' in b) {
    const ta = a as unknown as ArrayLike<number>, tb = b as unknown as ArrayLike<number>;
    return a.constructor === b.constructor && ta.length === tb.length
      && Array.prototype.every.call(ta, (v, i) => Object.is(v, tb[i])); // `Object.is`, matching the top-level fast path: two same-position NaNs ARE equal, so reporting "unchanged" loses nothing, while `-0` vs `0` is a real difference that `===` would report "unchanged" and silently drop.
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Reflect.ownKeys(a).filter((k) => Object.prototype.propertyIsEnumerable.call(a, k)); // string AND symbol keys, `Object.hasOwn`'s own-property-only semantics kept: `Object.keys` alone missed an own enumerable SYMBOL key whose value differs while every string key matches
    return keys.length === Reflect.ownKeys(b).filter((k) => Object.prototype.propertyIsEnumerable.call(b, k)).length && keys.every((k) => Object.hasOwn(b, k) && isUnchanged(a[k], b[k], depth + 1));
  }
  return false;
}

/** `{}` / null-prototype only — excludes class instances and built-ins. */
function isPlainObject(v: unknown): v is Record<PropertyKey, unknown> {
  return typeof v === 'object' && v !== null
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/**
 * Build the one patch an entry point hands to `set`.
 *
 * Contributions are merged in registry order. Ownership is disjoint (proved by
 * {@link createTeardownRegistry}), so the order cannot decide a value — it only
 * decides key insertion order, which nothing observes.
 *
 * An entry whose value {@link isUnchanged} from the live state is DROPPED
 * (structurally, not by `Object.is` alone — see {@link isUnchanged}, #3346),
 * so a key not in the patch is not written and no subscriber is notified for
 * a non-change. That also makes `model-removed` safe to run twice, which
 * `syncSourceModel` does right after `removeModel`. {@link NEVER_DROPPED} is
 * the scope-dependent exception; see its own doc.
 *
 * A key absent from `state` (the partial-store test harness) is never
 * "unchanged" — `isUnchanged(undefined, value)` is false unless the teardown
 * also returns `undefined`. About a dozen contributions DO, passing THROUGH a
 * value read from `state` (most of `visibilitySlice` / `selectionSlice`'s
 * model-removed arms, `dataSlice.purgeRemovedModelsBackup`), so `undefined`
 * appears only where the live value already is — a SYNTHESIZED `undefined`
 * would survive the filter and `writeKey` would blank the field.
 */
export function composeTeardown(
  registry: readonly AnySliceTeardown[],
): (scope: TeardownScope, state: TeardownState) => Partial<ViewerState> {
  // Runtime half of the foreign-key guard ArmContribution gave up at compile
  // time: a contribution naming a key it does not own is caught here.
  const owner = teardownOwnedKeys(registry);
  return (scope, state) => {
    const forcePresence = FORCED_PRESENCE_SCOPES.has(scope.kind);
    const patch: Partial<ViewerState> = {};
    for (const entry of registry) {
      const contribution = entry.teardown(scope, state);
      for (const key of Object.keys(contribution) as (keyof ViewerState)[]) {
        if (owner.get(key) !== entry.slice) throw new Error(`${entry.slice} returned unowned key '${String(key)}'`);
        const next = contribution[key];
        if (!(forcePresence && NEVER_DROPPED.has(key)) && isUnchanged(state[key], next)) continue;
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
