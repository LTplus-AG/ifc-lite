/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's SVG layers (charter #6232, M2 §1.5), bottom to top: grid, cut
 * outlines, projection lines, wall axes, selection, hover, the running
 * command (ghost footprint plus its own plan layer) and the snap glyph with
 * its guides. Pure render over workplane-local data and a `Fit`; tokens
 * only, no type palette (the plan is a drafting surface, not a colour view).
 */

import { memo } from 'react';
import { sX, sY, type Fit } from '@/lib/space-sketch-geometry';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import { SnapHudShapes } from '../tools/command/SnapHud';
import type { WallAxis } from '@/lib/snap/sources/semantic';
import type { PlanGrid } from './plan-fit';
import type { PlanCutLine, PlanCutPolygon } from './usePlanCut';

export const toScreen = (fit: Fit, p: Vec2): readonly [number, number] => [sX(fit, p[0]), sY(fit, p[1])];

function ringPath(fit: Fit, ring: readonly Vec2[]): string {
  let d = '';
  for (let i = 0; i < ring.length; i++) d += `${i === 0 ? 'M' : 'L'}${sX(fit, ring[i][0]).toFixed(1)} ${sY(fit, ring[i][1]).toFixed(1)}`;
  return `${d}Z`;
}

/** One SVG path for a polygon with holes (drawn even-odd). */
function polygonPath(fit: Fit, polygon: Pick<PlanCutPolygon, 'outer' | 'holes'>): string {
  return [polygon.outer, ...polygon.holes].map((ring) => ringPath(fit, ring)).join('');
}

export function GridLayer({ grid, width, height }: { grid: PlanGrid | null; width: number; height: number }) {
  if (!grid) return null;
  return (
    <g data-plan-layer="grid" className="stroke-overlay-ink-muted" strokeOpacity={0.14 * grid.opacity} strokeWidth={1}>
      {grid.xs.map((x) => <line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} />)}
      {grid.ys.map((y) => <line key={`y${y}`} x1={0} y1={y} x2={width} y2={y} />)}
    </g>
  );
}

interface CutLayerProps {
  fit: Fit;
  polygons: readonly PlanCutPolygon[];
  lines: readonly PlanCutLine[];
  axes: readonly WallAxis[];
}

/** Cut outlines, projection lines and wall axes: the heavy, rarely changing part. */
export const CutLayer = memo(function CutLayer({ fit, polygons, lines, axes }: CutLayerProps) {
  return (
    <>
      <g data-plan-layer="cut" className="fill-overlay-ink/12 stroke-overlay-ink" strokeWidth={1} fillRule="evenodd">
        {polygons.map((polygon, i) => (
          <path key={i} data-plan-entity={polygon.entityId} d={polygonPath(fit, polygon)} />
        ))}
      </g>
      <g data-plan-layer="projection" className="stroke-overlay-ink-muted" strokeWidth={0.75} fill="none">
        {lines.map((l, i) => (
          <line key={i} x1={sX(fit, l.a[0])} y1={sY(fit, l.a[1])} x2={sX(fit, l.b[0])} y2={sY(fit, l.b[1])} strokeDasharray={l.hidden ? '3 3' : undefined} />
        ))}
      </g>
      <g data-plan-layer="axes" className="stroke-overlay-ink-muted" strokeOpacity={0.7} strokeWidth={1} strokeDasharray="6 4">
        {axes.map((a) => (
          <line key={a.expressId} data-plan-axis={a.expressId} x1={sX(fit, a.a[0])} y1={sY(fit, a.a[1])} x2={sX(fit, a.b[0])} y2={sY(fit, a.b[1])} />
        ))}
      </g>
    </>
  );
});

interface HighlightLayerProps {
  fit: Fit;
  polygons: readonly PlanCutPolygon[];
  selected: ReadonlySet<number>;
  hovered: number | null;
}

/** Selection (accent 2 px over accent-soft) and hover (accent 1 px). */
export function HighlightLayer({ fit, polygons, selected, hovered }: HighlightLayerProps) {
  const picked = polygons.filter((p) => selected.has(p.entityId));
  const hover = hovered !== null && !selected.has(hovered) ? polygons.filter((p) => p.entityId === hovered) : [];
  return (
    <>
      <g data-plan-layer="selection" className="fill-overlay-accent-soft stroke-overlay-accent" strokeWidth={2} fillRule="evenodd">
        {picked.map((polygon, i) => <path key={i} data-plan-selected={polygon.entityId} d={polygonPath(fit, polygon)} />)}
      </g>
      <g data-plan-layer="hover" className="stroke-overlay-accent" fill="none" strokeWidth={1}>
        {hover.map((polygon, i) => <path key={i} d={polygonPath(fit, polygon)} />)}
      </g>
    </>
  );
}

/** The running command's ghost meshes, as footprints on the workplane. */
export function GhostLayer({ fit, footprints }: { fit: Fit; footprints: readonly Vec2[][] }) {
  if (footprints.length === 0) return null;
  return (
    <g data-plan-layer="ghost" className="fill-overlay-accent-soft stroke-overlay-accent" strokeWidth={1} strokeOpacity={0.6} pointerEvents="none">
      {footprints.map((ring, i) => <path key={i} d={ringPath(fit, ring)} />)}
    </g>
  );
}

/** The snap glyph and guides: the 3D snap HUD's own shapes (#6390), painted through the plan's `Fit`. */
export function SnapLayer({ fit, snap }: { fit: Fit; snap: SnapResult | null }) {
  if (!snap) return null;
  return (
    <g data-plan-layer="snap" pointerEvents="none">
      <SnapHudShapes snap={snap} screen={(p) => ({ x: sX(fit, p[0]), y: sY(fit, p[1]) })} />
    </g>
  );
}
