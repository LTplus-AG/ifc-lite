/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The identity of the federation an analysis run READ, captured when the run
 * starts and re-checked before it publishes, so a run that lands after its
 * model set changed is discarded instead of naming models that are gone.
 *
 * Moved out of `lib/clash/federation-identity.ts`, where it was first written
 * for clash (that file keeps the defect story and the clash-only parts: the
 * per-result identity and per-ref checks). IDS and rule-set validation use
 * the same token through `hooks/validation/validationRunGuard.ts` (A1,
 * implicit-state audit) — one definition, so the three cannot drift.
 *
 * What the token is (the entity table, not the store wrapper) and what it
 * deliberately ignores (models added mid-run, models with no store, geometry
 * re-meshes) is argued below and in the clash module's header.
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
export type FederationIdentity = ReadonlyMap<string, unknown>;

/**
 * The one definition of the token, used by BOTH the capture and the check so
 * they cannot drift apart.
 *
 * `store.entities` — the columnar entity table (`IfcDataStore.entities`) — and
 * NOT the `ifcDataStore` wrapper around it. The wrapper is the wrong grain: it
 * is replaced by writes that move no express id at all: callers can publish
 * a shallow clone through `setIfcDataStore`, preserving this very table.
 * Keyed on the wrapper, an in-flight run would be discarded though every
 * one of its rows still resolves.
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
export function identityToken(model: FederationModelIdentity): unknown {
  return model.ifcDataStore?.entities ?? model.ifcDataStore;
}

/**
 * Record the identity of one model the run took elements from. Clash calls it
 * from inside `gatherElements`' own loop, against the same state snapshot it
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
 * must be dropped: `clearAllModels` empties the map, `removeModel` drops one
 * key, and a collab peer edit (`setIfcDataStore` with a re-derived store)
 * swaps one value. `resetViewerState` (session reset) does NOT empty it — it
 * keeps `models` and only nulls the top-level `ifcDataStore` — so a caller
 * that must also end on a session reset needs a second signal (validation
 * uses `validationRunGeneration`, `hooks/validation/validationRunGuard.ts`).
 *
 * An EMPTY captured identity returns `true` — vacuously current. It cannot
 * arise from a real clash run (`run()` and `runDuplicates()` both bail with "No
 * model geometry is loaded" before publishing when no elements were gathered),
 * and answering `false` would make a would-be publish look like a teardown.
 */
export function federationIsCurrent(
  captured: FederationIdentity,
  models: ReadonlyMap<string, FederationModelIdentity>,
): boolean {
  for (const [modelId, token] of captured) {
    const current = models.get(modelId);
    if (!current || identityToken(current) !== token) return false;
  }
  return true;
}

/**
 * Capture the identity of every model in `models` that has a data store —
 * the models a whole-federation run (IDS report scope, rule-set evaluation)
 * reads. A model without a store contributes nothing, so like clash's skipped
 * models it is not part of the identity.
 */
export function captureFederationIdentity(
  models: ReadonlyMap<string, FederationModelIdentity>,
): FederationIdentity {
  const identity = new Map<string, unknown>();
  for (const [modelId, model] of models) {
    if (model.ifcDataStore) recordGatheredModel(identity, modelId, model);
  }
  return identity;
}
