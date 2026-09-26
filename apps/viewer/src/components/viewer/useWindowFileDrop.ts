/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's one file drop target: the whole window (#5845).
 *
 * The empty state says "drag & drop anywhere", but the drop handlers used to
 * sit on the viewport root only. A file dropped on the ribbon, sidebar,
 * status bar or a panel was ignored, and over non-viewport chrome the browser
 * navigated away to the file.
 *
 * Contract:
 * - Only FILE drags from outside the page are touched. Text, links, the
 *   app's own reorder drags and an in-page image drag (which Chromium reports
 *   with a `Files` type) pass through untouched.
 * - A file drop is always `preventDefault`ed, so the browser never navigates
 *   to it, even when drops are not accepted (no WebGPU).
 * - A child drop zone keeps its drop, whether it stops propagation or only
 *   `preventDefault`s. The overlay's enter/leave depth is counted in the
 *   CAPTURE phase, so a zone that stops some events (the Data Connector stops
 *   dragover/dragleave/drop but not dragenter) cannot unbalance it or leave
 *   the overlay stuck. A dragover seen in capture but not claimed in bubble
 *   is the window's; one a zone claimed (stopped or `defaultPrevented`) hides
 *   the full-window overlay so the zone's own highlight shows.
 */

import { useEffect, useState } from 'react';
import { useLatestRef } from '@/hooks/useLatestRef';
import { initialDragOverlayState, reduceDragOverlay, type DragOverlayEvent } from './dragOverlayState';

/** True when the drag carries files from the OS (not text, a link, or an in-app drag). */
export function isFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes('Files');
}

/**
 * Listen for file drags on `window`. `onDrop` receives the dropped
 * `DataTransfer` synchronously (its item list is neutered once the event
 * returns). Returns whether the full-window drop overlay should show.
 */
export function useWindowFileDrop(onDrop: (dataTransfer: DataTransfer) => void, accept: boolean): boolean {
  const [overlay, setOverlay] = useState(false);
  const onDropRef = useLatestRef(onDrop);

  useEffect(() => {
    let state = initialDragOverlayState;
    // The current dragover was claimed by a child drop zone.
    let claimed = false;
    // A drag that started inside the page (dragstart only fires for those).
    // Cleared by the next pointerdown, dragend or window drop, so a drag a component
    // cancelled in its own dragstart (no dragend follows) cannot leave it set
    // and make every later OS file drop navigate.
    let inPage = false;
    const sync = () => setOverlay(state.dragging && !claimed);
    const step = (event: DragOverlayEvent) => {
      state = reduceDragOverlay(state, event, accept);
      if (!state.dragging) claimed = false;
      sync();
    };
    const ours = (e: DragEvent) => !inPage && isFileDrag(e.dataTransfer);

    // Bubble phase: a component that cancelled its drag has already said so.
    const onDragStart = (e: DragEvent) => { if (!e.defaultPrevented) inPage = true; };
    const clearInPage = () => { inPage = false; };
    // Capture phase: runs before any child zone can stop propagation.
    const onEnterCapture = (e: DragEvent) => { if (ours(e)) step('enter'); };
    const onLeaveCapture = (e: DragEvent) => { if (ours(e)) step('leave'); };
    const onDropCapture = (e: DragEvent) => { if (ours(e)) step('drop'); };
    const onOverCapture = (e: DragEvent) => {
      if (!ours(e)) return;
      claimed = true; // until the bubble phase proves no zone took it
      sync();
    };
    // Bubble phase: only reached when no zone stopped propagation.
    const onOver = (e: DragEvent) => {
      if (!ours(e)) return;
      claimed = e.defaultPrevented;
      if (!claimed) {
        e.preventDefault(); // makes the window a drop target, so no navigation
        if (e.dataTransfer) e.dataTransfer.dropEffect = accept ? 'copy' : 'none';
      }
      sync();
    };
    const onDrop = (e: DragEvent) => {
      if (inPage) {
        // Cleared here, at the end of the drop, not in capture: the bubble
        // phase must still see the in-page drag. A zone that stops the drop
        // leaves the reset to dragend / the next pointerdown.
        clearInPage();
        return;
      }
      if (!isFileDrag(e.dataTransfer) || e.defaultPrevented) return; // a child drop zone handled it
      e.preventDefault();
      // Always handed to the caller, even when `accept` is false (#5851):
      // `accept` only steers the cursor/overlay above, so the caller's own
      // guard — not a swallowed drop — is what explains an unsupported
      // browser. A silent no-op here is the bug #5851 fixed.
      if (e.dataTransfer) onDropRef.current(e.dataTransfer);
    };

    const listeners: Array<[string, (e: DragEvent) => void, boolean]> = [
      ['dragstart', onDragStart, false],
      ['dragend', clearInPage, true],
      ['pointerdown', clearInPage, true],
      ['dragenter', onEnterCapture, true],
      ['dragleave', onLeaveCapture, true],
      ['drop', onDropCapture, true],
      ['dragover', onOverCapture, true],
      ['dragover', onOver, false],
      ['drop', onDrop, false],
    ];
    for (const [type, fn, capture] of listeners) window.addEventListener(type, fn as EventListener, capture);
    return () => {
      for (const [type, fn, capture] of listeners) window.removeEventListener(type, fn as EventListener, capture);
      setOverlay(false);
    };
  }, [accept, onDropRef]);

  return overlay;
}
