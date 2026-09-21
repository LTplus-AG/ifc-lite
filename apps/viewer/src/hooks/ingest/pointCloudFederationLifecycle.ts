/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelSpatialPlacement } from './federationAlign.js';
import { useViewerStore } from '../../store/index.js';
import { getGlobalRenderer } from '../useBCF.js';
import { hasRegisteredPointCloudAlignment } from './pointCloudAlignment.js';
import { realignPointCloudsToAnchor } from './pointCloudAlignmentRealign.js';

/** Keep independent scan renderer assets on the current federation anchor. */
export function realignFederatedPointClouds(anchor: ModelSpatialPlacement | null): void {
  realignPointCloudsToAnchor(getGlobalRenderer(), anchor);
  useViewerStore.getState().setPointCloudAlignmentAvailable(hasRegisteredPointCloudAlignment());
}
