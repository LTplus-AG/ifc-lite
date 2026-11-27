/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { ViewerState } from '@/store';
import { isDrawingGenerationPending } from '@/lib/drawing/active-canvas-snapshot';
import { isGeometryHeld } from '@/lib/pick-gating';

type SectionDrawingState = Pick<ViewerState,
  'drawing2DPanelVisible' | 'floatingPanels' | 'poppedOutIds' | 'activeTool' | 'drawing2DDisplayOptions'
  | 'drawing2DStatus' | 'drawing2D' | 'drawing2DPlane' | 'sectionPlane' | 'models'>;

/**
 * A drawing view is on screen when the panel is docked in the bottom strip,
 * floating, or popped out (#5493). Opening another bottom panel clears the
 * dock flag but leaves a floating / popped-out drawing showing.
 */
export function isDrawingPanelShown(s: Pick<ViewerState, 'drawing2DPanelVisible' | 'floatingPanels' | 'poppedOutIds'>): boolean {
  return s.drawing2DPanelVisible || s.floatingPanels.some((p) => p.id === 'drawing') || s.poppedOutIds.includes('drawing');
}

/** The section tool shows the drawing as its 3D cap. */
const capWanted = (s: SectionDrawingState): boolean => s.activeTool === 'section' && s.drawing2DDisplayOptions.show3DOverlay;

/** The plane as `useDrawingGeneration` keys a cut: axis, position, flip and the custom frame. */
const planeKey = (p: Pick<SectionDrawingState['sectionPlane'], 'axis' | 'position' | 'flipped' | 'custom'>): string =>
  JSON.stringify([p.axis, p.position, p.flipped, p.custom]);

/**
 * The drawing the viewport's cap effect last handled (`useRenderUpdates`): uploaded as the cap, or
 * cleared because it does not belong on this plane. `undefined` until that effect first runs, which
 * never equals a drawing, so a cap that is wanted stays unsettled until then.
 */
let capApplied: Drawing2D | null | undefined;
export function markSectionCapApplied(drawing: Drawing2D | null): void { capApplied = drawing; }

/**
 * Whether the section drawing the viewport shows has caught up with the live
 * cut. The 3D section cap and the 2D panel draw from a drawing the viewer
 * generates asynchronously (`useDrawingGeneration`), and the cap reaches the
 * renderer in a later effect: a screenshot taken when the renderer first went
 * idle could show the cut without its cap (#11428).
 *
 * Unsettled while a drawing is wanted (the panel is shown, or the section
 * tool shows its 3D cap) and a generation runs, the drawing on screen was cut
 * at a plane the live one has since left (its replacement is about to be
 * requested), or the cap has not yet been applied for the current drawing.
 * Settled at idle (nothing to draw), at error, and while geometry is held
 * (the cap is cleared and generation waits for the restore): waiting there
 * would bring nothing more.
 */
export function isSectionDrawingSettled(state: SectionDrawingState, generationPending = isDrawingGenerationPending()): boolean {
  if (!isDrawingPanelShown(state) && !capWanted(state)) return true;
  if (isGeometryHeld(state)) return true;
  if (generationPending || state.drawing2DStatus === 'generating') return false;
  if (state.drawing2DStatus !== 'ready' || !state.drawing2D) return true;
  // A drawing published without its plane is the live plane's (`drawnSectionPlane`).
  if (state.drawing2DPlane && planeKey(state.drawing2DPlane) !== planeKey(state.sectionPlane)) return false;
  return !capWanted(state) || capApplied === state.drawing2D;
}
