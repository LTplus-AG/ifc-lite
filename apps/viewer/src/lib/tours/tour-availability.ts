/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tours are a feature of their own (`help.tours`). A tour also teaches panels
 * and tools; when a host switched one of them off
 * (`lib/features`) the tour could only skip its steps, so it is not offered.
 * Read from the tour's own declarations: its panel, each step's panel, and
 * each step anchored on a tool (`toolAnchor`).
 */

import { isFeatureEnabled } from '@/lib/features';
import { isToolAvailable } from '@/lib/features/tools';
import { isPanelAvailable } from '@/lib/panels/availability';
import type { TourDefinition } from './types';

const TOOL_ANCHOR = /^tool-(.+)$/;

export function isTourAvailable(tour: TourDefinition): boolean {
  if (!isFeatureEnabled('help.tours')) return false;
  const panels = [tour.panel, ...tour.steps.map((step) => step.panel)];
  if (!panels.every((panel) => panel === undefined || isPanelAvailable(panel))) return false;
  return tour.steps.every((step) => {
    const tool = step.anchor ? TOOL_ANCHOR.exec(step.anchor)?.[1] : undefined;
    return tool === undefined || isToolAvailable(tool);
  });
}
