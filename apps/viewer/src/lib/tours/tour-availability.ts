/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tours are a feature of their own (`help.tours`). A tour also teaches panels
 * and tools; when a host switched one of them off
 * (`lib/features`) the tour could only skip its steps, so it is not offered.
 * Read from the tour's own declarations: its panel, each step's panel, and
 * each step anchored on a tool (`toolAnchor`). A tour that loads the sample
 * project also needs `files.samples`.
 */

import { isFeatureEnabled } from '@/lib/features';
import { isToolAvailable } from '@/lib/features/tools';
import { isPanelAvailable } from '@/lib/panels/availability';
import { toolOfAnchor } from './anchors';
import { getTour } from './registry';
import type { TourDefinition, TourId } from './types';

/**
 * A tour with prerequisites offers the sample (`demoFulfil`, or the base
 * project) on its interstitial, and a step action or `skipLoadsDemo` loads
 * it from the card. The ribbon tour has none of these and needs no model.
 */
function loadsSample(tour: TourDefinition): boolean {
  return tour.prerequisites !== undefined || tour.steps.some((step) => step.action !== undefined || step.skipLoadsDemo);
}

export function isTourAvailable(tour: TourDefinition): boolean {
  if (!isFeatureEnabled('help.tours')) return false;
  if (loadsSample(tour) && !isFeatureEnabled('files.samples')) return false;
  const panels = [tour.panel, ...tour.steps.map((step) => step.panel)];
  if (!panels.every((panel) => panel === undefined || isPanelAvailable(panel))) return false;
  return tour.steps.every((step) => {
    const tool = step.anchor ? toolOfAnchor(step.anchor) : undefined;
    return tool === undefined || isToolAvailable(tool);
  });
}

/** Whether the registered tour `id` can be offered (see `isTourAvailable`). */
export function isTourIdAvailable(id: TourId): boolean {
  const tour = getTour(id);
  return tour !== undefined && isTourAvailable(tour);
}
