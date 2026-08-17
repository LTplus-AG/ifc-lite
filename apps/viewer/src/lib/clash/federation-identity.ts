/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The identity of the federation a clash run EXAMINED, so a run that lands
 * after that federation is gone can be discarded instead of repopulating the
 * result list with rows that resolve to nothing.
 *
 * ## The defect
 *
 * `useClash.run()` gathers elements from the live federation and then awaits
 * the engine for as long as the geometry takes. Both of its publish sites wrote
 * unconditionally:
 *
 * ```ts
 * state.setClashResult(res);
 * state.bumpClashRunSeq();
 * ```
 *
 * `clashRunSeq` is a COMPLETION signal, not a cancellation guard (see its field
 * doc in `clashSlice`) — it is bumped after a successful write and never reset,
 * so it cannot say anything about whether the write should happen at all. Start
 * a run on a large federation, then "Open file" or "Clear all": the teardown
 * runs `clearClash()`, and seconds later the finishing run puts the pairs back.
 * Every row then does nothing — `focusClash` bails at `refs.length === 0` — and
 * nothing on screen explains why.
 *
 * ## Why an identity and not a bumped counter
 *
 * The obvious fix is a generation counter bumped by every teardown. That is the
 * shape this repo keeps getting burned by: correctness then depends on an
 * ENUMERATION of call sites, and the enumeration is only as good as whoever
 * adds the next teardown remembers. `clashSolidRequestSeq` gets away with it
 * only because every bump site routes through one constant
 * (`CLASH_FOCUS_RESET`); there is no equivalent choke point for "the models
 * changed" — `removeModel`, `clearAllModels` and `resetViewerState` share
 * `endClashScenePresentation`, but `dataSlice.setIfcDataStore` (which
 * `collabSlice` calls on every peer edit, replacing the active model's store in
 * place) does not, and that path invalidates a run for exactly the reason the
 * others do: express ids get reassigned under the refs the run computed.
 *
 * So the token is not published by the teardowns at all — it is READ OFF the
 * federation, at the one place the run actually reads it (`gatherElements`),
 * and re-read at the publish site. Nothing has to be bumped, so a fifth
 * teardown path added tomorrow is covered by construction rather than by
 * remembering this file exists.
 *
 * ## What makes up the identity
 *
 * For every model the run actually took elements from: its id, mapped to that
 * model's ENTITY TABLE (`ifcDataStore.entities`), not to the `ifcDataStore`
 * wrapper. What the refs in a `ClashResult` depend on is the express id space —
 * `elementsFromStep` derives every `ref` from an express id via
 * `toGlobalId(modelId, expressId)` — and the entity table is that id space,
 * while the wrapper is merely the object holding it. `identityToken` carries
 * the full argument for why the table is the load-bearing grain; the short
 * version is that the wrapper is replaced by writes that move no id (the
 * background spatial-index publish clones it on every load), so keying on it
 * discarded runs that were perfectly correct.
 *
 * Deliberately NOT part of the identity:
 *
 *  - models the run SKIPPED (no store, no meshes, or no elements built). They
 *    contributed no elements, so no row can refer to them and their removal
 *    invalidates nothing.
 *  - models ADDED during the run. Every row still names a model that exists and
 *    still focuses, so the published result stays usable and a second file
 *    finishing its load mid-run must not silently throw the run away. Note this
 *    is weaker than "merely incomplete": if the added file is GEOREFERENCED,
 *    `realignFederationModels` (`hooks/ingest/federationRealign.ts`) re-bakes
 *    every non-anchor model by mutating `geometryResult` in place and publishes
 *    through `updateModel(modelId, { preAlignment, federationAlignmentStatus })`,
 *    leaving `ifcDataStore` untouched — so the models MOVE and the run's clash
 *    points, AABBs and pair set describe the pre-realign frame. Those rows are
 *    mis-placed, not inert; re-running is the remedy. Discarding a whole run
 *    because another file happened to land is the worse trade, and no identity
 *    keyed on the id space can see a pure geometry re-bake anyway.
 *  - `geometryResult`. A re-mesh replaces meshes but keeps express ids, so the
 *    published rows still resolve and still focus. Including it would discard
 *    live runs on benign geometry churn.
 */

/** The per-model fields the identity is read from. Structural, not the store's
 *  `FederatedModel`, so this module stays testable without the viewer store. */
export interface FederationModelIdentity {
  ifcDataStore?: { entities?: unknown } | null;
}

/**
 * Model id → the entity table the run read its express ids from.
 * Compared by REFERENCE — see {@link identityToken} for why that is exactly
 * "the ids this run computed still mean what it thought".
 */
export type ClashFederationIdentity = ReadonlyMap<string, unknown>;

/**
 * The one definition of the token, used by BOTH the capture and the check so
 * they cannot drift apart.
 *
 * `store.entities` — the columnar entity table (`IfcDataStore.entities`) — and
 * NOT the `ifcDataStore` wrapper around it. The wrapper is the wrong grain: it
 * is replaced by writes that move no express id at all, and the background
 * spatial-index build does exactly that on every load
 * (`utils/loadingUtils.ts` `buildSpatialIndexGuarded` publishes
 * `setIfcDataStore({ ...capturedStore })`, a shallow clone that shares this
 * very table). Keyed on the wrapper, a run that lands during that window — a
 * window every loader opens AFTER the model reports `loadState: 'complete'`,
 * so the user can and does hit Run inside it — is thrown away though every one
 * of its rows still resolves.
 *
 * The table is the right grain in both directions:
 *
 *  - it is never assigned or mutated in place on a live store. No `store.entities =`
 *    exists outside a store's own construction, and nothing appends to the
 *    table after `EntityTableBuilder.build()`. So a token that holds means the
 *    express ids genuinely have not moved.
 *  - every path that DOES move express ids builds a whole new store, and with
 *    it a new table: a re-parse (`IfcParser.parseColumnar`), a worker handoff
 *    (`fromTransport` rebuilds the columns), and the collab peer edit — which
 *    re-derives the model from the CRDT through `parseIfcxViewerModel` before
 *    calling `setIfcDataStore` (`collabSlice`). So a token that breaks really
 *    is a run whose refs no longer hold.
 *
 * A store without an entity table falls back to the store object itself, so
 * such a model is compared exactly as it was before — never silently equal.
 */
function identityToken(model: FederationModelIdentity): unknown {
  return model.ifcDataStore?.entities ?? model.ifcDataStore;
}

/**
 * Record the identity of one model the run took elements from. Called from
 * inside `gatherElements`' own loop, against the same state snapshot it
 * iterates, so the identity cannot describe a federation different from the one
 * the elements came from.
 */
export function recordGatheredModel(
  into: Map<string, unknown>,
  modelId: string,
  model: FederationModelIdentity,
): void {
  into.set(modelId, identityToken(model));
}

/**
 * Is every model this run examined still loaded, with the same entity table?
 *
 * `false` means the run described a world that no longer exists and its result
 * must be dropped: `clearAllModels` / `resetViewerState` empty the map,
 * `removeModel` drops one key, and a collab peer edit
 * (`setIfcDataStore` with a re-derived store) swaps one value.
 *
 * An EMPTY captured identity returns `true` — vacuously current. It cannot
 * arise from a real run (`run()` and `runDuplicates()` both bail with "No model
 * geometry is loaded" before publishing when no elements were gathered), and
 * answering `false` would make a would-be publish look like a teardown.
 */
export function clashFederationIsCurrent(
  captured: ClashFederationIdentity,
  models: ReadonlyMap<string, FederationModelIdentity>,
): boolean {
  for (const [modelId, token] of captured) {
    const current = models.get(modelId);
    if (!current || identityToken(current) !== token) return false;
  }
  return true;
}
