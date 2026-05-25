/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live SVG preview for the Split tool. Mounted by `ToolOverlays`
 * while `activeTool === 'split'`. Branches by element type:
 *
 *   Wall / beam / column / member  (single-click):
 *     Perpendicular guide line through the projected cut point,
 *     "distance / length" readout. State driven by
 *     `splitHoverPoint` / `splitHoverAxisDirection` /
 *     `splitHoverDistance` / `splitHoverLength`.
 *
 *   Slab / roof / plate / space  (two-click):
 *     Outline the polygon footprint with a faint purple stroke.
 *     Before the first click: hint chip says "click to start cut".
 *     After the first click: ghost line from anchor → cursor,
 *     drawn straight through the polygon (the actual extent is
 *     clamped by polygon-clip at commit).
 *
 * Same camera-tracking RAF trick the GizmoOverlay uses, so the
 * preview tracks the element through orbit / zoom without
 * re-rendering on every camera frame.
 */

import { useViewerStore } from '@/store';
import { useCameraTickSubscription } from '@/hooks/useCameraTickSubscription';
import { Slice as KnifeIcon } from 'lucide-react';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;

const GUIDE_COLOR = '#a855f7'; // purple-500 — matches edit-mode pill
const GUIDE_HALF_LENGTH_PX = 30;

/** Storey-local 2D → renderer Y-up world point at the storey floor. */
function ifc2dToRendererWorld(p: [number, number], storeyElevation: number): Vec3 {
  return { x: p[0], y: storeyElevation, z: -p[1] };
}

export function SplitOverlay() {
  const activeTool = useViewerStore((s) => s.activeTool);
  const splitMode = useViewerStore((s) => s.splitMode);
  const splitHoverPoint = useViewerStore((s) => s.splitHoverPoint);
  const splitHoverDistance = useViewerStore((s) => s.splitHoverDistance);
  const splitHoverLength = useViewerStore((s) => s.splitHoverLength);
  const splitHoverCutPoint = useViewerStore((s) => s.splitHoverCutPoint);
  const splitHoverAxisDirection = useViewerStore((s) => s.splitHoverAxisDirection);
  const splitTargetModelId = useViewerStore((s) => s.splitTargetModelId);
  const splitTargetExpressId = useViewerStore((s) => s.splitTargetExpressId);
  const slabCutAnchor = useViewerStore((s) => s.slabCutAnchor);
  const slabCutFootprint = useViewerStore((s) => s.slabCutFootprint);
  const slabCutStoreyElevation = useViewerStore((s) => s.slabCutStoreyElevation);
  const readSlabFootprint = useViewerStore((s) => s.readSlabFootprint);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);

  // Camera-tick subscription — wakes the overlay when the camera
  // moves so the preview tracks the element through orbit / zoom.
  // Skipped when nothing is hovered (idle Split tool with no cursor
  // over an element is free of per-frame work).
  const active =
    activeTool === 'split' &&
    (splitMode === 'aiming' || splitMode === 'first-anchor') &&
    splitHoverPoint !== null;
  void useCameraTickSubscription(getViewpoint, active);

  // Hint chip when idle (tool armed, nothing under cursor).
  if (activeTool === 'split' && !active) {
    return (
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none z-30
          flex items-center gap-2 px-3 py-1.5 rounded-full
          bg-purple-600/95 text-white text-xs shadow-lg"
        role="status"
      >
        <KnifeIcon className="h-3.5 w-3.5" />
        <span>Move the cursor to set the cut point on the selected element — Esc to exit</span>
      </div>
    );
  }
  if (!active || !projectToScreen) return null;

  const project = projectToScreen as Project;

  // Branch: slab two-click flow vs single-click linear/wall flow.
  // The discriminator is whether we have a slab footprint cached
  // (first-anchor or fresh hover); if not, fall through to the
  // single-click rendering.
  const slabFootprint = slabCutFootprint
    ?? (splitTargetModelId !== null && splitTargetExpressId !== null
        ? readSlabFootprint(splitTargetModelId, splitTargetExpressId)?.footprint ?? null
        : null);
  const storeyElevation = slabCutStoreyElevation
    ?? (splitTargetModelId !== null && splitTargetExpressId !== null
        ? readSlabFootprint(splitTargetModelId, splitTargetExpressId)?.storeyElevation ?? 0
        : 0);

  if (slabFootprint) {
    // Slab path. Project every footprint vertex; build a polygon.
    const screenVerts = slabFootprint
      .map((p) => project(ifc2dToRendererWorld(p, storeyElevation)))
      .filter((v): v is Vec2 => v !== null);
    if (screenVerts.length < 3) return null;
    const path = screenVerts.map((v, i) => `${i === 0 ? 'M' : 'L'}${v.x} ${v.y}`).join(' ') + ' Z';

    // Cursor as storey-local 2D — splitHoverCutPoint is the 3D
    // form; we want X/Y for the ghost line endpoint.
    const cursorXy: [number, number] | null = splitHoverCutPoint
      ? [splitHoverCutPoint[0], splitHoverCutPoint[1]]
      : null;
    const anchorScreen = slabCutAnchor
      ? project(ifc2dToRendererWorld(slabCutAnchor, storeyElevation))
      : null;
    const cursorScreen = cursorXy
      ? project(ifc2dToRendererWorld(cursorXy, storeyElevation))
      : null;

    return (
      <svg className="absolute inset-0 pointer-events-none z-30" style={{ overflow: 'visible' }}>
        <path
          d={path}
          fill={GUIDE_COLOR}
          fillOpacity={0.08}
          stroke={GUIDE_COLOR}
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
        {anchorScreen && (
          <circle
            cx={anchorScreen.x}
            cy={anchorScreen.y}
            r={5}
            fill="#fff"
            stroke={GUIDE_COLOR}
            strokeWidth={2.5}
          />
        )}
        {anchorScreen && cursorScreen && (
          <line
            x1={anchorScreen.x}
            y1={anchorScreen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            stroke={GUIDE_COLOR}
            strokeWidth={3}
            strokeLinecap="round"
          />
        )}
        {cursorScreen && (
          <circle
            cx={cursorScreen.x}
            cy={cursorScreen.y}
            r={4}
            fill="#fff"
            stroke={GUIDE_COLOR}
            strokeWidth={2}
          />
        )}
      </svg>
    );
  }

  // Single-click element split (wall / beam / column / member).
  if (!splitHoverPoint || splitHoverDistance === null || splitHoverLength === null) {
    return null;
  }
  const cutWorld: Vec3 = { x: splitHoverPoint[0], y: splitHoverPoint[1], z: splitHoverPoint[2] };
  const cutScreen = project(cutWorld);
  if (!cutScreen) return null;

  // Build the perpendicular guide from the slice-provided IFC axis.
  let guideDx = 0;
  let guideDy = -1;
  if (splitTargetModelId !== null && splitHoverAxisDirection) {
    const [ax, ay, az] = splitHoverAxisDirection;
    const farScreen = project({
      x: cutWorld.x + ax,
      y: cutWorld.y + az,
      z: cutWorld.z - ay,
    });
    if (farScreen) {
      const axisDx = farScreen.x - cutScreen.x;
      const axisDy = farScreen.y - cutScreen.y;
      const len = Math.hypot(axisDx, axisDy);
      if (len > 1e-3) {
        // Perpendicular in screen space is (-dy, dx).
        guideDx = -axisDy / len;
        guideDy = axisDx / len;
      }
    }
  }

  const gx1 = cutScreen.x - guideDx * GUIDE_HALF_LENGTH_PX;
  const gy1 = cutScreen.y - guideDy * GUIDE_HALF_LENGTH_PX;
  const gx2 = cutScreen.x + guideDx * GUIDE_HALF_LENGTH_PX;
  const gy2 = cutScreen.y + guideDy * GUIDE_HALF_LENGTH_PX;
  const labelText = `${splitHoverDistance.toFixed(2)} / ${splitHoverLength.toFixed(2)} m`;

  return (
    <svg className="absolute inset-0 pointer-events-none z-30" style={{ overflow: 'visible' }}>
      <line
        x1={gx1}
        y1={gy1}
        x2={gx2}
        y2={gy2}
        stroke={GUIDE_COLOR}
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.95}
      />
      <circle
        cx={cutScreen.x}
        cy={cutScreen.y}
        r={5}
        fill="#fff"
        stroke={GUIDE_COLOR}
        strokeWidth={2.5}
      />
      <rect
        x={cutScreen.x + 12}
        y={cutScreen.y - 22}
        width={Math.max(70, labelText.length * 7 + 12)}
        height={18}
        rx={3}
        fill={GUIDE_COLOR}
        opacity={0.95}
      />
      <text
        x={cutScreen.x + 18}
        y={cutScreen.y - 9}
        fontSize={11}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fill="#fff"
      >
        {labelText}
      </text>
    </svg>
  );
}
