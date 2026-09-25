/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared constants for section tool components
 */

/**
 * Axis display info for semantic names.
 *
 * `axisFill` is the Tailwind fill utility for the axis token (#5483) of the
 * IFC axis each cut is perpendicular to. The viewer is Y-up but IFC is Z-up
 * (`down` cuts along viewer Y = IFC Z, `front` along viewer Z = IFC Y, `side`
 * along X), and the tokens name IFC axes. Every axis shares one plane styling
 * (the interaction accent, #5488); the axis token only colours the small
 * identity dot, so it is the one place axis identity carries a hue. Spelled
 * out as literal class names so Tailwind's scanner emits them.
 */
export const AXIS_INFO = {
  down: {
    labelKey: 'sectionTool.axis.down', statusKey: 'sectionTool.hint.down',
    flippedStatusKey: 'sectionTool.hint.downFlipped', badgeKey: 'sectionTool.badge.down',
    axisFill: 'fill-axis-z',
  },
  front: {
    labelKey: 'sectionTool.axis.front', statusKey: 'sectionTool.hint.front',
    flippedStatusKey: 'sectionTool.hint.frontFlipped', badgeKey: 'sectionTool.badge.front',
    axisFill: 'fill-axis-y',
  },
  side: {
    labelKey: 'sectionTool.axis.side', statusKey: 'sectionTool.hint.side',
    flippedStatusKey: 'sectionTool.hint.sideFlipped', badgeKey: 'sectionTool.badge.side',
    axisFill: 'fill-axis-x',
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
