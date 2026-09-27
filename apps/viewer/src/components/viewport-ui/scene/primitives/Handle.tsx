/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Handle`: a small draggable circle anchored to a world point — the
 * click+drag target pattern used by `SectionPlaneDragGizmo`'s foot dot,
 * generalized (#5486). Ink when passive, accent when active/hovered, per
 * the one-accent rule (§3 of the viewport-ui roadmap).
 */

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import type { Vec3 } from '../types';

export interface HandleProps {
  worldPoint: Vec3 | null;
  /** Accent when true (being dragged / hovered / the thing you're manipulating); ink otherwise. */
  active?: boolean;
  radius?: number;
  title?: string;
  className?: string;
  onPointerDown?: React.PointerEventHandler<SVGCircleElement>;
  onPointerMove?: React.PointerEventHandler<SVGCircleElement>;
  onPointerUp?: React.PointerEventHandler<SVGCircleElement>;
}

export function Handle({
  worldPoint,
  active = false,
  radius = 7,
  title,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: HandleProps) {
  const svgLayer = useSceneLayer('svg');
  const { ref } = useWorldAnchor<SVGGElement>(() => worldPoint);

  if (!svgLayer) return null;

  return createPortal(
    <g ref={ref} style={{ display: 'none' }} data-scene-primitive="handle">
      <circle
        r={radius}
        className={cn(
          'stroke-overlay-halo pointer-events-auto cursor-grab stroke-2',
          active ? 'fill-overlay-accent' : 'fill-overlay-ink',
          className,
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {title ? <title>{title}</title> : null}
      </circle>
    </g>,
    svgLayer,
  );
}
