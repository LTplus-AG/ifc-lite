/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeference drag gizmo — a scene overlay only (#5505: the docked
 * `placement` panel's Georeference tab now carries the metrics/nudge/apply
 * chrome that used to live in this component's floating card, under
 * `CesiumPlacementEditor.tsx`). This file keeps exactly the parts that must
 * stay drawn over the 3D view: the XY drag plane, the height handle, and the
 * screen projection math that places them. It also publishes the active
 * model's georeference context (`lib/geo/placement-georef-runtime.ts`) so the
 * side panel — mounted elsewhere in the tree — can show the same numbers and
 * drive apply/reset without recomputing the expensive federated-geometry
 * `georef` memo a second time.
 *
 * Re-render wake (#5995, following #5510's `GizmoOverlay`/`WallEndpointOverlay`/
 * `PlacementGizmo` swap): this used to run its own unconditional
 * `requestAnimationFrame` loop, recomputing the plane/height-handle screen
 * projection every frame for as long as `editMode` was true — the same
 * per-component-timer defect class the scene kernel's shared `SceneProjector`
 * (#5486) exists to fix. `useProjectorTick` subscribes to that one shared
 * loop instead; the projection itself is now computed directly in the render
 * body (`projectGizmoGeometry` below) rather than pushed into state from an
 * effect, so there is no longer a frame of lag between a wake and the new
 * screen position painting. The projection math itself — `camera.projectToScreen`
 * against `getGlobalRenderer()`'s camera/canvas — is unchanged; only the
 * "when do we recompute it" trigger moved onto the kernel. `unprojectToRay`
 * (the drag math, `rayFromPointerEvent`) stays direct: it is an on-demand,
 * per-pointer-event call, not a per-frame poll, and the shared projector's
 * `ProjectorCamera` doesn't expose it anyway (#5486 keeps that interface to
 * `projectToScreen` only).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { useTranslation } from '@/i18n';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useProjectorTick } from '@/components/viewport-ui/scene';
import {
  closestYOnVerticalLineFromRay,
  getMapUnitScale,
  intersectRayWithHorizontalPlane,
  projectedDeltaToViewerDeltaForGeometry,
  viewerDeltaToProjectedDeltaForGeometry,
} from '@/lib/geo/cesium-placement';
import { orthogonalHeightDeltaToViewerDeltaForGeometry, viewerHeightDeltaToOrthogonalHeightDeltaForGeometry } from '@/lib/geo/viewer-up-scale';
import { findClampAnchorY } from '@/lib/geo/clamp-anchor';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';
import { publishPlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { useViewerStore } from '@/store';
import { round2, roundToMm } from './cesium-placement-math';
import { useCesiumPlacementController } from './useCesiumPlacementController';

interface CesiumPlacementGizmoProps {
  modelId: string;
  mapConversion: MapConversion;
  baseMapConversion: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
  storeyElevations?: Map<number, number>;
}

type ScreenPoint = { x: number; y: number };
type WorldPoint = { x: number; y: number; z: number };
type GizmoProjection = { center: ScreenPoint; heightTip: ScreenPoint; planeCorners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] };
interface ProjectorCameraLike {
  projectToScreen(p: WorldPoint, w: number, h: number): ScreenPoint | null;
}

/**
 * The plane-corners/height-tip/center screen projection for the drag gizmo,
 * pure and synchronous — called directly from the render body (see the
 * module docblock) rather than from an effect, so a `useProjectorTick` wake
 * repaints in the same frame instead of one frame behind.
 */
function projectGizmoGeometry(
  camera: ProjectorCameraLike,
  canvas: { clientWidth: number; clientHeight: number },
  anchorWorld: WorldPoint,
  gizmoHalfWorldSize: number,
  deltaAngleDegrees: number,
): GizmoProjection | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const center = camera.projectToScreen(anchorWorld, w, h);
  const heightAxisMeters = gizmoHalfWorldSize * 1.25;
  const heightTip = camera.projectToScreen({ ...anchorWorld, y: anchorWorld.y + heightAxisMeters }, w, h);
  const rotationRadians = deltaAngleDegrees * Math.PI / 180;
  const ux = { x: Math.cos(rotationRadians), z: -Math.sin(rotationRadians) };
  const uz = { x: Math.sin(rotationRadians), z: Math.cos(rotationRadians) };
  const corner = (sx: number, sz: number) => camera.projectToScreen(
    { x: anchorWorld.x + ux.x * sx + uz.x * sz, y: anchorWorld.y, z: anchorWorld.z + ux.z * sx + uz.z * sz }, w, h,
  );
  const c0 = corner(-gizmoHalfWorldSize, -gizmoHalfWorldSize);
  const c1 = corner(gizmoHalfWorldSize, -gizmoHalfWorldSize);
  const c2 = corner(gizmoHalfWorldSize, gizmoHalfWorldSize);
  const c3 = corner(-gizmoHalfWorldSize, gizmoHalfWorldSize);
  if (!center || !heightTip || !c0 || !c1 || !c2 || !c3) return null;
  return { center, heightTip, planeCorners: [c0, c1, c2, c3] };
}

function getGizmoWorldSize(coordinateInfo: CoordinateInfo | undefined): number {
  const bounds = coordinateInfo?.originalBounds;
  if (!bounds) return 25;
  const dx = bounds.max.x - bounds.min.x;
  const dy = bounds.max.y - bounds.min.y;
  const dz = bounds.max.z - bounds.min.z;
  const size = Math.max(dx, dy, dz) * 0.45;
  return Math.min(80, Math.max(15, size));
}

// Drag math is anchored in WORLD SPACE (ray-plane / ray-line intersection)
// rather than projected screen-axis pixels; see the original module's note
// (now here) on why: screen-space linearisations alias badly when the gizmo
// plane is near-edge-on to the camera.
type DragState =
  | { mode: 'height'; anchorX: number; anchorZ: number; startWorldY: number; startDraft: { orthogonalHeight: number } }
  | { mode: 'xy'; planeY: number; startHit: WorldPoint; startDraft: { eastings: number; northings: number } };

interface PointerRay {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

/**
 * Resolve a CSS-pixel pointer event into a world-space ray via the renderer
 * camera. Returns null when the renderer/canvas isn't mounted yet.
 */
function rayFromPointerEvent(clientX: number, clientY: number): PointerRay | null {
  const renderer = getGlobalRenderer();
  const camera = renderer?.getCamera();
  const canvas = renderer?.getCanvas();
  if (!camera || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const bufferX = ((clientX - rect.left) / rect.width) * canvas.width;
  const bufferY = ((clientY - rect.top) / rect.height) * canvas.height;
  const ray = camera.unprojectToRay(bufferX, bufferY, canvas.width, canvas.height);
  if (!ray) return null;
  return ray;
}

export function CesiumPlacementGizmo({
  modelId,
  mapConversion,
  baseMapConversion,
  projectedCRS,
  coordinateInfo,
  lengthUnitScale = 1,
  storeyElevations,
}: CesiumPlacementGizmoProps) {
  const { t } = useTranslation();
  const controller = useCesiumPlacementController({ modelId, mapConversion, baseMapConversion, projectedCRS, coordinateInfo, lengthUnitScale });
  const { editMode, activeDraft, guardConversion, updateDraft } = controller;
  const dragStateRef = useRef<DragState | null>(null);
  // Shared-projector wake (#5995, #5510) — re-renders on real camera motion
  // via the scene kernel's one shared `SceneProjector` tick instead of a
  // private `requestAnimationFrame` poll. Skipped while not editing.
  void useProjectorTick(editMode);

  // Publish the context the docked panel's Georeference tab reads, regardless
  // of edit mode — the tab shows the saved anchor and an "edit" toggle even
  // before a drag session starts.
  useEffect(() => {
    publishPlacementGeorefContext({ modelId, mapConversion, baseMapConversion, projectedCRS, coordinateInfo, lengthUnitScale });
    return () => publishPlacementGeorefContext(null);
  }, [modelId, mapConversion, baseMapConversion, projectedCRS, coordinateInfo, lengthUnitScale]);

  // Surface the docked `placement` panel's Georeference tab (#5505) whenever
  // an edit session starts (the "Move georef" toolbar/ribbon toggle), the
  // same auto-open `RepositionRuntimeHost` does for the Local tab.
  useEffect(() => {
    if (editMode) useViewerStore.getState().openPanelInHome('placement', 'programmatic');
  }, [editMode]);

  const anchorWorld = useMemo((): WorldPoint => {
    const bounds = coordinateInfo?.originalBounds;
    const centerX = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
    const centerZ = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
    const anchorY = findClampAnchorY(bounds, storeyElevations);
    const xyOffset = projectedDeltaToViewerDeltaForGeometry(
      controller.deltaE,
      controller.deltaN,
      guardConversion,
      projectedCRS,
      lengthUnitScale,
      coordinateInfo,
    );

    return {
      x: centerX + xyOffset.x,
      y: anchorY + orthogonalHeightDeltaToViewerDeltaForGeometry(
        controller.deltaH, guardConversion, projectedCRS, lengthUnitScale, coordinateInfo),
      z: centerZ + xyOffset.z,
    };
  }, [guardConversion, coordinateInfo, controller.deltaE, controller.deltaN, controller.deltaH, lengthUnitScale, projectedCRS, storeyElevations]);
  const gizmoHalfWorldSize = useMemo(() => getGizmoWorldSize(coordinateInfo), [coordinateInfo]);

  const renderer = editMode ? getGlobalRenderer() : null;
  const camera = renderer?.getCamera();
  const canvas = renderer?.getCanvas();
  const projection = editMode && camera && canvas
    ? projectGizmoGeometry(camera, canvas, anchorWorld, gizmoHalfWorldSize, controller.deltaAngle)
    : null;

  const handleHeightPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!projection) return;
    const ray = rayFromPointerEvent(e.clientX, e.clientY);
    if (!ray) return;
    const startWorldY = closestYOnVerticalLineFromRay(ray, anchorWorld.x, anchorWorld.z);
    if (startWorldY === null) return;
    e.preventDefault(); e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    dragStateRef.current = { mode: 'height', startDraft: activeDraft, anchorX: anchorWorld.x, anchorZ: anchorWorld.z, startWorldY };
  }, [activeDraft, anchorWorld.x, anchorWorld.z, projection]);

  const handlePlanePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!projection) return;
    const ray = rayFromPointerEvent(e.clientX, e.clientY);
    if (!ray) return;
    const startHit = intersectRayWithHorizontalPlane(ray, anchorWorld.y);
    if (!startHit) return;
    e.preventDefault(); e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    dragStateRef.current = { mode: 'xy', startDraft: activeDraft, planeY: anchorWorld.y, startHit };
  }, [activeDraft, anchorWorld.y, projection]);

  const handlePointerMove = useCallback((e: React.PointerEvent<Element>) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    e.preventDefault(); e.stopPropagation();

    const ray = rayFromPointerEvent(e.clientX, e.clientY);
    if (!ray) return;

    // The session baseline under this gesture's frozen draft — see the XY
    // note below (unchanged from the original `CesiumPlacementEditor`).
    const dragConversion = { ...baseMapConversion, ...dragState.startDraft };
    if (dragState.mode === 'height') {
      const worldY = closestYOnVerticalLineFromRay(ray, dragState.anchorX, dragState.anchorZ);
      if (worldY === null) return;
      const mus = getMapUnitScale(projectedCRS, lengthUnitScale);
      updateDraft({
        orthogonalHeight: roundToMm(dragState.startDraft.orthogonalHeight
          + viewerHeightDeltaToOrthogonalHeightDeltaForGeometry(
            worldY - dragState.startWorldY, dragConversion, projectedCRS, lengthUnitScale, coordinateInfo), mus),
      });
      return;
    }

    const hit = intersectRayWithHorizontalPlane(ray, dragState.planeY);
    if (!hit) return;
    const deltaX = hit.x - dragState.startHit.x;
    const deltaZ = hit.z - dragState.startHit.z;
    // Known remaining limit, inherited from the guard's design (unchanged
    // from `CesiumPlacementEditor`): on a map-absolute file every placement
    // consumer neutralises the SAVED anchor too, so an applied edit has no
    // effect while the new anchor stays within the 10 km detection window.
    const projectedDelta = viewerDeltaToProjectedDeltaForGeometry(deltaX, deltaZ, dragConversion, projectedCRS, lengthUnitScale, coordinateInfo);
    updateDraft({
      eastings: round2(dragState.startDraft.eastings + projectedDelta.eastings),
      northings: round2(dragState.startDraft.northings + projectedDelta.northings),
    });
  }, [baseMapConversion, coordinateInfo, lengthUnitScale, projectedCRS, updateDraft]);

  const handlePointerUp = useCallback((e: React.PointerEvent<Element>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    releasePointer(e.currentTarget, e.pointerId);
  }, []);

  if (!editMode || !projection) return null;

  const { planeCorners, center, heightTip } = projection;
  const planePoints = planeCorners.map((point) => `${point.x},${point.y}`).join(' ');
  const minPlaneX = Math.min(...planeCorners.map((p) => p.x));
  const maxPlaneX = Math.max(...planeCorners.map((p) => p.x));
  const minPlaneY = Math.min(...planeCorners.map((p) => p.y));
  const maxPlaneY = Math.max(...planeCorners.map((p) => p.y));
  const hitPadding = 16;
  const [c0, c1, c2, c3] = planeCorners;
  const xAxisStart = { x: (c0.x + c3.x) / 2, y: (c0.y + c3.y) / 2 };
  const xAxisEnd = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
  const zAxisStart = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
  const zAxisEnd = { x: (c2.x + c3.x) / 2, y: (c2.y + c3.y) / 2 };

  return (
    <>
      <svg className="absolute inset-0 z-20 h-full w-full pointer-events-none">
        <defs>
          <pattern id="cesium-placement-grid" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M 12 0 L 0 0 0 12" fill="none" stroke="rgb(45 212 191)" strokeWidth="0.8" opacity="0.45" />
          </pattern>
        </defs>
        <g style={{ pointerEvents: 'auto' }}>
          <polygon points={planePoints} fill="url(#cesium-placement-grid)" stroke="rgb(45 212 191)" strokeWidth="3" opacity="0.92" pointerEvents="none">
            <title>{t('cesiumGeo.placement.dragPlaneTitle')}</title>
          </polygon>
          <line x1={xAxisStart.x} y1={xAxisStart.y} x2={xAxisEnd.x} y2={xAxisEnd.y} stroke="white" strokeWidth="2" opacity="0.8" pointerEvents="none" />
          <line x1={zAxisStart.x} y1={zAxisStart.y} x2={zAxisEnd.x} y2={zAxisEnd.y} stroke="white" strokeWidth="2" opacity="0.8" pointerEvents="none" />
          <text x={center.x} y={maxPlaneY + 22} textAnchor="middle" fill="rgb(153 246 228)" fontSize="11" fontFamily="monospace" fontWeight="700" pointerEvents="none">
            {t('cesiumGeo.placement.dragXYLabel')}
          </text>
          <line x1={center.x} y1={center.y} x2={heightTip.x} y2={heightTip.y} stroke="rgb(251 191 36)" strokeWidth="3" strokeLinecap="round" opacity="0.95" />
          <circle cx={heightTip.x} cy={heightTip.y} r="10" fill="rgb(251 191 36)" stroke="white" strokeWidth="2" cursor="grab" pointerEvents="none">
            <title>{t('cesiumGeo.placement.dragHeightTitle')}</title>
          </circle>
          <circle cx={center.x} cy={center.y} r="4" fill="white" stroke="rgb(45 212 191)" strokeWidth="2" />
        </g>
      </svg>

      <button
        type="button"
        aria-label={t('cesiumGeo.placement.dragPlaneAriaLabel')}
        className="absolute z-[21] cursor-grab bg-transparent active:cursor-grabbing"
        style={{
          left: minPlaneX - hitPadding, top: minPlaneY - hitPadding,
          width: Math.max(56, maxPlaneX - minPlaneX + hitPadding * 2), height: Math.max(56, maxPlaneY - minPlaneY + hitPadding * 2),
        }}
        onPointerDown={handlePlanePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
      />
      <button
        type="button"
        aria-label={t('cesiumGeo.placement.dragHeightAriaLabel')}
        className="absolute z-[22] cursor-grab rounded-full bg-transparent active:cursor-grabbing"
        style={{ left: heightTip.x - 18, top: heightTip.y - 18, width: 36, height: 36 }}
        onPointerDown={handleHeightPointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
      />
    </>
  );
}
