/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ends an in-flight analysis run (IDS, rule-set validation, clash, flow) when
 * the model set it read changes underneath it (A1/A2, implicit-state audit).
 *
 * Each engine's own epoch only moves on run, cancel and its own clear. The
 * teardowns that change the MODELS — `removeModel` / `clearAllModels`, the
 * session reset of "open a new file", a collab peer edit swapping a model's
 * store — reset flags at most. A run that only had its flags reset kept
 * computing, wrote its progress back under `*Running: false`, and (flow) kept
 * its execution lease while Run was offered again.
 *
 * Two signals, because neither covers the other:
 *  - the FEDERATION IDENTITY (`lib/federation/federation-identity.ts`): read
 *    off the models, so any path that removes a model the run read or replaces
 *    its entity table breaks it without having to remember this file;
 *  - `analysisRunGeneration` (`modelSlice.teardown.ts`): bumped by the session
 *    reset, which keeps `models` in place, and by `clearAllModels`, which a
 *    run that has not yet recorded an identity (clash before its gather, flow
 *    which records none) cannot see through the identity.
 *
 * The identity is captured from the models the run ACTUALLY read (passed in by
 * the caller, or recorded later through `track`), not from `getState()`: a
 * retained closure can resolve its target from a render-time `models` that
 * already lost a model, and capturing the live store would make that stale
 * run look current.
 *
 * The guard subscribes for the run's lifetime. The moment the run stops
 * holding, `isCurrent()` turns false — synchronously, inside the teardown's
 * own `set`, so a progress callback in the same tick is refused — and
 * `onInvalidated` (the engine's own cancel: epoch bump + abort) is called once,
 * deferred to a microtask so its store writes do not nest inside the
 * teardown's `set` (the pattern `lib/scan-to-bim/run-detection.ts` uses).
 */

import type { StoreApi } from 'zustand';
import {
  captureFederationIdentity,
  federationIsCurrent,
  type FederationIdentity,
  type FederationModelIdentity,
} from '@/lib/federation/federation-identity';

/** The id `resolveValidationTarget` gives a legacy single-model store. */
const LEGACY_MODEL_ID = '__legacy__';

/** The model set a run read: the federation plus the legacy single-model store. */
export interface AnalysisRunModels {
  models: ReadonlyMap<string, FederationModelIdentity>;
  ifcDataStore: FederationModelIdentity['ifcDataStore'];
}

export interface AnalysisRunGuardState extends AnalysisRunModels {
  analysisRunGeneration: number;
}

export interface AnalysisRunGuard {
  /** False once the model set or the run generation changed, or after `dispose`. */
  isCurrent: () => boolean;
  /** Narrow the identity to the models the run actually read (clash records
   *  it while gathering, after the guard was armed at run start). */
  track: (identity: FederationIdentity) => void;
  /** Stop watching. Call from the run's `finally`. */
  dispose: () => void;
}

/** The models a run reads: the federation, or the legacy single-model store
 *  when no federated model is loaded (the `resolveValidationTarget` fallback).
 *  A legacy run that sees a federated model ADDED mid-run is cancelled
 *  (`__legacy__` leaves the view): spurious but harmless, the user re-runs. */
function runModels(state: AnalysisRunModels): ReadonlyMap<string, FederationModelIdentity> {
  if (state.models.size > 0 || !state.ifcDataStore) return state.models;
  return new Map([[LEGACY_MODEL_ID, { ifcDataStore: state.ifcDataStore }]]);
}

/** The identity of every model a whole-federation run reads (IDS report scope,
 *  rule-set evaluation). */
export function captureRunIdentity(read: AnalysisRunModels): FederationIdentity {
  return captureFederationIdentity(runModels(read));
}

/**
 * Arm the guard at run start. With no `identity` it watches the run
 * generation only until `track` records one.
 */
export function guardAnalysisRun(
  store: Pick<StoreApi<AnalysisRunGuardState>, 'getState' | 'subscribe'>,
  onInvalidated: () => void,
  identity: FederationIdentity = new Map(),
): AnalysisRunGuard {
  const generation = store.getState().analysisRunGeneration;
  let read = identity;
  const holds = (s: AnalysisRunGuardState): boolean =>
    s.analysisRunGeneration === generation && federationIsCurrent(read, runModels(s));
  let watching = true;
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.models === prev.models && s.ifcDataStore === prev.ifcDataStore
      && s.analysisRunGeneration === prev.analysisRunGeneration) return;
    if (!holds(s)) invalidate();
  });
  function dispose(): void {
    if (!watching) return;
    watching = false;
    unsubscribe();
  }
  function invalidate(): void {
    if (!watching) return;
    dispose();
    queueMicrotask(onInvalidated);
  }
  return {
    isCurrent: () => watching && holds(store.getState()),
    track: (next) => {
      read = next;
      if (!holds(store.getState())) invalidate();
    },
    dispose,
  };
}
