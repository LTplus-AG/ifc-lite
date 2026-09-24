/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PlaneOutline`: a filled, edge-stroked polygon from N world-space
 * corners — the section plane's rectangle, a pick-preview quad, a zone
 * footprint. `accent-soft` fill with a 1px `accent` edge, identical for
 * every axis (§6 of the roadmap: no more per-axis Material hues).
 *
 * Registers one projector anchor per corner (same "independent anchors,
 * shared recompute" shape as `AxisArrow`) and rebuilds the `<polygon>`
 * `points` attribute whenever any corner's projection changes. Hides the
 * whole outline if ANY corner is currently unprojectable — a partially
 * off/behind-camera plane reads as noise, not as a plane.
 */

import { createPortal } from 'react-dom';
import { useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useSceneProjector } from '../SceneProjectorProvider';
import { isAnchorVisible, vec3Key } from '../projection';
import { useWakeOnChange } from '../useWakeOnChange';
import type { AnchorProjection, Vec3 } from '../types';

export interface PlaneOutlineProps {
  /** World-space corners, in winding order. Needs at least 3 to draw anything. */
  corners: Vec3[];
  className?: string;
}

export function PlaneOutline({ corners, className }: PlaneOutlineProps) {
  const svgLayer = useSceneLayer('svg');
  const projector = useSceneProjector();
  const polygonRef = useRef<SVGPolygonElement | null>(null);
  const projections = useRef<Array<AnchorProjection | null>>([]);
  const baseId = useId();

  const latest = useRef(corners);
  latest.current = corners;

  useEffect(() => {
    if (!projector) return;
    projections.current = corners.map(() => null);

    const apply = () => {
      const polygon = polygonRef.current;
      if (!polygon) return;
      const points = projections.current;
      const allVisible = points.length >= 3 && points.every(isAnchorVisible);
      if (!allVisible) {
        polygon.style.display = 'none';
        return;
      }
      polygon.style.display = '';
      polygon.setAttribute('points', points.map((p) => `${p!.screen!.x},${p!.screen!.y}`).join(' '));
    };

    const unregisters = corners.map((_corner, index) =>
      projector.registerAnchor(
        `${baseId}-${index}`,
        () => latest.current[index] ?? null,
        (projection) => {
          projections.current[index] = projection;
          apply();
        },
      ),
    );

    return () => {
      for (const unregister of unregisters) unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projector, baseId, corners.length]);

  // `corners.length` above only re-registers anchors when the CORNER COUNT
  // changes; the registered getters already read `latest.current` fresh, so
  // a coordinate move is picked up on the next dirty tick — but with a
  // static camera nothing schedules that next tick (#5636 review, same
  // class as `useWorldAnchor`'s). Combining every corner's `vec3Key` into
  // one dependency wakes the projector on an actual coordinate change, not
  // just on array-identity or length changes.
  useWakeOnChange(projector, corners.map(vec3Key).join('|'));

  if (!svgLayer) return null;

  return createPortal(
    <polygon
      ref={polygonRef}
      style={{ display: 'none' }}
      data-scene-primitive="plane-outline"
      className={cn('fill-overlay-accent-soft stroke-overlay-accent stroke-1', className)}
    />,
    svgLayer,
  );
}
