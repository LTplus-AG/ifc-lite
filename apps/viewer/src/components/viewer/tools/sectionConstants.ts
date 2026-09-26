/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared constants for section tool components
 */

/** Axis display info for semantic names: the catalogue key of each cut axis's label. */
export const AXIS_INFO = {
  down: {
    labelKey: 'sectionTool.axis.down',
  },
  front: {
    labelKey: 'sectionTool.axis.front',
  },
  side: {
    labelKey: 'sectionTool.axis.side',
  },
} as const;

type PresetView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/**
 * The 3D camera preset that looks along the same cut as a cardinal section
 * plane (#5497's "Match 3D"): the viewer's floor plan used to force this on
 * every activation; it is now an explicit choice from the Drawing header, and
 * this is the mapping it applies. `flipped` picks the opposite side of the
 * plane, matching which half of the model the cut currently shows.
 */
export function presetViewForAxis(axis: keyof typeof AXIS_INFO, flipped: boolean): PresetView {
  switch (axis) {
    case 'down': return flipped ? 'bottom' : 'top';
    case 'front': return flipped ? 'back' : 'front';
    case 'side': return flipped ? 'left' : 'right';
  }
}
