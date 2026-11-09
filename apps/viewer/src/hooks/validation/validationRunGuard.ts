/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ends an in-flight IDS / rule-set run when the model set it read changes
 * underneath it (A1, implicit-state audit).
 *
 * `useValidationEpoch` only moves on run, cancel and definition change. The
 * teardowns that change the MODELS — `removeModel` / `clearAllModels` (which
 * call `clearIdsValidationReport()`), the session reset of "open a new file"
 * (`idsSlice.teardown.ts`), a collab peer edit swapping a model's store —
 * reset flags at most, so the run kept writing `idsProgress` under
 * `idsLoading: false` and then published a report naming models that were
 * gone, recolouring ids that may now belong to other entities.
 *
 * Two signals, because neither covers the other:
 *  - the FEDERATION IDENTITY (`lib/federation/federation-identity.ts`, shared
 *    with clash): read off the models, so any path that removes a model or
 *    replaces its entity table breaks it without having to remember this file;
 *  - `validationRunGeneration`: bumped by the session reset, which keeps
 *    `models` in place (it only nulls the top-level `ifcDataStore`), so the
 *    identity alone cannot see it in a federated session.
 *
 * The identity is captured from the models the run ACTUALLY read (passed in by
 * the hook), not from `getState()`: a retained `runValidation` closure can
 * resolve its target from a render-time `models` that already lost a model,
 * and capturing the live store instead would make that stale run look current.
 *
 * The guard subscribes for the run's lifetime and calls `onInvalidated` once
 * (the hook's own cancel: epoch bump + abort + flag reset), the pattern
 * `lib/scan-to-bim/run-detection.ts` uses — deferred to a microtask so the
 * cancel's own store writes do not nest inside the teardown's `set`.
 * `isCurrent()` is also checked at the publish site: it is what refuses a run
 * whose captured models were already stale at start, or a change the
 * subscription cannot observe.
 */

import type { StoreApi } from 'zustand';
import {
  captureFederationIdentity,
  federationIsCurrent,
  type FederationModelIdentity,
} from '@/lib/federation/federation-identity';

/** The id `resolveValidationTarget` gives a legacy single-model store. */
const LEGACY_MODEL_ID = '__legacy__';

/** The model set a run read: the federation plus the legacy single-model store. */
export interface ValidationRunModels {
  models: ReadonlyMap<string, FederationModelIdentity>;
  ifcDataStore: FederationModelIdentity['ifcDataStore'];
}

export interface ValidationRunGuardState extends ValidationRunModels {
  validationRunGeneration: number;
}

export interface ValidationRunGuard {
  /** False once the model set or the run generation changed. */
  isCurrent: () => boolean;
  /** Stop watching. Call from the run's `finally`. */
  dispose: () => void;
}

/** The models a run reads: the federation, or the legacy single-model store
 *  when no federated model is loaded (the `resolveValidationTarget` fallback).
 *  A legacy run that sees a federated model ADDED mid-run is cancelled
 *  (`__legacy__` leaves the view): spurious but harmless, the user re-runs. */
function runModels(state: ValidationRunModels): ReadonlyMap<string, FederationModelIdentity> {
  if (state.models.size > 0 || !state.ifcDataStore) return state.models;
  return new Map([[LEGACY_MODEL_ID, { ifcDataStore: state.ifcDataStore }]]);
}

export function guardValidationRun(
  store: Pick<StoreApi<ValidationRunGuardState>, 'getState' | 'subscribe'>,
  read: ValidationRunModels,
  onInvalidated: () => void,
): ValidationRunGuard {
  const generation = store.getState().validationRunGeneration;
  const identity = captureFederationIdentity(runModels(read));
  const holds = (s: ValidationRunGuardState): boolean =>
    s.validationRunGeneration === generation && federationIsCurrent(identity, runModels(s));
  let watching = true;
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.models === prev.models && s.ifcDataStore === prev.ifcDataStore
      && s.validationRunGeneration === prev.validationRunGeneration) return;
    if (holds(s)) return;
    dispose();
    queueMicrotask(onInvalidated);
  });
  function dispose(): void {
    if (!watching) return;
    watching = false;
    unsubscribe();
  }
  return { isCurrent: () => watching && holds(store.getState()), dispose };
}
