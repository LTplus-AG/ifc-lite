/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '../../store/index.js';
import { findReferenceSpatialModel } from './federationAlign.js';
import { realignFederatedPointClouds } from './pointCloudFederationLifecycle.js';

/**
 * Remove a model from the federation: the one removal `useIfcFederation`'s
 * `removeModel` performs, also for callers outside React (a site-context
 * model replaced by a newer one of its kind). The store selects the successor
 * and updates both active-data mirrors atomically; re-copying the first
 * survivor here would overwrite a different active model's source and
 * geometry under its existing ID range (#7890).
 */
export function removeFederatedModel(modelId: string): void {
  useViewerStore.getState().removeModel(modelId);
  realignFederatedPointClouds(findReferenceSpatialModel()?.placement ?? null);
}
