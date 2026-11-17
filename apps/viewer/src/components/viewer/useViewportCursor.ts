/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import { isGeometryHeld } from '@/lib/pick-gating';

export function setViewportInteractionCursor(canvas: HTMLCanvasElement, cursor: string): void {
  if (!isGeometryHeld(useViewerStore.getState())) canvas.style.cursor = cursor;
}

export function useViewportCursor(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  activeTool: string,
  sectionPickMode: boolean,
  setSectionPickMode: (armed: boolean) => void,
): void {
  const held = useViewerStore((state) => isGeometryHeld(state));
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (activeTool !== 'section' && sectionPickMode) setSectionPickMode(false);
    canvas.style.removeProperty('cursor');
    let frame = 0;
    if (held) {
      frame = requestAnimationFrame(() => { if (isGeometryHeld(useViewerStore.getState())) canvas.style.setProperty('cursor', 'progress', 'important'); });
    } else if (activeTool === 'measure' || activeTool === 'annotate' || (activeTool === 'section' && sectionPickMode)) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = 'default';
    }
    return () => { if (frame) cancelAnimationFrame(frame); };
  }, [canvasRef, activeTool, sectionPickMode, setSectionPickMode, held]);
}
