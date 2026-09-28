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

export type SnapGlyphKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'perpendicular'
  | 'intersection'
  | 'edge'
  | 'extension'
  | 'parallel'
  | 'grid';

const SIZE = 9;
const H = SIZE / 2;

/**
 * A line-drawn glyph (X, ⟂, …): a halo stroke under an accent stroke, so it
 * reads on any background the way the filled glyphs' halo outline does.
 */
function stroked(d: string) {
  return (
    <>
      <path d={d} className="fill-none stroke-overlay-halo" strokeWidth={4} strokeLinecap="round" />
      <path d={d} className="fill-none stroke-overlay-accent" strokeWidth={2} strokeLinecap="round" />
    </>
  );
}

function shapeFor(kind: SnapGlyphKind) {
  switch (kind) {
    case 'endpoint':
      // Square.
      return <rect x={-H} y={-H} width={SIZE} height={SIZE} />;
    case 'midpoint':
      // Triangle.
      return <polygon points={`0,${-SIZE / 1.6} ${SIZE / 1.6},${SIZE / 2.2} ${-SIZE / 1.6},${SIZE / 2.2}`} />;
    case 'center':
      return <circle r={H} />;
    case 'perpendicular':
      // ⟂: an upright on a base line.
      return stroked(`M${-H} ${H} H${H} M0 ${H} V${-H}`);
    case 'intersection':
      // X.
      return stroked(`M${-H} ${-H} L${H} ${H} M${H} ${-H} L${-H} ${H}`);
    case 'edge':
      // Hourglass: "on this edge", the classic nearest-point marker.
      return <polygon points={`${-H},${-H} ${H},${-H} ${-H},${H} ${H},${H}`} />;
    case 'extension':
      // A small ring on the dashed extension guide.
      return (
        <>
          <circle r={H * 0.75} className="fill-none stroke-overlay-halo" strokeWidth={4} />
          <circle r={H * 0.75} className="fill-none stroke-overlay-accent" strokeWidth={2} />
        </>
      );
    case 'parallel':
      // //: two slanted strokes.
      return stroked(`M${-H} ${H} L${-H * 0.1} ${-H} M${H * 0.1} ${H} L${H} ${-H}`);
    case 'grid':
    default:
      // A dot, deliberately the smallest mark: the grid is the weakest snap.
      return <circle r={2.5} />;
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
      <SnapGlyphShape kind={kind} className={className} />
    </g>,
    svgLayer,
  );
}

/**
 * The glyph's drawing alone, centred on the origin, for a caller that owns
 * its own SVG and projection (and so its stacking over other overlays).
 */
export function SnapGlyphShape({ kind, className }: { kind: SnapGlyphKind; className?: string }) {
  return (
    <g className={cn('fill-overlay-accent stroke-overlay-halo stroke-1', className)} filter={OVERLAY_GLOW_FILTER}>
      {shapeFor(kind)}
    </g>
  );
}
