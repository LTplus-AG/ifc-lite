/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The models as a published comparison saw them (#5312).
 *
 * When a compared model carried unsaved edits, Compare fingerprinted a baked
 * store (`effectiveCompareStore`), not the model's parsed `ifcDataStore`. The
 * panel's row names, the change detail and the CSV/JSON report read entity
 * data back by each entry's ref after the run. They must read the same store
 * the diff was computed from, or a renamed element is listed under its old
 * name and a created one under none. Any edit clears the result
 * (`useClearCompareOnEdit`), so the baked store cannot go stale while shown.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';

export function modelsAsCompared(
  models: ReadonlyMap<string, FederatedModel>,
  comparedStores: ReadonlyMap<string, IfcDataStore> | undefined,
): ReadonlyMap<string, FederatedModel> {
  if (!comparedStores || comparedStores.size === 0) return models;
  const out = new Map(models);
  for (const [modelId, ifcDataStore] of comparedStores) {
    const model = models.get(modelId);
    if (model) out.set(modelId, { ...model, ifcDataStore });
  }
  return out;
}
