/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store`'s structural methods (#5167), with the structural write path
 * kept off the boot path (#9668) the way the storey methods are (#9200,
 * `store-adapter-storey.ts`). Every structural builder sits behind
 * `store-adapter-structural-impl.ts`, loaded in its own chunk; nothing else in
 * the viewer may import that module or `createStructuralStoreBackend`
 * statically. `apps/viewer/scripts/check-structural-writes-lazy.mjs` fails the
 * build if one does.
 *
 * The SDK host is built at boot and `bim.store` is synchronous, so building
 * the host starts the load; it is ready long before a script runs. A script
 * call that still comes first is refused with a message naming the method,
 * never answered from a partial implementation. A viewer flow that can wait
 * (the assistant's structural graph review) awaits `loadStructuralWrites()`
 * before its synchronous write.
 *
 * Collab gate + shared-room mirroring: spreading the SDK factory raw would
 * mutate the local overlay even when `canCollabEdit()` is false, and in a
 * shared room the authored entities and their `IfcRel*` rows would never be
 * published, so reconstruction would discard them. The gate and the mirror are
 * the ones cost uses; only the undo entity types and the failure label differ.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StructuralStoreBackendMethods, StructuralStoreModelResolver } from '@ifc-lite/sdk';
import { createStoreMutationTracker } from './store-adapter-cost.js';
import type { StoreApi } from './types.js';

type Impl = typeof import('./store-adapter-structural-impl.js');

let impl: Impl | null = null;
let failure: unknown = null;
let loading: Promise<Impl> | null = null;

/** Load the structural write path; resolves once structural writes can run. */
export function loadStructuralWrites(): Promise<Impl> {
  if (loading) return loading;
  failure = null; // a retry reports "still loading", not the previous failure
  loading = import('./store-adapter-structural-impl.js').then(
    (loaded) => { impl = loaded; return loaded; },
    (error: unknown) => { failure = error; loading = null; throw error; },
  );
  return loading;
}

/**
 * The loaded structural write path, for a synchronous caller. `label` prefixes
 * the refusal when it has not loaded yet (or failed to).
 */
export function loadedStructuralWrites(label: string): Impl {
  if (impl) return impl;
  const cause = failure instanceof Error ? failure.message : failure === null ? null : String(failure);
  // Start another attempt after a failure, so "try again" has something to wait for.
  if (cause !== null) loadStructuralWrites().catch((error: unknown) => console.warn('[bim.store] structural authoring failed to load again', error));
  throw new Error(cause === null
    ? `${label}: structural authoring is still loading; try again in a moment`
    : `${label}: structural authoring failed to load (${cause})`);
}

/** `Required` so a structural method added to the SDK interface, optional ones included, fails typecheck here until it is listed. */
type StructuralMethods = Required<StructuralStoreBackendMethods>;

export function structuralMutationTracking(
  store: StoreApi,
  resolveModel: StructuralStoreModelResolver,
  resolve: (modelId: string) => { editor: StoreEditor; dataStore: IfcDataStore } | null,
): StructuralMethods {
  loadStructuralWrites().catch((error: unknown) => {
    // Reported again, with the cause, by the first structural call that needs it.
    console.warn('[bim.store] structural authoring failed to load', error);
  });
  type Backend = ReturnType<Impl['createStructuralStoreBackend']>;
  let backend: Backend | null = null;
  const live = (name: keyof StructuralMethods): Backend =>
    backend ??= loadedStructuralWrites(`bim.store.${name}`).createStructuralStoreBackend(resolveModel);
  const { create } = createStoreMutationTracker(store, resolve, 'structural');
  // One forwarding loop keeps the synchronous facade small as lazy builders grow.
  const types = {
    addStructuralPlanarAction: 'IFCSTRUCTURALPLANARACTION',
    addStructuralSurfaceAction: 'IFCSTRUCTURALSURFACEACTION',
    addStructuralPointReaction: 'IFCSTRUCTURALPOINTREACTION',
    addStructuralCurveReaction: 'IFCSTRUCTURALCURVEREACTION',
    addStructuralSurfaceReaction: 'IFCSTRUCTURALSURFACEREACTION',
    addStructuralResultGroup: 'IFCSTRUCTURALRESULTGROUP',
    addStructuralAnalysisModel: 'IFCSTRUCTURALANALYSISMODEL',
    addStructuralCurveMember: 'IFCSTRUCTURALCURVEMEMBER',
    addStructuralPointConnection: 'IFCSTRUCTURALPOINTCONNECTION',
    addStructuralLoadGroup: 'IFCSTRUCTURALLOADGROUP',
    addStructuralPointAction: 'IFCSTRUCTURALPOINTACTION',
    addStructuralLinearAction: 'IFCSTRUCTURALLINEARACTION',
    connectStructuralMemberToConnection: 'IFCRELCONNECTSSTRUCTURALMEMBER',
    connectStructuralActivityToItem: 'IFCRELCONNECTSSTRUCTURALACTIVITY',
    assignToStructuralGroup: 'IFCRELASSIGNSTOGROUP',
  } satisfies Record<keyof StructuralMethods, string>;
  const methods = Object.entries(types).map(([key, type]) => {
    const name = key as keyof StructuralMethods;
    return [name, create(type, (...args: [string, ...unknown[]]) => {
      const backend = live(name);
      return Reflect.apply(backend[name], backend, args);
    })];
  });
  // Every key is required by `types`; each wrapper preserves the backend's arguments and return.
  return Object.fromEntries(methods) as StructuralMethods;
}
