/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { projectToCssScreen } from '@/utils/projectScreen.js';
import { orbitPivotStore } from './orbitPivotStore.js';

/** A fixed world point, projected each frame while a mouse orbit is held (#5891). */
export function OrbitPivotMarker() {
  const pivot = useSyncExternalStore(orbitPivotStore.subscribe, orbitPivotStore.getSnapshot);
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pivot) return;
    let frame = 0;
    const project = () => {
      const marker = markerRef.current;
      if (!marker) return;
      const position = projectToCssScreen(pivot.camera, pivot.canvas, pivot.point);
      marker.style.visibility = position ? 'visible' : 'hidden';
      if (position) {
        marker.style.left = `${position.x}px`;
        marker.style.top = `${position.y}px`;
      }
      frame = requestAnimationFrame(project);
    };
    project();
    return () => cancelAnimationFrame(frame);
  }, [pivot]);

  return (
    <div
      ref={markerRef}
      data-orbit-pivot-marker
      aria-hidden="true"
      className={`pointer-events-none absolute z-40 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-overlay-accent bg-overlay-accent-soft shadow-sm transition-opacity duration-150 ${pivot ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}
