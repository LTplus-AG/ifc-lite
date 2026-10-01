/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useViewerStore } from '@/store/index.js';
import { createFineZoomModifierTracker, isFineZoomWheel } from '@/components/viewer/wheelZoom.js';
import { drawingWheelTransform, type DrawingViewTransform } from '@/lib/drawing/wheel-navigation.js';

/** Reconcile the actual DOM owner after every commit, including pop-out reparenting. */
export function useDrawingWheelNavigation(
  containerRef: RefObject<HTMLDivElement | null>,
  visible: boolean,
  setTransform: Dispatch<SetStateAction<DrawingViewTransform>>,
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
    const modifier = createFineZoomModifierTracker(owner);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = container.getBoundingClientRect();
      const fine = isFineZoomWheel(event, modifier.isHeld());
      setTransform((previous) => drawingWheelTransform(previous, event, rect, presetRef.current, fine));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    binding.current = { container, owner, dispose: () => {
      container.removeEventListener('wheel', onWheel);
      modifier.dispose();
    } };
  });
  useEffect(() => () => {
    binding.current?.dispose();
    binding.current = null;
  }, []);
}
