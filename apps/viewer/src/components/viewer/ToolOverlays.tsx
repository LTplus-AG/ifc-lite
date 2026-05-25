/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tool-specific overlays for measure and section tools
 */

import { useViewerStore } from '@/store';
import { MeasureOverlay } from './tools/MeasurePanel';
import { SectionOverlay } from './tools/SectionPanel';
import { AddElementOverlay } from './tools/AddElementOverlay';
import { GizmoOverlay } from './tools/GizmoOverlay';
import { WallEndpointOverlay } from './tools/WallEndpointOverlay';
import { SplitOverlay } from './tools/SplitOverlay';
import { SplitNumericInput } from './tools/SplitNumericInput';

export function ToolOverlays() {
  const activeTool = useViewerStore((s) => s.activeTool);

  if (activeTool === 'measure') {
    return <MeasureOverlay />;
  }

  if (activeTool === 'section') {
    return <SectionOverlay />;
  }

  if (activeTool === 'addElement') {
    return <AddElementOverlay />;
  }

  if (activeTool === 'split') {
    // SplitOverlay renders the SVG preview (perpendicular guide /
    // slab outline / ghost cut line). SplitNumericInput renders
    // the floating numeric panel next to the cursor for precise
    // single-click element splits (wall / beam / column / member).
    // The two are siblings rather than nested so the SVG layer
    // stays pointer-events-none while the numeric input is
    // interactive.
    return (
      <>
        <SplitOverlay />
        <SplitNumericInput />
      </>
    );
  }

  // Select tool: surface the move gizmo + wall-endpoint handles when
  // edit mode is on. Both overlays self-gate (return null when their
  // conditions aren't met) so always-rendering them here is safe.
  // Wall handles render on top of the gizmo so a wall selection
  // gets both axis arrows for translate AND endpoint drag handles
  // for resize — they don't overlap visually (gizmo at bbox center,
  // handles at start/end).
  if (activeTool === 'select') {
    return (
      <>
        <GizmoOverlay />
        <WallEndpointOverlay />
      </>
    );
  }

  return null;
}
