/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';

/** Metadata and registration belong to one load, including its cancellation.
 * Registration completes before the existing background cache write; callers
 * need the actual model, not an IndexedDB write, before launching authoring. */
export function createModelLoadCompletion(signal: AbortSignal) {
  let resolveMetadata!: (store: IfcDataStore | null) => void;
  let rejectMetadata!: (error: unknown) => void;
  let resolveModelReady!: () => void;
  let metadataSettled = false;
  const metadata = new Promise<IfcDataStore | null>((resolve, reject) => {
    resolveMetadata = resolve;
    rejectMetadata = reject;
  });
  const modelReady = new Promise<void>(resolve => { resolveModelReady = resolve; });
  const settleModel = () => {
    signal.removeEventListener('abort', abandon);
    resolveModelReady();
  };
  const abandon = () => {
    if (!metadataSettled) {
      metadataSettled = true;
      resolveMetadata(null);
    }
    settleModel();
  };
  if (signal.aborted) abandon();
  else signal.addEventListener('abort', abandon, { once: true });

  return {
    metadata,
    modelReady,
    settleModel,
    setMetadata(store: IfcDataStore) {
      if (metadataSettled) return;
      metadataSettled = true;
      resolveMetadata(store);
    },
    failMetadata(error: unknown) {
      if (metadataSettled) return;
      metadataSettled = true;
      rejectMetadata(error);
    },
  };
}
