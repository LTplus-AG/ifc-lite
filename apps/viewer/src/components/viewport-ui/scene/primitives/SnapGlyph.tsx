/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SnapGlyph`: the small glowing marker measure/split/sketch tools draw at
 * an active snap point (endpoint, midpoint, perpendicular, …) — today
 * `MeasurementVisuals`' `#snap-glow` filter plus a hand-drawn shape per
 * snap kind (#5486). Always accent (a snap is always the live, manipulated
 * thing) and always uses the shared glow filter from `OverlayDefs`.
 */

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import { OVERLAY_GLOW_FILTER } from '../OverlayDefs';
import type { Vec3 } from '../types';

export type SnapGlyphKind = 'endpoint' | 'midpoint' | 'center' | 'perpendicular' | 'intersection';

const SIZE = 9;

function shapeFor(kind: SnapGlyphKind) {
  switch (kind) {
    case 'endpoint':
      // Square.
      return <rect x={-SIZE / 2} y={-SIZE / 2} width={SIZE} height={SIZE} />;
    case 'midpoint':
      // Triangle.
      return <polygon points={`0,${-SIZE / 1.6} ${SIZE / 1.6},${SIZE / 2.2} ${-SIZE / 1.6},${SIZE / 2.2}`} />;
    case 'center':
      return <circle r={SIZE / 2} />;
    case 'perpendicular':
      return <rect x={-SIZE / 2} y={-SIZE / 2} width={SIZE} height={SIZE} transform="rotate(45)" />;
    case 'intersection':
    default:
      return <circle r={SIZE / 2.6} />;
  }
}

export interface SnapGlyphProps {
  worldPoint: Vec3 | null;
  kind: SnapGlyphKind;
  className?: string;
}

export function SnapGlyph({ worldPoint, kind, className }: SnapGlyphProps) {
  const svgLayer = useSceneLayer('svg');
  const { ref } = useWorldAnchor<SVGGElement>(() => worldPoint);

  if (!svgLayer) return null;

  return createPortal(
    <g ref={ref} style={{ display: 'none' }} data-scene-primitive="snap-glyph" data-snap-kind={kind}>
      <g
        className={cn('fill-overlay-accent stroke-overlay-halo stroke-1', className)}
        filter={OVERLAY_GLOW_FILTER}
      >
        {shapeFor(kind)}
      </g>
    </g>,
    svgLayer,
  );
}
