/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { isDrawingGenerationPending } from '@/lib/drawing/active-canvas-snapshot';

type SectionDrawingState = Pick<ViewerState,
  'drawing2DPanelVisible' | 'activeTool' | 'drawing2DDisplayOptions' | 'drawing2DStatus' | 'drawing2D' | 'drawing2DPlane' | 'sectionPlane'>;

/** The plane as `useDrawingGeneration` keys a cut: axis, position, flip and the custom frame. */
const planeKey = (p: Pick<SectionDrawingState['sectionPlane'], 'axis' | 'position' | 'flipped' | 'custom'>): string =>
  JSON.stringify([p.axis, p.position, p.flipped, p.custom]);

/**
 * Whether the section drawing the viewport shows has caught up with the live
 * cut. The 3D section cap and the 2D panel draw from a drawing the viewer
 * generates asynchronously (`useDrawingGeneration`), which can land after the
 * renderer has gone idle: a screenshot taken then shows the cut without its
 * cap (#11428). Unsettled while a drawing is wanted (the panel is open, or the
 * section tool shows its 3D overlay) and either a generation is running or the
 * drawing on screen was cut at a plane the live one has since left (its
 * replacement is about to be requested). Idle (nothing to draw) and error are
 * settled: nothing more will arrive.
 */
export function isSectionDrawingSettled(state: SectionDrawingState, generationPending = isDrawingGenerationPending()): boolean {
  const wanted = state.drawing2DPanelVisible || (state.activeTool === 'section' && state.drawing2DDisplayOptions.show3DOverlay);
  if (!wanted) return true;
  if (generationPending || state.drawing2DStatus === 'generating') return false;
  if (state.drawing2DStatus !== 'ready' || !state.drawing2D) return true;
  // A drawing published without its plane is the live plane's (`drawnSectionPlane`).
  return !state.drawing2DPlane || planeKey(state.drawing2DPlane) === planeKey(state.sectionPlane);
}
