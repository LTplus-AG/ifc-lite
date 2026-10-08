/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps the `scan` authoring overlay channel in step with the scan-to-BIM
 * review (#6894): the detections behind every visible proposal, coloured by
 * class, redrawn when the run, a decision or the filter changes, cleared on
 * unmount. Mounted once, with the viewport container.
 */

import { useEffect } from 'react';
import { useViewerStore } from '@/store';
import { commandGhostId } from '@/lib/commands/modeling/ghost';
import { detectionOverlayMeshes } from '@/lib/scan-to-bim/detection-overlay';

/** Ghost-band slots 16.. (commands use 0-1, grids 3). */
export const SCAN_OVERLAY_ID_INDEX = 16;

export function useScanDetectionOverlay(): void {
  const run = useViewerStore((s) => s.scanDetectionRun);
  const decisions = useViewerStore((s) => s.scanProposalDecisions);
  const filter = useViewerStore((s) => s.scanProposalFilter);
  const setOverlay = useViewerStore((s) => s.cameraCallbacks.setAuthoringOverlayMeshes);
  useEffect(() => {
    if (!setOverlay) return;
    const state = useViewerStore.getState();
    // Clear first: the renderer forgets the overlay model's GPU frame once its
    // batches are gone, so a run far from the previous one is framed afresh.
    state.cameraCallbacks.clearAuthoringOverlayMeshes?.('scan');
    setOverlay('scan', detectionOverlayMeshes(run, decisions, filter, (i) => commandGhostId(state, SCAN_OVERLAY_ID_INDEX + i)));
  }, [run, decisions, filter, setOverlay]);
  useEffect(() => () => {
    useViewerStore.getState().cameraCallbacks.clearAuthoringOverlayMeshes?.('scan');
  }, []);
}

/** The hook as a component, so the viewport can load it lazily and mount it only while a run exists. */
export function ScanDetectionOverlay(): null {
  useScanDetectionOverlay();
  return null;
}
