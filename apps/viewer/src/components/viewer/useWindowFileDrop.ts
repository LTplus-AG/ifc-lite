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
 * - Only FILE drags are touched. Text, links and the app's own HTML5
 *   reorder drags carry no `Files` type and pass through untouched.
 * - A file drop is always `preventDefault`ed, so the browser never navigates
 *   to it, even when drops are not accepted (no WebGPU).
 * - A child drop zone keeps its drop: one that stops propagation never
 *   reaches the window, and one that only `preventDefault`s is seen as
 *   handled (`defaultPrevented`). While the pointer is over such a zone the
 *   full-window overlay steps aside so the zone's own highlight shows.
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
    // The last dragover was claimed by a child drop zone.
    let claimed = false;
    const sync = () => setOverlay(state.dragging && !claimed);
    const step = (event: DragOverlayEvent) => {
      state = reduceDragOverlay(state, event, accept);
      if (event === 'drop') claimed = false;
      sync();
    };

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      step('enter');
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      claimed = e.defaultPrevented;
      if (!claimed) {
        e.preventDefault(); // makes the window a drop target, so no navigation
        if (e.dataTransfer) e.dataTransfer.dropEffect = accept ? 'copy' : 'none';
      }
      sync();
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      step('leave');
    };
    const onDropEvent = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      step('drop');
      if (e.defaultPrevented) return; // a child drop zone handled it
      e.preventDefault();
      if (accept && e.dataTransfer) onDropRef.current(e.dataTransfer);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropEvent);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropEvent);
      setOverlay(false);
    };
  }, [accept, onDropRef]);

  return overlay;
}
