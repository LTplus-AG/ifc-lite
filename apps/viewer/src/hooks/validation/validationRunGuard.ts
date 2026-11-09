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
 *  - `validationRunGeneration`: bumped by the store paths that reset
 *    `idsLoading` behind the run's back, including a session reset that
 *    leaves the models in place.
 *
 * The guard subscribes for the run's lifetime and calls `onInvalidated` once
 * (the hook's own cancel: epoch bump + abort + flag reset), the pattern
 * `lib/scan-to-bim/run-detection.ts` uses. `isCurrent()` is also checked at
 * the publish site, so a publish can never land on a changed model set.
 */

import type { StoreApi } from 'zustand';
import {
  captureFederationIdentity,
  federationIsCurrent,
  type FederationModelIdentity,
} from '@/lib/federation/federation-identity';

/** The id `resolveValidationTarget` gives a legacy single-model store. */
const LEGACY_MODEL_ID = '__legacy__';

export interface ValidationRunGuardState {
  models: ReadonlyMap<string, FederationModelIdentity>;
  ifcDataStore: FederationModelIdentity['ifcDataStore'];
  validationRunGeneration: number;
}

export interface ValidationRunGuard {
  /** False once the model set or the run generation changed. */
  isCurrent: () => boolean;
  /** Stop watching. Call from the run's `finally`. */
  dispose: () => void;
}

/** The models a run reads: the federation, or the legacy single-model store
 *  when no federated model is loaded (the `resolveValidationTarget` fallback). */
function runModels(state: ValidationRunGuardState): ReadonlyMap<string, FederationModelIdentity> {
  if (state.models.size > 0 || !state.ifcDataStore) return state.models;
  return new Map([[LEGACY_MODEL_ID, { ifcDataStore: state.ifcDataStore }]]);
}

export function guardValidationRun(
  store: Pick<StoreApi<ValidationRunGuardState>, 'getState' | 'subscribe'>,
  onInvalidated: () => void,
): ValidationRunGuard {
  const start = store.getState();
  const generation = start.validationRunGeneration;
  const identity = captureFederationIdentity(runModels(start));
  const holds = (s: ValidationRunGuardState): boolean =>
    s.validationRunGeneration === generation && federationIsCurrent(identity, runModels(s));
  let watching = true;
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.models === prev.models && s.ifcDataStore === prev.ifcDataStore
      && s.validationRunGeneration === prev.validationRunGeneration) return;
    if (holds(s)) return;
    dispose();
    onInvalidated();
  });
  function dispose(): void {
    if (!watching) return;
    watching = false;
    unsubscribe();
  }
  return { isCurrent: () => watching && holds(store.getState()), dispose };
}
