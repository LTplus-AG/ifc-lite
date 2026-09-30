/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's viewport (charter #6232, M2 §1.5): its measured size, the
 * `Fit` (screen ↔ workplane-local), wheel zoom about the cursor and drag
 * pan. Zoom goes through `zoomStep`, so the plan refuses an out-of-range zoom
 * instead of drifting.
 *
 * The plan frames itself once per storey, as soon as its cut has settled
 * (it arrives after a debounce), and keeps the frame fitted while the pane
 * resizes, until the user pans or zooms. Edits never refit (a first wall on
 * an empty storey must not make the plan jump); Fit and a storey change do.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Fit } from '@/lib/rooms/plate-geometry';
import { zoomStep } from './plan-zoom';

export interface PlanViewport {
  size: { width: number; height: number };
  fit: Fit | null;
  /** Re-frame now (the Fit button). */
  refit: () => void;
  /** Move the view by a screen delta (a pan drag). */
  panBy: (dx: number, dy: number) => void;
}

/**
 * `frame` computes the fit for a size; `frameKey` names what is framed
 * (model and storey) and `ready` says the content to frame has arrived.
 */
export function usePlanViewport(
  hostRef: RefObject<HTMLElement | null>,
  svgRef: RefObject<SVGSVGElement | null>,
  frame: (width: number, height: number) => Fit,
  frameKey: string,
  ready: boolean,
): PlanViewport {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState<Fit | null>(null);
  const framed = useRef<string | null>(null);
  /** The user panned or zoomed since the last fit: resizes stop refitting. */
  const moved = useRef(false);
  const framedSize = useRef<string | null>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setSize((prev) => (prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);

  // Frame once per storey when its content is ready; refit on resize until the user navigates.
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0 || !ready) return;
    const sized = `${size.width}x${size.height}`;
    if (framed.current === frameKey) {
      // Same storey: only a resize refits, and only while the user has not navigated.
      if (framedSize.current === sized || moved.current) return;
    } else {
      moved.current = false;
    }
    framed.current = frameKey;
    framedSize.current = sized;
    setFit(frameRef.current(size.width, size.height));
  }, [frameKey, ready, size.width, size.height]);

  const refit = useCallback(() => {
    moved.current = false;
    if (size.width > 0 && size.height > 0) setFit(frameRef.current(size.width, size.height));
  }, [size.width, size.height]);

  const panBy = useCallback((dx: number, dy: number) => {
    moved.current = true;
    setFit((f) => (f ? { ...f, offX: f.offX + dx, offY: f.offY + dy } : f));
  }, []);

  // Wheel zoom about the cursor; non-passive so the page never scrolls instead.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      moved.current = true;
      const rect = svg.getBoundingClientRect();
      const ax = e.clientX - rect.left, ay = e.clientY - rect.top;
      setFit((f) => (f ? zoomStep(f, e.deltaY, ax, ay) ?? f : f));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef]);

  return { size, fit, refit, panBy };
}
