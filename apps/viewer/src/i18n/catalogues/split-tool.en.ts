/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Split tool's HUD presence (#4918 slice, on the `TOOL_HUD` registry
 * since #5503): its bar (`SplitHud`), the bottom-center hint the registry
 * declares, and the cursor-anchored distance entry (`SplitCursorInput`).
 * The live SVG guide/label drawn once an element IS hovered is numeric
 * only (distance/length via `formatSplitHoverLabel`) and carries no prose
 * of its own.
 */
export const splitToolEn = {
  'splitTool.barLabel': 'Split',
  'splitTool.hint': 'Point at the selected element to place the cut · type a distance or a % · Esc to exit',
  'splitTool.unitMetres': 'm',
  'splitTool.cutDistanceAria': 'Cut distance in metres, or a percentage of the element length',
  // Why an element cannot be split (`lib/split-target.ts`, #6233): the
  // disabled Split button's tooltip and the Split tool's error notice.
  'splitTool.unavailable.type': 'Split works on walls, beams, columns, members, slabs, roofs, plates and spaces',
  'splitTool.unavailable.storey': "Can't split: the element is not contained in a building storey",
  'splitTool.unavailable.noBody': "Can't split: the element has no body geometry",
  'splitTool.unavailable.mesh': "Can't split: the geometry is a mesh or B-rep, not a profile extrusion",
  'splitTool.unavailable.mapped': "Can't split: the geometry is shared with its type (mapped representation)",
  'splitTool.unavailable.boolean': "Can't split: the geometry is a boolean-clipped solid",
  'splitTool.unavailable.profile': "Can't split: the extrusion profile is not a rectangle",
  'splitTool.unavailable.shape': "Can't split: the placement or representation layout is not supported",
  'splitTool.unavailable.kind': "Can't split: this split method does not apply to this element",
  // A commit that passed the check above but was refused by the cut itself
  // (e.g. too close to an end); `reason` is the action's own message.
  'splitTool.failed': "Couldn't split: {reason}",
} as const satisfies Record<string, TranslationValue>;
