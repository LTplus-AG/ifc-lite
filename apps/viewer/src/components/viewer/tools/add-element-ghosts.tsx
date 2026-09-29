/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The about-to-commit ghosts the Add Element overlay draws, split out of
 * `AddElementOverlay.tsx`. Every point they receive is already on the
 * workplane (`projectOntoWorkplane`), so each ghost is the commit's own box:
 * a flat prism on the storey floor for linear elements, an axis box at the
 * floor (or at the sill, for a window) for single-click elements (#6233).
 */

import { useViewerStore } from '@/store';
import type { AddElementVec3 } from '@/store/slices/addElementSlice';

export type Pt = { x: number; y: number };
export type Project = (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null;

const STROKE = 'stroke-overlay-accent';
const FILL = 'fill-overlay-accent-soft';
export const GHOST_OPACITY = 0.5;

/** Project renderer-frame corners and outline their screen silhouette. */
export function ghostOutline(corners: Array<[number, number, number]>, projection: Project): string | null {
  if (corners.length === 0) return null;
  const projected = corners.map((c) => projection({ x: c[0], y: c[1], z: c[2] }));
  return projected.every((p): p is Pt => p !== null) ? projectedHullOutline(projected) : null;
}

/** The dashed silhouette every ghost is drawn with. */
export function GhostPolygon({ points }: { points: string }) {
  return (
    <polygon
      points={points}
      className={`${FILL} ${STROKE}`}
      strokeOpacity={GHOST_OPACITY}
      strokeWidth={1}
      strokeDasharray="3,3"
    />
  );
}

/**
 * Single-click ghost for column / door / window — the axis box the commit
 * builds, centred on the workplane point. A window's box starts at its sill.
 */
export function SingleClickGhost({
  type,
  hoverWorld,
  projection,
}: {
  type: 'column' | 'door' | 'window';
  hoverWorld: AddElementVec3;
  projection: Project;
}) {
  const state = useViewerStore.getState();
  let sx: number, sy: number, sz: number, base = 0;
  if (type === 'column') {
    const p = state.addElementColumnParams;
    sx = p.Width; sy = p.Depth; sz = p.Height;
  } else if (type === 'door') {
    const p = state.addElementDoorParams;
    sx = p.Width; sy = p.FrameThickness; sz = p.Height;
  } else {
    const p = state.addElementWindowParams;
    sx = p.Width; sy = p.FrameThickness; sz = p.Height; base = p.SillHeight;
  }
  const hx = sx / 2;
  const hz = sy / 2; // renderer Z
  const { x: cx, z: cz } = hoverWorld;
  const y0 = hoverWorld.y + base;
  const y1 = y0 + sz;
  const outline = ghostOutline([
    [cx - hx, y0, cz - hz], [cx + hx, y0, cz - hz], [cx + hx, y0, cz + hz], [cx - hx, y0, cz + hz],
    [cx - hx, y1, cz - hz], [cx + hx, y1, cz - hz], [cx + hx, y1, cz + hz], [cx - hx, y1, cz + hz],
  ], projection);
  return outline ? <GhostPolygon points={outline} /> : null;
}

/**
 * Eight renderer-frame corners of a thickness-extruded segment (wall / beam /
 * member) standing on the workplane at `startWorld.y`. Both endpoints are on
 * the same workplane, so the prism is flat — the tool never commits a slope.
 */
export function linearBoxCorners(
  startWorld: AddElementVec3,
  endWorld: AddElementVec3,
  thickness: number,
  height: number,
): Array<[number, number, number]> {
  const dx = endWorld.x - startWorld.x;
  const dz = endWorld.z - startWorld.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return [];
  // Perpendicular in the ground plane (renderer X/Z, Y is up).
  const nx = -dz / len * (thickness / 2), nz = dx / len * (thickness / 2);
  const base = startWorld.y, top = base + height;
  const ring = (y: number): Array<[number, number, number]> => [
    [startWorld.x + nx, y, startWorld.z + nz],
    [endWorld.x + nx, y, endWorld.z + nz],
    [endWorld.x - nx, y, endWorld.z - nz],
    [startWorld.x - nx, y, startWorld.z - nz],
  ];
  return [...ring(base), ...ring(top)];
}

/**
 * Vertical drop line from the snapped 3D point (a slab top, a wall face) to
 * where the element actually lands on the workplane, with a marker at the
 * landing point — so a snap off the plane never reads as "it goes there".
 */
export function WorkplaneDropLine({
  from,
  to,
  projection,
}: {
  from: AddElementVec3;
  to: AddElementVec3;
  projection: Project;
}) {
  const a = projection(from);
  const b = projection(to);
  if (!a || !b) return null;
  return (
    <g data-testid="add-element-drop-line">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={STROKE} strokeOpacity={GHOST_OPACITY} strokeWidth={1.5} strokeDasharray="2,3" />
      <circle cx={a.x} cy={a.y} r={2.5} className={`fill-overlay-halo ${STROKE}`} strokeOpacity={GHOST_OPACITY} strokeWidth={1} />
      <circle cx={b.x} cy={b.y} r={3.5} className={`fill-overlay-halo ${STROKE}`} strokeWidth={1.5} />
    </g>
  );
}

/**
 * 2D convex hull of projected screen points → SVG polygon string.
 * The 8 box corners projected to screen don't always trace a clean
 * outline edge-by-edge (back faces overlap), so we just render the
 * silhouette envelope. Andrew's monotone-chain on (x, y).
 */
function projectedHullOutline(pts: Pt[]): string {
  if (pts.length < 3) return pts.map((p) => `${p.x},${p.y}`).join(' ');
  const sorted = [...pts].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper].map((p) => `${p.x},${p.y}`).join(' ');
}
