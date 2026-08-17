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
 * For every model the run actually took elements from: its id, mapped to its
 * `ifcDataStore` REFERENCE. That is precisely what the refs in a `ClashResult`
 * depend on — `elementsFromStep` derives every `ref` from an express id in that
 * store, via `toGlobalId(modelId, expressId)`. A model whose store object is
 * still the same object still answers for those ids; anything else does not.
 *
 * Deliberately NOT part of the identity:
 *
 *  - models the run SKIPPED (no store, no meshes). They contributed no
 *    elements, so no row can refer to them and their removal invalidates
 *    nothing.
 *  - models ADDED during the run. The result is then merely incomplete, not
 *    wrong: every row still names a model that exists and still focuses. A
 *    second file finishing its load mid-run must not silently throw the run
 *    away.
 *  - `geometryResult`. A re-mesh replaces meshes but keeps express ids, so the
 *    published rows still resolve and still focus. Including it would discard
 *    live runs on benign geometry churn.
 */

/** The per-model fields the identity is read from. Structural, not the store's
 *  `FederatedModel`, so this module stays testable without the viewer store. */
export interface FederationModelIdentity {
  ifcDataStore?: unknown;
}

/**
 * Model id → the `ifcDataStore` object the run read its express ids from.
 * Compared by REFERENCE: a data store is replaced wholesale (`setIfcDataStore`
 * builds a new model record), never patched in place, so reference equality is
 * exactly "the ids this run computed still mean what it thought".
 */
export type ClashFederationIdentity = ReadonlyMap<string, unknown>;

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
  into.set(modelId, model.ifcDataStore);
}

/**
 * Is every model this run examined still loaded, with the same data store?
 *
 * `false` means the run described a world that no longer exists and its result
 * must be dropped: `clearAllModels` / `resetViewerState` empty the map,
 * `removeModel` drops one key, and a collab peer edit
 * (`setIfcDataStore`) swaps one value.
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
  for (const [modelId, store] of captured) {
    const current = models.get(modelId);
    if (!current || current.ifcDataStore !== store) return false;
  }
  return true;
}
