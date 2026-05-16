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

  // Select tool: surface the move gizmo when edit mode is on and a
  // single translatable entity is selected. GizmoOverlay self-gates;
  // returns null otherwise so this branch is safe to always render
  // for the select tool.
  if (activeTool === 'select') {
    return <GizmoOverlay />;
  }

  return null;
}
