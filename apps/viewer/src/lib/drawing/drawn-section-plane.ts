/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SectionPlane } from '@/store/section-types';
import type { Drawing2DState, DrawnSectionPlane } from '@/store/slices/drawing2DSlice';

/**
 * The cut the drawing on screen describes. Moving the live `sectionPlane`
 * keeps the previous drawing on screen (a regenerate shows no overlay), so
 * export filenames, the axis flip and the layers drawn with the cut follow the
 * plane the drawing was generated at. With no drawing, or one published
 * without its plane, the live plane is the one that will be drawn.
 */
export function drawnSectionPlane(
  state: Pick<Drawing2DState, 'drawing2DPlane'> & { sectionPlane: SectionPlane },
): DrawnSectionPlane {
  return state.drawing2DPlane ?? state.sectionPlane;
}
