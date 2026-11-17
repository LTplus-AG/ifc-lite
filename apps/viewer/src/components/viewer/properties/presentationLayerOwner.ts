/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityRef, FederatedModel } from '@/store';

/** Same fallback as PropertiesPanel and same (store, offset) owner as the tree. */
export function presentationLayerOwner(ref: EntityRef, models: Map<string, FederatedModel>, legacyStore: IfcDataStore | null | undefined) {
  // Keep the shared-branch fix: only 'legacy' bypasses models; null model data
  // still falls back to the global store exactly like PropertiesPanel.
  const model = ref.modelId === 'legacy' ? undefined : models.get(ref.modelId);
  const store = model?.ifcDataStore ?? legacyStore;
  let modelId = model?.id ?? 'legacy';
  if (model?.ifcDataStore) {
    for (const [id, owner] of models) {
      if (owner.ifcDataStore === store && owner.idOffset === model.idOffset) { modelId = id; break; }
    }
  }
  return { store, modelId };
}
