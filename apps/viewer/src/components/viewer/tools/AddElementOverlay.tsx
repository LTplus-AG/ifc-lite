/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live 3D placement preview for the Add Element tool
 * (`TOOL_HUD.addElement.Scene`, #5503).
 *
 * Renders SVG lines / rectangles / polygons over the canvas, anchored
 * to renderer-frame world coords pulled from the addElement slice
 * (`pendingPoints` + `hoverPoint`). Each point is projected to screen
 * via the camera's `projectToScreen` callback so the preview tracks
 * the camera in real time. The length / width / depth / area readouts
 * are scene-kernel `WorldLabel`s anchored on world midpoints, so they
 * share the one card surface and ink every other on-screen number uses,
 * and the strokes use the overlay tokens (one accent, no per-tool hue).
 *
 * What it draws (per element type):
 *   - column: nothing (single click — snap dot is enough)
 *   - wall:   first click → marker; on hover → marker → cursor + length
 *   - beam:   identical to wall
 *   - slab rectangle: first click → corner marker; on hover → axis-
 *     aligned rectangle with the diagonal, plus W/D readouts
 *   - slab polygon: pending edges + closing-edge ghost back to start
 *     when ≥3 points exist (so the user can preview the close)
 *
 * On the shared scene-overlay kernel (#5486/#5512, charter #5478): mounted
 * inside `ToolOverlays`' `<SceneOverlayRoot>`. `useProjectorTick`
 * re-renders this component off the ONE shared `SceneProjector` dirty tick
 * instead of running its own unconditional `requestAnimationFrame` poll.
 */

import React, { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import type { AddElementVec3 } from '@/store/slices/addElementSlice';
import { OVERLAY_GLOW_FILTER, WorldLabel, useProjectorTick } from '../../viewport-ui/scene';
import { formatDistance } from './formatDistance';
import { formatArea } from './computePolygonArea';

type Pt = { x: number; y: number };
type Project = (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null;

// The one interaction accent (overlay tokens, #5483): the live stroke is
// `accent`, fills are `accent-soft`, the about-to-commit ghost box is the
// accent at half strength.
const STROKE = 'stroke-overlay-accent';
const FILL = 'fill-overlay-accent-soft';
const GHOST_OPACITY = 0.5;

export function AddElementOverlay() {
  const activeTool = useViewerStore((s) => s.activeTool);
  const type = useViewerStore((s) => s.addElementType);
  const slabMode = useViewerStore((s) => s.addElementSlabMode);
  const pendingPoints = useViewerStore((s) => s.addElementPendingPoints);
  const hoverPoint = useViewerStore((s) => s.addElementHoverPoint);
  const autoSpacePreview = useViewerStore((s) => s.addElementAutoSpacePreview);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const { models, ifcDataStore } = useIfc();
  const addElementModelId = useViewerStore((s) => s.addElementModelId);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);

  // Camera realtime updates intentionally bypass React renders for
  // performance (see `updateCameraRotationRealtime`), so we need a tick to
  // re-project pending + hover points on camera motion. Sourced from the
  // ONE shared `SceneProjector` dirty tick (`useProjectorTick`)
  // instead of a private `requestAnimationFrame` poll: it already skips
  // work while idle (static camera) and while there's nothing to project
  // — `hasOverlayContent` below gates registration the same way the old
  // loop gated itself.
  const hasOverlayContent =
    pendingPoints.length > 0 ||
    hoverPoint !== null ||
    (autoSpacePreview != null && autoSpacePreview.outlines.length > 0);
  const frameTick = useProjectorTick(activeTool === 'addElement' && hasOverlayContent);

  const projection = useMemo(
    () => makeProjection(projectToScreen),
    // Re-creating the memoized projection on every tick is wasted —
    // the underlying function reference rarely changes. We only depend on
    // `projectToScreen` itself; the shared-projector frame tick below
    // triggers the re-render that calls the projection again with current
    // camera.
    [projectToScreen],
  );

  // Reading frameTick keeps React from optimizing the render away.
  void frameTick;

  if (activeTool !== 'addElement') return null;
  if (!projection) return null;

  // Resolve storey elevation for the auto-space preview projection.
  // IFC Z (storey elevation) maps directly to renderer Y (Y-up).
  let storeyElevation = 0;
  if (autoSpacePreview) {
    const effectiveModelId = addElementModelId ?? activeModelId ?? null;
    const ds = effectiveModelId
      ? models.get(effectiveModelId)?.ifcDataStore ?? ifcDataStore
      : ifcDataStore;
    const elev = ds?.spatialHierarchy?.storeyElevations?.get(autoSpacePreview.storeyExpressId);
    if (typeof elev === 'number' && Number.isFinite(elev)) storeyElevation = elev;
  }
  const ifcToWorld = (xy: [number, number]): AddElementVec3 => ({ x: xy[0], y: storeyElevation, z: -xy[1] });
  const ifcToRenderer = (xy: [number, number]) => projection(ifcToWorld(xy));

  const screenPending = pendingPoints
    .map(projection)
    .filter((p): p is Pt => p !== null);
  const hover = hoverPoint ? projection(hoverPoint) : null;
  const hasPreview = !!autoSpacePreview && autoSpacePreview.outlines.length > 0;

  if (screenPending.length === 0 && !hover && !hasPreview) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-(--z-scene)"
      style={{ overflow: 'visible' }}
    >

      {/* Hover-ghost for single-click placements — column/door/window. */}
      {(type === 'column' || type === 'door' || type === 'window') && hoverPoint && (
        <SingleClickGhost
          type={type}
          hoverWorld={hoverPoint}
          projection={projection}
        />
      )}

      {/* Two-click axial placements share the same start→end preview. */}
      {type === 'wall' || type === 'beam' || type === 'member' ? (
        <WallBeamPreview
          pending={screenPending}
          hover={hover}
          pendingWorld={pendingPoints}
          hoverWorld={hoverPoint}
          projection={projection}
          unitDisplayOverrides={unitDisplayOverrides}
        />
      ) : null}

      {/* Rectangle profile (slab / roof / plate / space) — flat rect on storey floor. */}
      {(type === 'slab' || type === 'roof' || type === 'plate' || type === 'space') && slabMode === 'rectangle' ? (
        <SlabRectanglePreview
          pending={screenPending}
          hover={hover}
          pendingWorld={pendingPoints}
          hoverWorld={hoverPoint}
          projection={projection}
          unitDisplayOverrides={unitDisplayOverrides}
        />
      ) : null}

      {/* Polygon profile (same set of types) — pending polyline + ghost close. */}
      {(type === 'slab' || type === 'roof' || type === 'plate' || type === 'space') && slabMode === 'polygon' ? (
        <SlabPolygonPreview pending={screenPending} hover={hover} />
      ) : null}

      {/* Pending point markers — drawn on top so they're always visible. */}
      {screenPending.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4.5} className={`fill-overlay-halo ${STROKE}`} strokeWidth={2} />
      ))}

      {/* Auto-space preview: candidate outlines from the wall-graph
          face finder. Distinct from the click-to-place preview to
          avoid confusion when both are active. */}
      {hasPreview && autoSpacePreview!.outlines.map((outline, idx) => {
        const pts: Pt[] = [];
        for (const xy of outline) {
          const sp = ifcToRenderer(xy);
          if (sp) pts.push(sp);
        }
        if (pts.length < 3) return null;
        const polygon = pts.map((p) => `${p.x},${p.y}`).join(' ');
        const cx = outline.reduce((s, xy) => s + xy[0], 0) / outline.length;
        const cy = outline.reduce((s, xy) => s + xy[1], 0) / outline.length;
        const region = autoSpacePreview!.regions[idx];
        return (
          <g key={`auto-${idx}`}>
            <polygon
              points={polygon}
              className={`${FILL} ${STROKE}`}
              strokeWidth={1.5}
              strokeDasharray="4,3"
            />
            {region && (
              <WorldLabel worldPoint={ifcToWorld([cx, cy])} offset={{ dx: -20, dy: -10 }}>
                {formatArea(region.area)}
              </WorldLabel>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Per-type preview components                                         */
/* ------------------------------------------------------------------ */

function WallBeamPreview({
  pending,
  hover,
  pendingWorld,
  hoverWorld,
  projection,
  unitDisplayOverrides,
}: {
  pending: Pt[];
  hover: Pt | null;
  pendingWorld: AddElementVec3[];
  hoverWorld: AddElementVec3 | null;
  projection: Project;
  unitDisplayOverrides: Record<string, string>;
}) {
  if (pending.length === 0 || !hover) return null;
  const start = pending[0];
  const startWorld = pendingWorld[0];
  const length = hoverWorld ? worldDistance2D(startWorld, hoverWorld) : 0;

  // 3D ghost box — read the per-type params from the store so the
  // outline matches the about-to-commit element's actual size.
  const ghost = useViewerStore.getState();
  const type = ghost.addElementType;
  const thick = type === 'wall'
    ? ghost.addElementWallParams.Thickness
    : type === 'beam'
      ? ghost.addElementBeamParams.Width
      : ghost.addElementMemberParams.Width;
  const height = type === 'wall'
    ? ghost.addElementWallParams.Height
    : type === 'beam'
      ? ghost.addElementBeamParams.Height
      : ghost.addElementMemberParams.Height;

  let ghostOutline: string | null = null;
  if (hoverWorld) {
    const corners = linearBoxCorners(startWorld, hoverWorld, thick, height);
    const projected = corners.map((c) => projection({ x: c[0], y: c[1], z: c[2] }));
    if (projected.every((p): p is Pt => p !== null)) {
      ghostOutline = projectedHullOutline(projected as Pt[]);
    }
  }

  return (
    <>
      {ghostOutline && (
        <polygon
          points={ghostOutline}
          className={`${FILL} ${STROKE}`}
          strokeOpacity={GHOST_OPACITY}
          strokeWidth={1}
          strokeDasharray="3,3"
        />
      )}
      <line
        x1={start.x}
        y1={start.y}
        x2={hover.x}
        y2={hover.y}
        className={STROKE}
        strokeWidth={2}
        strokeDasharray="6,4"
        filter={OVERLAY_GLOW_FILTER}
      />
      {length > 0.001 && hoverWorld && (
        <WorldLabel worldPoint={midWorld(startWorld, hoverWorld)} active>
          {formatDistance(length, unitDisplayOverrides)}
        </WorldLabel>
      )}
    </>
  );
}

/**
 * Single-click ghost for column / door / window — projects the
 * about-to-commit axis box at the cursor so the user sees where
 * the leaf / cross-section actually lands before clicking.
 */
function SingleClickGhost({
  type,
  hoverWorld,
  projection,
}: {
  type: 'column' | 'door' | 'window';
  hoverWorld: AddElementVec3;
  projection: Project;
}) {
  const state = useViewerStore.getState();
  let sx: number, sy: number, sz: number;
  if (type === 'column') {
    const p = state.addElementColumnParams;
    sx = p.Width; sy = p.Depth; sz = p.Height;
  } else if (type === 'door') {
    const p = state.addElementDoorParams;
    sx = p.Width; sy = p.FrameThickness; sz = p.Height;
  } else {
    const p = state.addElementWindowParams;
    sx = p.Width; sy = p.FrameThickness; sz = p.Height;
  }
  // Hover is in renderer-frame; project the axis-aligned box around it.
  const hx = sx / 2;
  const hz = sy / 2; // renderer Z
  const cy = hoverWorld.y;
  const cx = hoverWorld.x;
  const cz = hoverWorld.z;
  const corners: Array<[number, number, number]> = [
    [cx - hx, cy,        cz - hz],
    [cx + hx, cy,        cz - hz],
    [cx + hx, cy,        cz + hz],
    [cx - hx, cy,        cz + hz],
    [cx - hx, cy + sz,   cz - hz],
    [cx + hx, cy + sz,   cz - hz],
    [cx + hx, cy + sz,   cz + hz],
    [cx - hx, cy + sz,   cz + hz],
  ];
  const projected = corners.map((c) => projection({ x: c[0], y: c[1], z: c[2] }));
  if (!projected.every((p): p is Pt => p !== null)) return null;
  const outline = projectedHullOutline(projected as Pt[]);
  return (
    <polygon
      points={outline}
      className={`${FILL} ${STROKE}`}
      strokeOpacity={GHOST_OPACITY}
      strokeWidth={1}
      strokeDasharray="3,3"
    />
  );
}

/**
 * Eight renderer-frame corners of a thickness-extruded segment
 * (wall / beam / member). Bottom and top rings each track their
 * endpoint's Y so a sloped beam previews as a sloped prism instead of
 * being flattened to the start elevation.
 */
function linearBoxCorners(
  startWorld: AddElementVec3,
  endWorld: AddElementVec3,
  thickness: number,
  height: number,
): Array<[number, number, number]> {
  const dx = endWorld.x - startWorld.x;
  const dz = endWorld.z - startWorld.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return [];
  const ax = dx / len, az = dz / len;
  // Perpendicular in the ground plane (renderer X/Z, Y is up).
  const nx = -az, nz = ax;
  const half = thickness / 2;
  const startBaseY = startWorld.y;
  const endBaseY = endWorld.y;
  const startTopY = startBaseY + height;
  const endTopY = endBaseY + height;
  return [
    [startWorld.x + nx * half, startBaseY, startWorld.z + nz * half],
    [endWorld.x   + nx * half, endBaseY,   endWorld.z   + nz * half],
    [endWorld.x   - nx * half, endBaseY,   endWorld.z   - nz * half],
    [startWorld.x - nx * half, startBaseY, startWorld.z - nz * half],
    [startWorld.x + nx * half, startTopY,  startWorld.z + nz * half],
    [endWorld.x   + nx * half, endTopY,    endWorld.z   + nz * half],
    [endWorld.x   - nx * half, endTopY,    endWorld.z   - nz * half],
    [startWorld.x - nx * half, startTopY,  startWorld.z - nz * half],
  ];
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

function SlabRectanglePreview({
  pending,
  hover,
  pendingWorld,
  hoverWorld,
  projection,
  unitDisplayOverrides,
}: {
  pending: Pt[];
  hover: Pt | null;
  pendingWorld: AddElementVec3[];
  hoverWorld: AddElementVec3 | null;
  projection: Project;
  unitDisplayOverrides: Record<string, string>;
}) {
  if (pending.length === 0 || !hover || !pendingWorld[0] || !hoverWorld) return null;
  // Build the four world-space corners on the storey floor (renderer
  // Y is the world up axis, so rectangle corners share Y with the
  // first click — gives a flat axis-aligned outline regardless of the
  // hover point's height).
  const a = pendingWorld[0];
  const b = hoverWorld;
  const y = a.y;
  const cornersWorld: AddElementVec3[] = [
    { x: a.x, y, z: a.z },
    { x: b.x, y, z: a.z },
    { x: b.x, y, z: b.z },
    { x: a.x, y, z: b.z },
  ];
  const cornersScreen = cornersWorld.map(projection).filter((p): p is Pt => p !== null);
  if (cornersScreen.length !== 4) return null;
  const points = cornersScreen.map((p) => `${p.x},${p.y}`).join(' ');

  // Width and Depth in IFC X/Y (renderer X / -Z).
  const width = Math.abs(b.x - a.x);
  const depth = Math.abs(b.z - a.z); // renderer Z magnitude maps to IFC Y magnitude

  return (
    <>
      <polygon points={points} className={`${FILL} ${STROKE}`} strokeWidth={2} strokeDasharray="6,4" />
      {width > 0.001 && (
        <WorldLabel worldPoint={midWorld(cornersWorld[0], cornersWorld[1])} active>
          {formatDistance(width, unitDisplayOverrides)}
        </WorldLabel>
      )}
      {depth > 0.001 && (
        <WorldLabel worldPoint={midWorld(cornersWorld[1], cornersWorld[2])} active>
          {formatDistance(depth, unitDisplayOverrides)}
        </WorldLabel>
      )}
    </>
  );
}

function SlabPolygonPreview({ pending, hover }: { pending: Pt[]; hover: Pt | null }) {
  if (pending.length === 0) return null;
  const liveEnd = hover ?? pending[pending.length - 1];
  const path = pending.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <>
      {/* Solid path through committed points. */}
      <polyline
        points={path}
        fill="none"
        className={STROKE}
        strokeWidth={2}
        filter={OVERLAY_GLOW_FILTER}
      />
      {/* Pending edge from last committed point to cursor. */}
      {hover && (
        <line
          x1={pending[pending.length - 1].x}
          y1={pending[pending.length - 1].y}
          x2={liveEnd.x}
          y2={liveEnd.y}
          className={STROKE}
          strokeWidth={2}
          strokeDasharray="6,4"
        />
      )}
      {/* Closing-edge ghost when ≥ 3 points exist so the user previews how the polygon closes. */}
      {pending.length >= 3 && hover && (
        <line
          x1={liveEnd.x}
          y1={liveEnd.y}
          x2={pending[0].x}
          y2={pending[0].y}
          className={STROKE}
          strokeOpacity={GHOST_OPACITY}
          strokeWidth={1.5}
          strokeDasharray="3,4"
        />
      )}
      {pending.length >= 3 && !hover && (
        <line
          x1={pending[pending.length - 1].x}
          y1={pending[pending.length - 1].y}
          x2={pending[0].x}
          y2={pending[0].y}
          className={STROKE}
          strokeOpacity={GHOST_OPACITY}
          strokeWidth={1.5}
          strokeDasharray="3,4"
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeProjection(projectToScreen: Project | undefined): Project | null {
  if (!projectToScreen) return null;
  return projectToScreen;
}

function worldDistance2D(a: AddElementVec3, b: AddElementVec3): number {
  // Renderer Y is the world up axis; the storey floor sits in the X/Z
  // plane, so length is a 2D distance in renderer X/Z.
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.hypot(dx, dz);
}

function midWorld(a: AddElementVec3, b: AddElementVec3): AddElementVec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
