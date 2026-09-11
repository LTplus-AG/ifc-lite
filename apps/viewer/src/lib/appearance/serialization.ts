/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { planAuthoredResourceCleanup } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { modelAppearanceAssets } from './model-assets.js';

/**
 * Planning and portable STEP export omit only tracked, unreachable authored
 * resources. History continues to own the live rows and image leases (#4243).
 * The detached view is never committed; allocation uses the LIVE view watermark.
 * Imported resources remain untouched, even if no visible geometry uses them.
 */
export function prepareAppearanceSerialization(
  modelId: string, dataStore: IfcDataStore, view: MutablePropertyView | undefined,
  assets = modelAppearanceAssets,
) {
  if (!view) {
    const archive = assets.exportOriginals(modelId);
    return { view, resources: { exportResources: () => archive } };
  }
  const candidates = assets.authoredLifecycle.serializationCandidates(modelId, dataStore, view);
  const plan = candidates.size ? planAuthoredResourceCleanup(dataStore, view, candidates) : undefined;
  const serializedView = plan?.entityIds.size ? view.prepareAtomic(draft => {
    for (const id of plan.entityIds) draft.deleteEntity(id);
    return draft;
  }).result : view;
  const archive = assets.exportResources(modelId, plan?.retainedImageUris);
  return { view: serializedView, resources: { exportResources: () => archive } };
}
