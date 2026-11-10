/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { useViewerStore } from '@/store/index.js';
import { createTransformWheelZoom } from '@/components/viewer/wheelZoom.js';
import {
  drawingWheelNavigation, panDrawing, zoomDrawingAbout, type DrawingViewTransform,
} from '@/lib/drawing/wheel-navigation.js';
import { wheelZoomSensitivityFactor } from '@/lib/navigation/wheel-input.js';

/**
 * Wheel pan and eased wheel zoom for the Drawing panel (#6614, #9507).
 * Reconciles the actual DOM owner after every commit, including pop-out
 * reparenting, so the fine-zoom modifier is read from the window that holds
 * the canvas.
 *
 * `transformRef` is the live transform. Every write here updates it before
 * the state, so the next eased step, and the check that nothing else moved
 * the view meanwhile, read what was written rather than the last render.
 */
export function useDrawingWheelNavigation(
  containerRef: RefObject<HTMLDivElement | null>,
  visible: boolean,
  transformRef: MutableRefObject<DrawingViewTransform>,
  setTransform: (next: DrawingViewTransform) => void,
): void {
  const preset = useViewerStore((s) => s.navigationPreset);
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const binding = useRef<{ container: HTMLDivElement; owner: Window; dispose: () => void } | null>(null);

  useEffect(() => {
    const container = visible ? containerRef.current : null;
    const owner = container?.ownerDocument.defaultView;
    if (binding.current?.container === container && binding.current?.owner === owner) return;
    binding.current?.dispose();
    binding.current = null;
    if (!container || !owner) return;
    const write = (next: DrawingViewTransform) => {
      if (next === transformRef.current) return;
      transformRef.current = next;
      setTransform(next);
    };
    const zoom = createTransformWheelZoom<DrawingViewTransform>({
      get: () => transformRef.current,
      set: write,
      zoomAbout: zoomDrawingAbout,
      rect: () => container.getBoundingClientRect(),
      sensitivity: () => wheelZoomSensitivityFactor(useViewerStore.getState().wheelZoomSensitivity),
      keyTarget: owner,
    });
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const navigation = drawingWheelNavigation(event, container.getBoundingClientRect(), presetRef.current);
      if (!navigation) return;
      if (navigation.panX || navigation.panY) write(panDrawing(transformRef.current, navigation.panX, navigation.panY));
      if (navigation.zoom) zoom.zoom(event);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    binding.current = { container, owner, dispose: () => {
      container.removeEventListener('wheel', onWheel);
      zoom.dispose();
    } };
  });
  useEffect(() => () => {
    binding.current?.dispose();
    binding.current = null;
  }, []);
}
