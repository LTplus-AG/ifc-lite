/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useTranslation } from '@/i18n';
import { customPlaneCenter, useViewerStore } from '@/store';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';

/**
 * Click+drag arrow that translates the custom section plane along its
 * picked normal. Uses screen-space projection of `center` (= pickedAt
 * projected onto the live plane) and `center + normal` to convert
 * cursor pixels into world units — resolution-independent and works
 * for any tilt.
 *
 * Re-projects the anchor every animation frame while dragging so the
 * gizmo stays glued to the live plane even if the camera moves
 * (orbit / pan are still allowed underneath this overlay because we
 * only call `setPointerCapture` on the handle's <circle>).
 */
export function SectionPlaneDragGizmo(props: {
  color: string;
  customPlane: NonNullable<ReturnType<typeof useViewerStore.getState>['sectionPlane']['custom']>;
  setDistance: (d: number) => void;
  onDragStart: () => void;
  onDragEnd:   () => void;
}) {
  const { t } = useTranslation();
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
  //
  // The foot anchor is `pickedAt` projected onto the LIVE plane (not
  // `pickedAt` itself). As the user drags the gizmo only `distance`
  // changes; pickedAt sits off the moving plane, so anchoring the
  // gizmo to it would leave the arrow stranded at the original pick
  // location while the cut slides along the normal. Using the
  // projected center keeps the gizmo glued to the actual cut plane.
  useEffect(() => {
    let raf = 0;
    const project = () => {
      const renderer = getGlobalRenderer();
      const camera = renderer?.getCamera();
      const canvas = renderer?.getCanvas();
      if (camera && canvas) {
        const center = customPlaneCenter(customPlane);
        const tipWorld = {
          x: center[0] + customPlane.normal[0],
          y: center[1] + customPlane.normal[1],
          z: center[2] + customPlane.normal[2],
        };
        const footWorld = {
          x: center[0],
          y: center[1],
          z: center[2],
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
  }, [customPlane.pickedAt, customPlane.normal, customPlane.distance]);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (!proj) return;
    e.stopPropagation();
    e.preventDefault();
    capturePointer(e.target as Element, e.pointerId);
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
      releasePointer(e.target as Element, e.pointerId);
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
        <title>{t('sectionTool.gizmo.dragTitle')}</title>
      </circle>
    </g>
  );
}
