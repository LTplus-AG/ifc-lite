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
  'splitTool.closeAria': 'Exit the Split tool',
  'splitTool.hint': 'Point at the selected element to place the cut · type a distance or a % · Esc to exit',
  'splitTool.unitMetres': 'm',
  'splitTool.cutDistanceAria': 'Cut distance in metres, or a percentage of the element length',
} as const satisfies Record<string, TranslationValue>;
