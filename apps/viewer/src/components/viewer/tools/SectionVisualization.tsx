/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane visual indicator/gizmo.
 *
 * In addition to the cardinal-axis corner badge (existing), this also
 * renders the 3D drag gizmo for face-picked custom planes (issue #243):
 * a violet dot at the live plane anchor (`pickedAt` projected onto the
 * current plane via `customPlaneCenter`) plus an arrow along the picked
 * normal that the user can click + drag to slide the cut plane
 * perpendicular to its surface. Anchoring to the projected center —
 * instead of `pickedAt` directly — keeps the gizmo glued to the plane
 * as `distance` changes; using `pickedAt` directly would freeze the
 * gizmo at the original face-pick location while the geometry clip
 * slides to the new distance. The drag math projects the cursor delta
 * onto the screen-projected normal and converts pixels-per-meter via
 * the camera's point-projection of `center + normal * 1m`.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { AXIS_INFO } from './sectionConstants';
import { useViewerStore, customPlaneCenter } from '@/store';
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
  // Live face-pick hover preview (issue #243 follow-up). Only set
  // while pick mode is armed AND the cursor has dwelled ~200ms over a
  // surface. Drives the violet quad + arrow that telegraph "this is
  // where I'll cut if you click here" before the user commits.
  const sectionPickPreview = useViewerStore((s) => s.sectionPickPreview);
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

      {/* Face-pick hover preview — purely visual, click-through. */}
      {sectionPickPreview && (
        <SectionPickPreviewOverlay
          color={CUSTOM_COLOR}
          preview={sectionPickPreview}
        />
      )}
    </svg>
  );
}

/**
 * Translucent violet quad + tiny normal arrow painted on the surface
 * the user is hovering while section pick mode is armed (issue #243
 * follow-up). Purely a hint — does not commit a section plane;
 * `selectionHandlers.ts` does that on click.
 *
 * Rendered as an SVG overlay to match `CustomPlaneDragGizmo` (no new
 * GPU pipeline, follows the camera "for free" via per-frame
 * projection). The quad's footprint follows `tangent`/`bitangent` of
 * the hit normal so it looks like a flat square laid on the surface
 * regardless of camera angle, and its on-screen radius is clamped to
 * `[24px, 80px]` so it stays readable from any zoom.
 *
 * Pointer-events are forced off so the overlay never intercepts the
 * click that would commit the actual cut — the SVG container above
 * already disables them, but child <g> elements with `pointerEvents:
 * 'auto'` (e.g. the drag gizmo's circle) co-exist in the same tree.
 */
function SectionPickPreviewOverlay(props: {
  color: string;
  preview: NonNullable<ReturnType<typeof useViewerStore.getState>['sectionPickPreview']>;
}) {
  const { color, preview } = props;
  // Project the four quad corners + the arrow tip every animation
  // frame so the overlay tracks camera orbit/pan without any extra
  // store subscription. Cheap (5 mat-mul per frame).
  const [proj, setProj] = useState<{
    quad: Array<{ x: number; y: number }>;
    foot: { x: number; y: number };
    tip:  { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    let raf = 0;
    const project = () => {
      const renderer = getGlobalRenderer();
      const camera = renderer?.getCamera();
      const canvas = renderer?.getCanvas();
      if (camera && canvas) {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const [px, py, pz] = preview.point;
        const [nx, ny, nz] = preview.normal;

        // Build an orthonormal in-plane basis from the normal. This
        // duplicates `planeBasis()` from the renderer package — done
        // inline to keep the overlay self-contained and avoid pulling
        // a renderer dep into the React layer just for two cross
        // products. The choice of seed (Z vs X) avoids a degenerate
        // cross when the normal is near ±Y.
        const seedX = Math.abs(ny) > 0.9 ? 1 : 0;
        const seedY = Math.abs(ny) > 0.9 ? 0 : 0;
        const seedZ = Math.abs(ny) > 0.9 ? 0 : 1;
        // tangent = normalize(cross(normal, seed))
        let tx = ny * seedZ - nz * seedY;
        let ty = nz * seedX - nx * seedZ;
        let tz = nx * seedY - ny * seedX;
        const tLen = Math.hypot(tx, ty, tz) || 1;
        tx /= tLen; ty /= tLen; tz /= tLen;
        // bitangent = cross(normal, tangent)
        const bx = ny * tz - nz * ty;
        const by = nz * tx - nx * tz;
        const bz = nx * ty - ny * tx;

        // Quad half-extent: 0.5m world to start; we'll clamp the
        // visible size in screen pixels below by interpolating along
        // the projected diagonal if the apparent size lands outside
        // [24, 80]px.
        const halfWorld = 0.5;

        const corner = (s: number, t: number) => {
          const wx = px + tx * s + bx * t;
          const wy = py + ty * s + by * t;
          const wz = pz + tz * s + bz * t;
          return camera.projectToScreen({ x: wx, y: wy, z: wz }, w, h);
        };

        const c0 = corner(-halfWorld, -halfWorld);
        const c1 = corner( halfWorld, -halfWorld);
        const c2 = corner( halfWorld,  halfWorld);
        const c3 = corner(-halfWorld,  halfWorld);
        const foot = camera.projectToScreen({ x: px, y: py, z: pz }, w, h);
        // Arrow tip 0.4m along the normal — half a typical wall
        // thickness, enough for the arrowhead to read at default
        // zoom without dwarfing small objects.
        const tip = camera.projectToScreen(
          { x: px + nx * 0.4, y: py + ny * 0.4, z: pz + nz * 0.4 },
          w, h,
        );

        if (c0 && c1 && c2 && c3 && foot && tip) {
          // On-screen size clamp: rescale the four corners about the
          // foot so the apparent diagonal falls in [24px, 80px]. This
          // keeps the preview readable at extreme zooms (a 1m quad
          // can otherwise shrink to 2px from far away or fill the
          // canvas up close).
          const dx = c2.x - c0.x;
          const dy = c2.y - c0.y;
          const diag = Math.hypot(dx, dy) || 1;
          const minPx = 50;  // ~50px diagonal — visible but not
                             // overpowering
          const maxPx = 140;
          const scale = diag < minPx ? minPx / diag
                      : diag > maxPx ? maxPx / diag
                      : 1;
          const rescale = (c: { x: number; y: number }) => ({
            x: foot.x + (c.x - foot.x) * scale,
            y: foot.y + (c.y - foot.y) * scale,
          });
          setProj({
            quad: [rescale(c0), rescale(c1), rescale(c2), rescale(c3)],
            foot,
            tip,
          });
        }
      }
      raf = requestAnimationFrame(project);
    };
    project();
    return () => cancelAnimationFrame(raf);
  }, [preview.point, preview.normal, preview.faceKey]);

  if (!proj) return null;

  const { quad, foot, tip } = proj;
  // Arrow pixel length capped at 36px so it stays a small "telltale"
  // rather than visually competing with the quad. Direction comes
  // from the projected normal so it tracks camera orientation.
  const adx = tip.x - foot.x, ady = tip.y - foot.y;
  const aLen = Math.hypot(adx, ady) || 1;
  const ARROW_PX = Math.min(36, aLen);
  const tipX = foot.x + (adx / aLen) * ARROW_PX;
  const tipY = foot.y + (ady / aLen) * ARROW_PX;

  return (
    <g style={{ pointerEvents: 'none' }} aria-hidden>
      {/* Translucent violet quad — the "you'll cut here" hint. */}
      <polygon
        points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
        fill={color}
        fillOpacity="0.28"
        stroke={color}
        strokeWidth="1.5"
        strokeOpacity="0.7"
      />
      {/* Tiny normal arrow — shaft. */}
      <line
        x1={foot.x} y1={foot.y}
        x2={tipX}   y2={tipY}
        stroke={color} strokeWidth="2" strokeLinecap="round"
        opacity="0.9"
      />
      {/* Arrowhead — small triangle perpendicular to the shaft. */}
      <polygon
        points={(() => {
          const ux = adx / aLen, uy = ady / aLen;
          const nxp = -uy, nyp = ux;
          const baseX = tipX - ux * 6;
          const baseY = tipY - uy * 6;
          const ax = baseX + nxp * 4, ay = baseY + nyp * 4;
          const bx = baseX - nxp * 4, by = baseY - nyp * 4;
          return `${tipX},${tipY} ${ax},${ay} ${bx},${by}`;
        })()}
        fill={color} opacity="0.95"
      />
    </g>
  );
}

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
