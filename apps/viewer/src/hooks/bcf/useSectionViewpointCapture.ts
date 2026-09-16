/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useSyncExternalStore } from 'react';
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { toast } from '@/components/ui/toast';
import {
  captureActiveDrawingSnapshot,
  hasActiveDrawingCanvas,
  subscribeActiveDrawingCanvas,
} from '@/lib/drawing/active-canvas-snapshot';
import { useViewerStore } from '@/store';
import type { Drawing2DStatus } from '@/store/slices/drawing2DSlice';

interface SectionViewpointOptions {
  includeSnapshot?: boolean;
  snapshotOverride?: string;
  capturedSectionPlane?: { axis: 'down' | 'front' | 'side'; worldPosition: number; flipped: boolean };
  includeSelection?: boolean;
  includeHidden?: boolean;
}

type CreateViewpoint = (options?: SectionViewpointOptions) => Promise<BCFViewpoint | null>;
const SECTION_AXIS = { x: 'side', y: 'down', z: 'front' } as const;

/** The conditions that gate capturing the visible 2D section. */
export interface SectionCaptureState {
  panelVisible: boolean;
  status: Drawing2DStatus;
  hasDrawing: boolean;
  canvasMounted: boolean;
  editingText: boolean;
  customPlane: boolean;
}

/**
 * Why "Capture 2D" is unavailable, or null when it can run. The reason is shown
 * as visible text because a disabled button never receives hover, so a `title`
 * on it alone is never seen (#4802). Ordered so the hint names the step the user
 * can act on first: a custom plane cannot be fixed by opening the panel.
 */
export function sectionCaptureBlockReason(state: SectionCaptureState): string | null {
  if (state.customPlane) return 'Custom section planes cannot be captured in 2D yet.';
  if (!state.panelVisible) return 'Open the 2D section panel to capture it.';
  if (state.editingText) return 'Finish editing text in the 2D section first.';
  if (state.status === 'error') return 'The 2D section failed to generate.';
  if (state.status !== 'ready' || !state.hasDrawing || !state.canvasMounted) return 'The 2D section is still generating.';
  return null;
}

/** Connect the mounted annotated 2D section canvas to the active BCF topic. */
export function useSectionViewpointCapture(createViewpoint: CreateViewpoint): {
  /** Visible explanation while capture is unavailable; null when it can run. */
  disabledReason: string | null;
  capture: () => Promise<void>;
} {
  const activeTopicId = useViewerStore((state) => state.activeTopicId);
  const addViewpoint = useViewerStore((state) => state.addViewpoint);
  const drawing = useViewerStore((state) => state.drawing2D);
  const status = useViewerStore((state) => state.drawing2DStatus);
  const panelVisible = useViewerStore((state) => state.drawing2DPanelVisible);
  const editingText = useViewerStore((state) => state.textAnnotation2DEditing !== null);
  const customPlane = useViewerStore((state) => state.sectionPlane.custom !== undefined);
  const canvasMounted = useSyncExternalStore(
    subscribeActiveDrawingCanvas,
    hasActiveDrawingCanvas,
    hasActiveDrawingCanvas,
  );
  const disabledReason = sectionCaptureBlockReason({
    panelVisible,
    status,
    hasDrawing: drawing !== null,
    canvasMounted,
    editingText,
    customPlane,
  });

  const capture = useCallback(async () => {
    if (!activeTopicId || !drawing) return;
    try {
      const snapshot = captureActiveDrawingSnapshot();
      if (!snapshot) {
        toast.info('Open a generated 2D section before capturing it.');
        return;
      }
      const viewpoint = await createViewpoint({
        includeSnapshot: false,
        snapshotOverride: snapshot,
        capturedSectionPlane: {
          axis: SECTION_AXIS[drawing.config.plane.axis],
          worldPosition: drawing.config.plane.position,
          flipped: drawing.config.plane.flipped,
        },
        includeSelection: true,
        includeHidden: true,
      });
      if (!viewpoint) {
        toast.error('The 2D section viewpoint could not be created.');
        return;
      }
      addViewpoint(activeTopicId, viewpoint);
      toast.success('2D section added to the topic.');
    } catch (error) {
      console.error('[BCFPanel] Failed to capture the 2D section:', error);
      toast.error('The 2D section could not be captured.');
    }
  }, [activeTopicId, addViewpoint, createViewpoint, drawing]);

  return { disabledReason, capture };
}
