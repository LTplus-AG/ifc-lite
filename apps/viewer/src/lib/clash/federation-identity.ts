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
 * while the wrapper is merely the object holding it. `identityToken`
 * (`lib/federation/federation-identity.ts`) carries
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

import {
  identityToken,
  type FederationIdentity,
  type FederationModelIdentity,
} from '@/lib/federation/federation-identity';

/**
 * The generic half of this module — the token, its capture and the
 * whole-federation `federationIsCurrent` check — lives in
 * `lib/federation/federation-identity.ts`, shared with IDS and rule-set
 * validation. What stays here is clash-only: the identity bound to a
 * published result and the per-ref check.
 */
export type ClashFederationIdentity = FederationIdentity;

/**
 * The identity a published result was computed on, bound to the RESULT OBJECT.
 *
 * Publish-time currency (above) only stops a run from landing after its
 * federation is gone. It says nothing about a result already on screen, and
 * that result can be superseded in place: a collab peer edit re-derives the
 * model from the CRDT and calls `setIfcDataStore`, swapping the entity table
 * under the same model id while `idOffset` and `maxExpressId` stay put. Every
 * ref then still looks resolvable and resolves to the WRONG element — a row
 * reading "Wall A vs Wall B" isolating and colouring two other walls (#2697).
 * So the identity has to outlive the publish, and something has to be able to
 * ask a result "do your refs still mean what you meant?".
 *
 * A WeakMap keyed on the result, rather than a field beside it in the store,
 * because the two must not be able to disagree. A sibling field is written by
 * one setter and read by another, and anything that puts a result into the
 * store by a different route (a direct `setState`, a fixture) leaves the field
 * describing a result that is no longer there — a stale identity refusing a
 * perfectly good result. Bound to the object, an identity cannot be observed
 * with anything but the result it was captured for, a result that never had one
 * simply has none (read as "unknown", never refused), and nothing has to be
 * cleared on teardown: the entry dies with the result.
 */
const identities = new WeakMap<object, ClashFederationIdentity>();

/** Bind `identity` to the result it was computed on. Call at the publish site. */
export function rememberFederationIdentity(
  result: object,
  identity: ClashFederationIdentity,
): void {
  identities.set(result, identity);
}

/**
 * Does ONE model still hold the id space this result's refs into it were
 * computed against?
 *
 * Deliberately per-model rather than the whole-federation
 * `federationIsCurrent` (`lib/federation/federation-identity.ts`). The two answer different questions.
 * Whole-federation is the right question at PUBLISH time — a result is written
 * once, as a unit, and one missing model makes the write as a whole wrong. Per
 * REF, the question is only ever "does this one number still mean what it meant
 * in this one model", and answering it with the federation-wide verdict would
 * disable rows that are perfectly sound: unload the second of two files and
 * every row wholly inside the first would stop working, though nothing about
 * its ids moved.
 *
 * `true` whenever the answer is not known to be `false`: a result with no
 * recorded identity (hand-built fixture, or published before this existed), and
 * a model the identity has no entry for (the run took no elements from it, so
 * it holds no ref). Unknown must never refuse — a false refusal is the inert
 * panel this whole PR exists to fix.
 *
 * A model that has LEFT `models` IS refused, and that is the one asymmetry
 * with the paragraph above: absence is not the same kind of ignorance. A model
 * the identity has no entry for is genuinely unknown to this result — the run
 * took nothing from it, so no ref points into it and its state cannot make any
 * number wrong. A model the identity NAMES and that is gone is known-gone: the
 * result holds refs into an id space that is no longer loaded, and there is no
 * honest answer for them.
 *
 * It used to return `true` here, on the reasoning that the two paths which drop
 * a model unregister it from the federation registry in the same breath
 * (`removeModel` → `unregisterModel`, `clearAllModels` → `clear()`), so the
 * caller's fallback range search would simply find nothing. That holds only for
 * a model the registry ever HELD. The collab room model used to be put into
 * `models` by `collabSlice`'s `upsertModel({ id: 'room:<id>', idOffset: 0 })`
 * without `registerModelOffset` (room models register like any added file
 * since #4444), so `unregisterModel` was a no-op on it and there was nothing
 * to forget — while a normally loaded file's registered range still covered
 * the same low numbers. Leaving a room keeps the published result
 * (`removeModel` ends the clash PRESENTATION, it does not clear the result), so
 * the rows stayed clickable and range-searched into a different file, isolating
 * and colouring two of ITS elements with no error at all (measured in review).
 *
 * So this catches two shapes, not one: the model still there under the same id
 * holding a DIFFERENT id space, and the model that is no longer there at all.
 */
export function clashRefModelIsCurrent(
  result: object | null | undefined,
  modelId: string,
  models: ReadonlyMap<string, FederationModelIdentity>,
): boolean {
  if (!result) return true;
  const identity = identities.get(result);
  if (!identity || !identity.has(modelId)) return true;
  const current = models.get(modelId);
  // Named by the identity and no longer loaded: known-gone, not unknown.
  if (!current) return false;
  return identityToken(current) === identity.get(modelId);
}

/** The models a published result took elements from, or null when no identity
 *  was recorded (a fixture, or a result published before identities existed). */
export function gatheredModelIds(result: object | null | undefined): string[] | null {
  const identity = result ? identities.get(result) : undefined;
  return identity ? [...identity.keys()].sort() : null;
}
