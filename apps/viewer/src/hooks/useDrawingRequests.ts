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
  setDrawingError: (error: string | null) => void;
}

/**
 * Every drawing request through one queue, each chain ending in a terminal state.
 *
 * The queue ends a chain of superseding requests exactly once (see
 * `createDrawingRequestQueue`), and that one ending is where the BCF capture
 * pending flag every request raised is released. When the chain's current
 * run finishes, `computeDrawing` has already published its result, error or
 * empty state. When a cancel (last model removed, panel closed, unmount)
 * abandons it instead, nothing will publish, so the ending restores the status
 * here: `ready` over the kept drawing, or `idle`. That only applies if a cut
 * in the chain raised the "generating" overlay. A regenerate never raises it,
 * but it can inherit one from a first cut it superseded, so the overlay is
 * tracked for the chain, not per request (#9488).
 *
 * A current run that throws past `computeDrawing`'s own try/catch (anything
 * between raising the overlay and starting the cut) records its error here,
 * so the overlay comes down for callers that drop the rejection — the panel's
 * Regenerate and Retry buttons. A run that is no longer current writes
 * nothing: its chain already ended, or a newer request now owns the status.
 */
export function useDrawingRequests({
  computeDrawing, drawing, setDrawingStatus, setDrawingError,
}: DrawingRequestsParams) {
  const queueRef = useRef<ReturnType<typeof createDrawingRequestQueue> | null>(null);
  if (!queueRef.current) queueRef.current = createDrawingRequestQueue();
  const queue = queueRef.current;
  // Updated before the caller's effects run, so a cancel in them sees this commit's drawing.
  const drawingRef = useRef(drawing);
  useEffect(() => { drawingRef.current = drawing; });
  /** A cut in the unended chain set 'generating'; only its ending lowers it. */
  const overlayRaised = useRef(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const generateDrawing = useCallback((isRegenerate = false) => {
    markActiveDrawingGenerationStarted();
    return queue.request(async (isCurrent) => {
      setIsRegenerating(isRegenerate);
      if (!isRegenerate) overlayRaised.current = true;
      try {
        await computeDrawing(isRegenerate, isCurrent);
      } catch (error) {
        if (isCurrent()) setDrawingError(error instanceof Error ? error.message : 'Generation failed');
        throw error;
      } finally {
        setIsRegenerating(false);
      }
    }, (cancelled) => {
      markActiveDrawingGenerationSettled();
      if (cancelled) {
        setIsRegenerating(false);
        if (overlayRaised.current) setDrawingStatus(drawingRef.current ? 'ready' : 'idle');
      }
      overlayRaised.current = false;
    });
  }, [computeDrawing, queue, setDrawingStatus, setDrawingError]);
  const doRegenerate = useCallback(() => generateDrawing(true), [generateDrawing]);

  return { queue, generateDrawing, doRegenerate, isRegenerating };
}
