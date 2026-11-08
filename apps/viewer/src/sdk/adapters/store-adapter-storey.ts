/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.store` storey methods, kept off the viewer's boot path (#9013).
 *
 * The SDK host is built at boot and its methods are synchronous, so the
 * storey write path cannot be imported on first call. Building the host
 * starts loading it (`store-adapter-storey-impl.ts`) in its own chunk; it is
 * ready long before a script runs. A call that still comes first is refused
 * with a message, never answered from a partial implementation.
 */

import type { StoreApi } from './types.js';
import type { StoreyMethods } from './store-adapter-storey-impl.js';

type Impl = typeof import('./store-adapter-storey-impl.js');

let impl: Impl | null = null;
let failure: unknown = null;
let loading: Promise<Impl> | null = null;

/** Load the storey write path; resolves once `bim.store` storey methods can run. */
export function loadStoreyAdapter(): Promise<Impl> {
  loading ??= import('./store-adapter-storey-impl.js').then(
    (loaded) => { impl = loaded; failure = null; return loaded; },
    (error: unknown) => { failure = error; loading = null; throw error; },
  );
  return loading;
}

export function storeyMutationTracking(store: StoreApi): StoreyMethods {
  loadStoreyAdapter().catch((error: unknown) => {
    // Reported again, with the cause, by the first storey call that needs it.
    console.warn('[bim.store] storey authoring failed to load', error);
  });
  let methods: StoreyMethods | null = null;
  const live = (name: string): StoreyMethods => {
    if (methods) return methods;
    if (!impl) {
      const cause = failure instanceof Error ? failure.message : failure === null ? null : String(failure);
      throw new Error(cause === null
        ? `bim.store.${name}: storey authoring is still loading; run the script again in a moment`
        : `bim.store.${name}: storey authoring failed to load (${cause})`);
    }
    methods = impl.storeyMethods(store);
    return methods;
  };
  return {
    listStoreyLevels: (...args) => live('listStoreyLevels').listStoreyLevels(...args),
    addStorey: (...args) => live('addStorey').addStorey(...args),
    renameStorey: (...args) => live('renameStorey').renameStorey(...args),
    planStoreyEdit: (...args) => live('planStoreyEdit').planStoreyEdit(...args),
    editStorey: (...args) => live('editStorey').editStorey(...args),
    planStoreyDelete: (...args) => live('planStoreyDelete').planStoreyDelete(...args),
    deleteStorey: (...args) => live('deleteStorey').deleteStorey(...args),
  };
}
