/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type IfcDataStore } from '@ifc-lite/parser';
import { getViewerStoreApi } from '@/store';

export async function ensureModelExportReady(modelId: string): Promise<IfcDataStore | null> {
  const store = getViewerStoreApi();
  const state = store.getState();

  if (modelId === '__legacy__') {
    return state.ifcDataStore;
  }

  const model = state.models.get(modelId);
  if (!model) {
    return null;
  }

  return model.ifcDataStore;
}
