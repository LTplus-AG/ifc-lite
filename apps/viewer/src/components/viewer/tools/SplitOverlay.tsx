/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live SVG preview for the Split tool. Mounted by `ToolOverlays`
 * while `activeTool === 'split'`.
 *
 * Reads the live hover state from `splitToolSlice` — populated by
 * `handleSplitHover` in `selectionHandlers` — and draws:
 *
 *   - a small filled circle at the projected cut point (renderer-
 *     frame world coords → projected to screen via the existing
 *     `cameraCallbacks.projectToScreen`)
 *   - a perpendicular guide line across the wall axis at the cut
 *     point (orthogonal to wall direction in the storey plane)
 *   - a label showing "distance / length" (e.g. "1.42 / 3.50 m")
 *   - a faint hint at the bottom of the screen while idle so the
 *     user knows the tool is armed
 *
 * Same camera-tracking RAF trick the GizmoOverlay uses, so the
 * preview stays glued to the wall when the user orbits / zooms
 * without re-rendering on every camera frame.
 */

import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { Slice as KnifeIcon } from 'lucide-react';

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type Project = (worldPos: Vec3) => Vec2 | null;

const GUIDE_COLOR = '#a855f7'; // purple-500 — matches edit-mode pill
const GUIDE_HALF_LENGTH_PX = 30;

export function SplitOverlay() {
  const activeTool = useViewerStore((s) => s.activeTool);
  const splitMode = useViewerStore((s) => s.splitMode);
  const splitHoverPoint = useViewerStore((s) => s.splitHoverPoint);
  const splitHoverDistance = useViewerStore((s) => s.splitHoverDistance);
  const splitHoverLength = useViewerStore((s) => s.splitHoverLength);
  const splitHoverCutPoint = useViewerStore((s) => s.splitHoverCutPoint);
  const splitHoverAxisDirection = useViewerStore((s) => s.splitHoverAxisDirection);
  const splitTargetModelId = useViewerStore((s) => s.splitTargetModelId);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);

  const [frameTick, setFrameTick] = useState(0);
  const lastViewpointRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  // RAF tick — wake the overlay when the camera moves so the guide
  // tracks the wall through orbit / zoom. Skipped when nothing is
  // hovered, so an idle Split tool with no cursor over a wall is
  // free.
  const active = activeTool === 'split' && splitMode === 'aiming' && splitHoverPoint !== null;
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const vp = getViewpoint?.();
      if (vp) {
        const sig = `${vp.position.x},${vp.position.y},${vp.position.z},${vp.target.x},${vp.target.y},${vp.target.z},${vp.fov},${vp.projectionMode},${vp.orthoSize ?? ''}`;
        if (sig !== lastViewpointRef.current) {
          lastViewpointRef.current = sig;
          setFrameTick((n) => (n + 1) % 1_000_000);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active, getViewpoint]);

  // Read frameTick so this component re-renders on camera changes
  // even when nothing else in our state changes. The variable is
  // intentionally consumed for its side effect of subscribing.
  void frameTick;

  // While idle (tool armed, no hover) — show a small hint chip at
  // the bottom of the canvas so users know they're in Split mode
  // and what to do.
  if (activeTool === 'split' && !active) {
    return (
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none z-30
          flex items-center gap-2 px-3 py-1.5 rounded-full
          bg-purple-600/95 text-white text-xs shadow-lg"
        role="status"
      >
        <KnifeIcon className="h-3.5 w-3.5" />
        <span>Hover over a wall, beam, column, or member — Esc to exit</span>
      </div>
    );
  }

  if (!active || !projectToScreen || !splitHoverPoint || splitHoverDistance === null || splitHoverLength === null) {
    return null;
  }

  const project = projectToScreen as Project;
  const cutWorld: Vec3 = { x: splitHoverPoint[0], y: splitHoverPoint[1], z: splitHoverPoint[2] };
  const cutScreen = project(cutWorld);
  if (!cutScreen) return null;

  // Build the perpendicular guide from the slice-provided IFC
  // axis. Convert the unit-length axis from IFC Z-up to the
  // renderer's Y-up frame (renderer = (ifc.x, ifc.z, -ifc.y)),
  // project two world points 1 m apart along it, and rotate 90° in
  // screen space to draw the perpendicular through the cut point.
  // Storey elevation cancels out in the screen delta so we don't
  // need to fetch it here — both projected points share the same
  // additive offset.
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
  // Suppress unused-import warning — `splitHoverCutPoint` is read
  // from the store so the overlay re-renders on cut-point changes,
  // even though the perpendicular math uses cutWorld directly.
  void splitHoverCutPoint;

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
