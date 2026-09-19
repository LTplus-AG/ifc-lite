/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Split tool's own two overlays (#4918 slice): `SplitNumericInput`
 * (the floating precise-distance panel with its metres/percent mode
 * toggle, Cut button and Snap-fraction row) and `SplitOverlay` (the idle
 * hint chip shown before an element is hovered). The live SVG guide/label
 * drawn once an element IS hovered is numeric only (distance/length via
 * `formatSplitHoverLabel`) and carries no prose of its own.
 */
export const splitToolEn = {
  'splitTool.modeMetres': 'm',
  'splitTool.ofLength': 'of {length}m',
  'splitTool.cutButton': 'Cut',
  'splitTool.snapLabel': 'Snap',
  'splitTool.hintChip': 'Move the cursor to set the cut point on the selected element — Esc to exit',
} as const satisfies Record<string, TranslationValue>;
