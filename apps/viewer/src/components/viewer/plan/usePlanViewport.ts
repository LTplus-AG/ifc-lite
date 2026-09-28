/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's viewport (charter #6232, M2 §1.5): its measured size, the
 * `Fit` (screen ↔ workplane-local), wheel zoom about the cursor and drag
 * pan. Zoom goes through Space Sketch's `zoomStep`, so the plan refuses the
 * same out-of-range zoom the sketch does instead of drifting.
 *
 * The plan frames itself once per storey, as soon as its cut has settled
 * (it arrives after a debounce); after that the view stays put through
 * edits (a first wall on an empty storey must not make the plan jump) until
 * Fit or a storey change.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Fit } from '@/lib/space-sketch-geometry';
import { zoomStep } from '../tools/space-sketch/space-viewport';

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

  // Frame once per storey, when its content is ready.
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0 || !ready || framed.current === frameKey) return;
    framed.current = frameKey;
    setFit(frameRef.current(size.width, size.height));
  }, [frameKey, ready, size.width, size.height]);

  const refit = useCallback(() => {
    if (size.width > 0 && size.height > 0) setFit(frameRef.current(size.width, size.height));
  }, [size.width, size.height]);

  const panBy = useCallback((dx: number, dy: number) => {
    setFit((f) => (f ? { ...f, offX: f.offX + dx, offY: f.offY + dy } : f));
  }, []);

  // Wheel zoom about the cursor; non-passive so the page never scrolls instead.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const ax = e.clientX - rect.left, ay = e.clientY - rect.top;
      setFit((f) => (f ? zoomStep(f, e.deltaY, ax, ay) ?? f : f));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef]);

  return { size, fit, refit, panBy };
}
