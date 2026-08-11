/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch canvas viewport: panel size, the world↔screen transform, and
 * every gesture that moves it (fit, wheel zoom, drag pan, resize grip).
 *
 * Split out of `SpaceSketchOverlay.tsx` because the transform has an invariant
 * the overlay was upholding by duplication rather than by structure. `fitRef` is
 * a ref — it is read synchronously ~10 times per pointer event as
 * `PICK_PX / fitRef.current.scale`, so it cannot be React state — but the
 * underlay memo reads `fitRef.current` while depending on `fitTick`, so EVERY
 * write must bump that tick or the pre-rendered building lines freeze at the
 * old transform while the rooms move. Three call sites wrote `fitRef` and two
 * open-coded the bump instead of going through `applyFit`. Here there is one
 * writer, and no way to add a second from outside.
 *
 * `sizeRef` mirrors `size` with a render-phase write on purpose: `svgPoint`'s
 * clamp and the fit computations read it synchronously, and syncing it in an
 * effect instead would make the first pointer event after a resize use the
 * stale size.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { computeFitFromPoints, PAD, type Fit, type Pt } from '@/lib/space-sketch-geometry';
import { clampToCanvas, zoomStep } from './space-viewport';

const DEFAULT_W = 420;
const DEFAULT_H = 340;
const MIN_W = 320;
const MIN_H = 240;

export interface UseSpaceViewport {
  svgRef: React.RefObject<SVGSVGElement | null>;
  /** The live transform. Read synchronously; never write it directly. */
  fitRef: React.RefObject<Fit>;
  /** Bumped by every transform write, so memos keyed on it re-render. */
  fitTick: number;
  size: { w: number; h: number };
  /**
   * Frame `pts` in the current canvas. Along with {@link panBy} and the wheel
   * listener, one of exactly three ways the transform can move — `applyFit`
   * itself stays private so no caller can write `fitRef` without the tick.
   */
  fitToPoints: (pts: Pt[]) => void;
  /** Translate the view by a raw pointer delta (drag pan). */
  panBy: (dx: number, dy: number) => void;
  /** A mouse event's position in canvas pixels, clamped to the canvas. */
  svgPoint: (e: { clientX: number; clientY: number }) => Pt;
  /** Handlers for the corner resize grip. */
  resizeHandlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
  };
}

export function useSpaceViewport(): UseSpaceViewport {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fitRef = useRef<Fit>({ scale: 1, offX: PAD, offY: DEFAULT_H - PAD });
  const [fitTick, setFitTick] = useState(0);
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const applyFit = useCallback((next: Fit) => {
    fitRef.current = next;
    setFitTick((t) => t + 1);
  }, []);

  const fitToPoints = useCallback((pts: Pt[]) => {
    applyFit(computeFitFromPoints(pts, sizeRef.current.w, sizeRef.current.h));
  }, [applyFit]);

  const panBy = useCallback((dx: number, dy: number) => {
    const f = fitRef.current;
    applyFit({ scale: f.scale, offX: f.offX + dx, offY: f.offY + dy });
  }, [applyFit]);

  const svgPoint = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    return clampToCanvas(e.clientX - rect.left, e.clientY - rect.top, sizeRef.current.w, sizeRef.current.h);
  }, []);

  // Wheel = zoom about the cursor. A native NON-PASSIVE listener so
  // preventDefault() actually stops the page from scrolling under the panel;
  // React's synthetic onWheel is passive and cannot.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const next = zoomStep(fitRef.current, e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
      if (next) applyFit(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyFit]);

  const resizeHandlers = {
    onPointerDown: useCallback((e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = { x: e.clientX, y: e.clientY, w: sizeRef.current.w, h: sizeRef.current.h };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, []),
    onPointerMove: useCallback((e: React.PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      setSize({
        w: Math.max(MIN_W, Math.round(r.w + (e.clientX - r.x))),
        h: Math.max(MIN_H, Math.round(r.h + (e.clientY - r.y))),
      });
    }, []),
    onPointerUp: useCallback((e: React.PointerEvent) => {
      resizeRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }, []),
  };

  return { svgRef, fitRef, fitTick, size, fitToPoints, panBy, svgPoint, resizeHandlers };
}
