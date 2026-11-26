/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react';
import type { useIfcLoader } from '@/hooks/useIfcLoader';
import type { useIfcFederation } from '@/hooks/useIfcFederation';
import { registerAgentModelLoader } from '@/lib/agent-bridge/model-loader-host';
import { isIfcxDataStore, useViewerStore } from '@/store';

/** Case-insensitive IFCX check (filenames are accepted case-insensitively). */
export function isIfcxModelFile(f: File): boolean {
  return f.name.toLowerCase().endsWith('.ifcx');
}

type Federation = ReturnType<typeof useIfcFederation>;

export function useAgentModelLoader(
  loadFile: ReturnType<typeof useIfcLoader>['loadFile'],
  addModel: Federation['addModel'],
  loadFederatedIfcx: Federation['loadFederatedIfcx'],
): void {
  // The same loaders, awaitable, for a connected agent (`viewer_open_model`).
  useEffect(() => registerAgentModelLoader({
    loadFile: (file, modelId, onError, beforePrimaryReset) => loadFile(file, { kind: 'primary', modelId }, { onLoadError: onError, beforePrimaryReset }),
    addModel: (file, onError) => {
      // The native Add Model re-composes an IFCX overlay or refuses IFCX on a non-IFCX model
      // (addSupportedFiles); an independent agent add would do neither, so it is refused here.
      const store = useViewerStore.getState().ifcDataStore;
      if (isIfcxModelFile(file) && store) {
        onError(isIfcxDataStore(store)
          ? 'Adding an IFCX file to an open IFCX model re-composes it as an overlay; use the viewer\'s Add Model for that.'
          : 'An IFCX file cannot be added to an open non-IFCX model.');
        return Promise.resolve(null);
      }
      return addModel(file, { onError });
    },
    loadStack: loadFederatedIfcx,
  }), [loadFile, addModel, loadFederatedIfcx]);
}
