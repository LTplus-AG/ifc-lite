/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import {
  markActiveDrawingGenerationSettled,
  markActiveDrawingGenerationStarted,
} from '@/lib/drawing/active-canvas-snapshot';
import { createDrawingRequestQueue } from './drawingRequestQueue.js';

type DrawingStatus = 'idle' | 'generating' | 'ready' | 'error';

interface DrawingRequestsParams {
  /** Cuts and publishes one drawing; writes a terminal status while `isCurrent()`. */
  computeDrawing: (isRegenerate: boolean, isCurrent: () => boolean) => Promise<void>;
  /** The drawing on screen, kept by a cancelled cut. */
  drawing: Drawing2D | null;
  setDrawingStatus: (status: DrawingStatus) => void;
}

/**
 * Every drawing request through one queue, each ending in a terminal state.
 *
 * The current request ends its own generation: `computeDrawing` publishes the
 * result, error or empty state, and the BCF capture pending flag is released
 * here. A cancel (last model removed, panel closed, unmount) leaves no current
 * request, so the queue hands the abandoned cut's ending to `onCancel` at
 * once: it releases the pending flag and, if that cut raised the "generating"
 * overlay (a non-regenerate cut), restores `ready` over the kept drawing or
 * `idle`. A superseded cut is ended by its successor, so the overlay never
 * flashes idle between them.
 */
export function useDrawingRequests({ computeDrawing, drawing, setDrawingStatus }: DrawingRequestsParams) {
  const queueRef = useRef<ReturnType<typeof createDrawingRequestQueue> | null>(null);
  if (!queueRef.current) queueRef.current = createDrawingRequestQueue();
  const queue = queueRef.current;
  // Updated before the caller's effects run, so a cancel in them sees this commit's drawing.
  const drawingRef = useRef(drawing);
  useEffect(() => { drawingRef.current = drawing; });
  const [isRegenerating, setIsRegenerating] = useState(false);

  const generateDrawing = useCallback((isRegenerate = false) => {
    markActiveDrawingGenerationStarted();
    return queue.request(async (isCurrent) => {
      setIsRegenerating(isRegenerate);
      try {
        await computeDrawing(isRegenerate, isCurrent);
      } finally {
        setIsRegenerating(false);
        if (isCurrent()) markActiveDrawingGenerationSettled();
      }
    }, () => {
      markActiveDrawingGenerationSettled();
      setIsRegenerating(false);
      if (!isRegenerate) setDrawingStatus(drawingRef.current ? 'ready' : 'idle');
    });
  }, [computeDrawing, queue, setDrawingStatus]);
  const doRegenerate = useCallback(() => generateDrawing(true), [generateDrawing]);

  return { queue, generateDrawing, doRegenerate, isRegenerating };
}
