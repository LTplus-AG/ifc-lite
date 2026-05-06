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

  return null;
}
