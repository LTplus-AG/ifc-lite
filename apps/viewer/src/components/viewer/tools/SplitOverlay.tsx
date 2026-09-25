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
 *     Outline the polygon footprint with a faint accent stroke.
 *     After the first click: ghost line from anchor → cursor,
 *     drawn straight through the polygon (the actual extent is
 *     clamped by polygon-clip at commit).
 *
 * The idle hint ("move the cursor to set the cut point…") is not drawn
 * here: it is the `TOOL_HUD.split.hint` line the HUD places bottom-center
 * (#5503). The distance / length readout is a scene-kernel `WorldLabel`
 * anchored on the cut point.
 *
 * The guide geometry itself (a perpendicular through the cut point, which
 * needs the projected axis direction, not just a point) is re-projected off
 * the shared scene-overlay kernel's dirty tick (#5486/#5512, charter
 * #5478): `useProjectorTick` re-renders this component once per tick
 * of the ONE shared `SceneProjector` loop instead of running its own
 * `requestAnimationFrame` poll (`useCameraTickSubscription`), so the
 * preview tracks the element through orbit/zoom without re-rendering on
 * every camera frame regardless of motion.
 */

import { useViewerStore } from '@/store';
import { formatSplitHoverLabel } from './formatDistance';
import { WorldLabel, useProjectorTick } from '../../viewport-ui/scene';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;

// Guides are the interaction accent, their knockouts the halo — overlay
// tokens (#5483) applied as classes, so a theme switch recolours them (#5489).

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
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const slabCutAnchor = useViewerStore((s) => s.slabCutAnchor);
  const slabCutFootprint = useViewerStore((s) => s.slabCutFootprint);
  const slabCutStoreyElevation = useViewerStore((s) => s.slabCutStoreyElevation);
  const readSlabFootprint = useViewerStore((s) => s.readSlabFootprint);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);

  // Shared-projector frame tick — wakes the overlay when the camera moves
  // so the preview tracks the element through orbit / zoom. Skipped when
  // nothing is hovered (idle Split tool with no cursor over an element is
  // free of per-frame work).
  const active =
    activeTool === 'split' &&
    (splitMode === 'aiming' || splitMode === 'first-anchor') &&
    splitHoverPoint !== null;
  void useProjectorTick(active);

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
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
        <path
          d={path}
          className="fill-overlay-accent stroke-overlay-accent"
          fillOpacity={0.08}
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
        {anchorScreen && (
          <circle
            cx={anchorScreen.x}
            cy={anchorScreen.y}
            r={5}
            className="fill-overlay-halo stroke-overlay-accent"
            strokeWidth={2.5}
          />
        )}
        {anchorScreen && cursorScreen && (
          <line
            x1={anchorScreen.x}
            y1={anchorScreen.y}
            x2={cursorScreen.x}
            y2={cursorScreen.y}
            className="stroke-overlay-accent"
            strokeWidth={3}
            strokeLinecap="round"
          />
        )}
        {cursorScreen && (
          <circle
            cx={cursorScreen.x}
            cy={cursorScreen.y}
            r={4}
            className="fill-overlay-halo stroke-overlay-accent"
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
  const labelText = formatSplitHoverLabel(splitHoverDistance, splitHoverLength, unitDisplayOverrides);

  return (
    <>
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
        <line
          x1={gx1}
          y1={gy1}
          x2={gx2}
          y2={gy2}
          className="stroke-overlay-accent"
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.95}
        />
        <circle
          cx={cutScreen.x}
          cy={cutScreen.y}
          r={5}
          className="fill-overlay-halo stroke-overlay-accent"
          strokeWidth={2.5}
        />
      </svg>
      {/* Live readout: accent-bordered because it is the thing being set. */}
      <WorldLabel worldPoint={cutWorld} active offset={{ dx: 14, dy: -30 }}>
        {labelText}
      </WorldLabel>
    </>
  );
}
