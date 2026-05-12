/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane visual indicator/gizmo.
 *
 * In addition to the cardinal-axis corner badge (existing), this also
 * renders the 3D drag gizmo for face-picked custom planes (issue #243):
 * a violet dot at `pickedAt` plus an arrow along the picked normal that
 * the user can click + drag to slide the cut plane perpendicular to its
 * surface. The drag math projects the cursor delta onto the screen-
 * projected normal and converts pixels-per-meter via the camera's
 * point-projection of `pickedAt + normal * 1m`.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { AXIS_INFO } from './sectionConstants';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';

interface SectionPlaneVisualizationProps {
  axis: 'down' | 'front' | 'side';
  enabled: boolean;
}

// Section plane visual indicator component
export function SectionPlaneVisualization({ axis, enabled }: SectionPlaneVisualizationProps) {
  // Get the axis color
  const axisColors = {
    down: '#03A9F4',  // Light blue for horizontal cuts
    front: '#4CAF50', // Green for front cuts
    side: '#FF9800',  // Orange for side cuts
  };

  // Custom plane (face-pick) — paints violet to match the renderer's
  // gizmo quad so the user reads "this is a non-cardinal cut".
  const CUSTOM_COLOR = '#9C6BDE';
  const customPlane = useViewerStore((s) => s.sectionPlane.custom);
  const setSectionCustomDistance = useViewerStore((s) => s.setSectionCustomDistance);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  const isCustom = customPlane !== undefined;

  const color = isCustom ? CUSTOM_COLOR : axisColors[axis];

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-20"
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      <defs>
        <filter id="section-glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        {/* Animated dash pattern */}
        <pattern id="section-pattern" patternUnits="userSpaceOnUse" width="10" height="10">
          <line x1="0" y1="0" x2="10" y2="10" stroke={color} strokeWidth="1" strokeOpacity="0.5"/>
        </pattern>
      </defs>

      {/* Axis indicator in corner */}
      <g transform="translate(24, 24)">
        <circle cx="20" cy="20" r="18" fill={color} fillOpacity={enabled ? 0.2 : 0.1} stroke={color} strokeWidth={enabled ? 3 : 2} filter="url(#section-glow)"/>
        <text
          x="20"
          y="20"
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontFamily="monospace"
          fontSize="11"
          fontWeight="bold"
        >
          {isCustom ? 'CUS' : AXIS_INFO[axis].label.toUpperCase()}
        </text>
        {/* Active indicator */}
        {enabled && (
          <text
            x="20"
            y="32"
            textAnchor="middle"
            fill={color}
            fontFamily="monospace"
            fontSize="7"
            fontWeight="bold"
          >
            CUT
          </text>
        )}
      </g>

      {enabled && customPlane && (
        <CustomPlaneDragGizmo
          color={CUSTOM_COLOR}
          customPlane={customPlane}
          setDistance={setSectionCustomDistance}
          onDragStart={() => { if (pointCloudAssetCount > 0) setPreviewStride(4); }}
          onDragEnd={()  => setPreviewStride(1)}
        />
      )}
    </svg>
  );
}

/**
 * Click+drag arrow that translates the custom section plane along its
 * picked normal. Uses screen-space projection of `pickedAt` and
 * `pickedAt + normal` to convert cursor pixels into world units —
 * resolution-independent and works for any tilt.
 *
 * Re-projects the anchor every animation frame while dragging so the
 * gizmo stays glued to the world point even if the camera moves
 * (orbit / pan are still allowed underneath this overlay because we
 * only call `setPointerCapture` on the handle's <circle>).
 */
function CustomPlaneDragGizmo(props: {
  color: string;
  customPlane: NonNullable<ReturnType<typeof useViewerStore.getState>['sectionPlane']['custom']>;
  setDistance: (d: number) => void;
  onDragStart: () => void;
  onDragEnd:   () => void;
}) {
  const { color, customPlane, setDistance, onDragStart, onDragEnd } = props;
  const [proj, setProj] = useState<{ p0: { x: number; y: number }; p1: { x: number; y: number } } | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    startDistance: number;
    startCursor: { x: number; y: number };
    screenNormal: { x: number; y: number };
    pixelsPerMeter: number;
  } | null>(null);

  // Project the gizmo's two anchor points (foot + tip-of-arrow) every
  // animation frame so it follows the camera. Cheap: two
  // matrix-multiplies per frame.
  useEffect(() => {
    let raf = 0;
    const project = () => {
      const renderer = getGlobalRenderer();
      const camera = renderer?.getCamera();
      const canvas = renderer?.getCanvas();
      if (camera && canvas) {
        const tipWorld = {
          x: customPlane.pickedAt[0] + customPlane.normal[0],
          y: customPlane.pickedAt[1] + customPlane.normal[1],
          z: customPlane.pickedAt[2] + customPlane.normal[2],
        };
        const footWorld = {
          x: customPlane.pickedAt[0],
          y: customPlane.pickedAt[1],
          z: customPlane.pickedAt[2],
        };
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const p0 = camera.projectToScreen(footWorld, w, h);
        const p1 = camera.projectToScreen(tipWorld,  w, h);
        if (p0 && p1) {
          setProj({ p0, p1 });
        }
      }
      raf = requestAnimationFrame(project);
    };
    project();
    return () => cancelAnimationFrame(raf);
  }, [customPlane.pickedAt, customPlane.normal]);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (!proj) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const dx = proj.p1.x - proj.p0.x;
    const dy = proj.p1.y - proj.p0.y;
    const ppm = Math.hypot(dx, dy);
    if (ppm < 1e-3) return; // edge-on view — drag would be unstable
    dragStateRef.current = {
      active: true,
      startDistance: customPlane.distance,
      startCursor:   { x: e.clientX, y: e.clientY },
      screenNormal:  { x: dx / ppm, y: dy / ppm },
      pixelsPerMeter: ppm,
    };
    onDragStart();
  }, [proj, customPlane.distance, onDragStart]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    const s = dragStateRef.current;
    if (!s?.active) return;
    e.stopPropagation();
    const cdx = e.clientX - s.startCursor.x;
    const cdy = e.clientY - s.startCursor.y;
    // Project cursor delta onto the screen-projected normal, then
    // convert pixels → meters via `pixelsPerMeter`.
    const screenDelta = cdx * s.screenNormal.x + cdy * s.screenNormal.y;
    const meters = screenDelta / s.pixelsPerMeter;
    setDistance(s.startDistance + meters);
  }, [setDistance]);

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (dragStateRef.current?.active) {
      dragStateRef.current.active = false;
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch (_err) {
        /* cleanup — safe to ignore: pointer already released by browser */
      }
      onDragEnd();
    }
  }, [onDragEnd]);

  if (!proj) return null;

  // Arrow goes 60px past `p0` along the projected normal direction so
  // it stays a consistent visual size regardless of camera distance —
  // we'd otherwise get a tiny arrow when the camera is far away.
  const dx = proj.p1.x - proj.p0.x;
  const dy = proj.p1.y - proj.p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ARROW_PX = 60;
  const tipX = proj.p0.x + (dx / len) * ARROW_PX;
  const tipY = proj.p0.y + (dy / len) * ARROW_PX;

  return (
    <g style={{ pointerEvents: 'auto' }}>
      <line
        x1={proj.p0.x} y1={proj.p0.y}
        x2={tipX}      y2={tipY}
        stroke={color} strokeWidth="3" strokeLinecap="round"
        opacity="0.85"
      />
      {/* Tip arrowhead — small triangle perpendicular to the line. */}
      <polygon
        points={(() => {
          const nx = -dy / len, ny = dx / len; // perpendicular to direction
          const baseX = tipX - (dx / len) * 8;
          const baseY = tipY - (dy / len) * 8;
          const ax = baseX + nx * 5, ay = baseY + ny * 5;
          const bx = baseX - nx * 5, by = baseY - ny * 5;
          return `${tipX},${tipY} ${ax},${ay} ${bx},${by}`;
        })()}
        fill={color} opacity="0.9"
      />
      {/* Foot dot — the actual click+drag target. Larger hit area than
          visual radius for finger-friendly UX. */}
      <circle
        cx={proj.p0.x} cy={proj.p0.y} r={10}
        fill={color}
        fillOpacity="0.85"
        stroke="white" strokeWidth="2"
        cursor="grab"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <title>Drag to slide the cut along its normal</title>
      </circle>
    </g>
  );
}
