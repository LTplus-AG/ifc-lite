/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one step that owns "a site-context model of kind K has arrived", for
 * every path: the panel's fetch and a dropped site-context GLB both load
 * through `loadSiteContextModel`, which calls this once the new model is in
 * the scene. There is one site context per scene: the earlier models of that
 * kind are removed only now, after the new one is in (a load that fails never
 * gets here, so the old one stays), and the category record points at the new
 * model and the model it was loaded around (none for a dropped file).
 * A model from a fetch run that is no longer current is not adopted; that run
 * takes it out again (#10481 review).
 */

import type { SiteContextLayer } from '@ifc-lite/site-context';
import { useViewerStore } from '@/store';
import { categoryStatusOf } from '@/store/slices/siteContextSlice';
import { removeFederatedModel } from '@/hooks/ingest/federationRemove';
import type { SiteContextArrival } from '@/hooks/modelLoadOptions';

/** True when the model was adopted as the scene's model of its kind. */
export function adoptSiteContextModel(
  modelId: string,
  layer: Pick<SiteContextLayer, 'kind' | 'complete' | 'issues' | 'attribution'>,
  arrival?: SiteContextArrival,
): boolean {
  if (arrival && !arrival.isCurrent()) return false;
  const previous = [...useViewerStore.getState().siteContextModels]
    .filter(([id, record]) => id !== modelId && record.kind === layer.kind)
    .map(([id]) => id);
  for (const id of previous) removeFederatedModel(id);
  const patch = {
    status: categoryStatusOf(true, layer.complete),
    modelId,
    anchorModelId: arrival?.anchorModelId,
    issues: layer.issues,
    attribution: layer.attribution,
  };
  const state = useViewerStore.getState();
  if (arrival) state.setSiteContextCategory(arrival.run, layer.kind, patch);
  else state.recordArrivedSiteContextCategory(layer.kind, patch);
  return true;
}
