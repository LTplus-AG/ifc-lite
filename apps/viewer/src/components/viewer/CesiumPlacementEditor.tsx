/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Move, RotateCcw, X } from 'lucide-react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { toast } from '@/components/ui/toast';
import { getGlobalRenderer } from '@/hooks/useBCF';
import {
  getMapUnitScale,
  mapUnitsToMeters,
  metersToMapUnits,
  projectedDeltaToViewerDelta,
  viewerDeltaToProjectedDelta,
} from '@/lib/geo/cesium-placement';
import { findClampAnchorY } from '@/lib/geo/clamp-anchor';
import { cn } from '@/lib/utils';
import { useViewerStore, type CesiumPlacementDraft } from '@/store';

interface CesiumPlacementEditorProps {
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

const DRAG_AXIS_SAMPLE_METERS = 25;

function getGizmoWorldSize(coordinateInfo: CoordinateInfo | undefined): number {
  const bounds = coordinateInfo?.originalBounds;
  if (!bounds) return 25;
  const dx = bounds.max.x - bounds.min.x;
  const dy = bounds.max.y - bounds.min.y;
  const dz = bounds.max.z - bounds.min.z;
  const size = Math.max(dx, dy, dz) * 0.45;
  return Math.min(80, Math.max(15, size));
}

type DragState =
  | {
      mode: 'height';
      startCursor: ScreenPoint;
      startDraft: CesiumPlacementDraft;
      screenNormal: ScreenPoint;
      pixelsPerMeter: number;
    }
  | {
      mode: 'xy';
      startCursor: ScreenPoint;
      startDraft: CesiumPlacementDraft;
      screenX: ScreenPoint;
      screenZ: ScreenPoint;
    };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSigned(value: number, suffix: string): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : round2(value);
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(2)} ${suffix}`;
}

function normalizeDegrees(value: number): number {
  let normalized = value % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return normalized;
}

function axisAngleDegrees(conversion: Pick<MapConversion, 'xAxisAbscissa' | 'xAxisOrdinate'>): number {
  return normalizeDegrees(
    Math.atan2(conversion.xAxisOrdinate ?? 0, conversion.xAxisAbscissa ?? 1) * 180 / Math.PI,
  );
}

function axisFromAngleDegrees(angleDegrees: number): Pick<MapConversion, 'xAxisAbscissa' | 'xAxisOrdinate'> {
  const radians = angleDegrees * Math.PI / 180;
  return {
    xAxisAbscissa: Math.round(Math.cos(radians) * 1_000_000) / 1_000_000,
    xAxisOrdinate: Math.round(Math.sin(radians) * 1_000_000) / 1_000_000,
  };
}

function intersectPointerWithPlaneY(
  clientX: number,
  clientY: number,
  planeY: number,
): WorldPoint | null {
  const renderer = getGlobalRenderer();
  const camera = renderer?.getCamera();
  const canvas = renderer?.getCanvas();
  if (!camera || !canvas) return null;

  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * canvas.width;
  const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * canvas.height;
  const ray = camera.unprojectToRay(x, y, canvas.width, canvas.height);
  if (!ray || Math.abs(ray.direction.y) < 1e-6) return null;

  const t = (planeY - ray.origin.y) / ray.direction.y;
  if (!Number.isFinite(t) || t < 0) return null;

  return {
    x: ray.origin.x + ray.direction.x * t,
    y: planeY,
    z: ray.origin.z + ray.direction.z * t,
  };
}

export function CesiumPlacementEditor({
  modelId,
  mapConversion,
  baseMapConversion,
  projectedCRS,
  coordinateInfo,
  lengthUnitScale = 1,
  storeyElevations,
}: CesiumPlacementEditorProps) {
  const editMode = useViewerStore((s) => s.cesiumPlacementEditMode);
  const draftModelId = useViewerStore((s) => s.cesiumPlacementDraftModelId);
  const draft = useViewerStore((s) => s.cesiumPlacementDraft);
  const beginDraft = useViewerStore((s) => s.beginCesiumPlacementDraft);
  const updateDraft = useViewerStore((s) => s.updateCesiumPlacementDraft);
  const resetDraft = useViewerStore((s) => s.resetCesiumPlacementDraft);
  const setEditMode = useViewerStore((s) => s.setCesiumPlacementEditMode);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setGeorefFields = useViewerStore((s) => s.setGeorefFields);
  const [projection, setProjection] = useState<{
    center: ScreenPoint;
    heightTip: ScreenPoint;
    heightAxisMeters: number;
    planeCorners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
    planeX: ScreenPoint;
    planeZ: ScreenPoint;
  } | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!editMode) return;
    if (draftModelId !== modelId || !draft) {
      beginDraft(modelId, baseMapConversion);
    }
  }, [baseMapConversion, beginDraft, draft, draftModelId, editMode, modelId]);

  const activeDraft: CesiumPlacementDraft = draftModelId === modelId && draft
    ? draft
    : {
        eastings: mapConversion.eastings,
        northings: mapConversion.northings,
        orthogonalHeight: mapConversion.orthogonalHeight,
        // MapConversion's cos/sin pair is optional; identity = no rotation.
        xAxisAbscissa: mapConversion.xAxisAbscissa ?? 1,
        xAxisOrdinate: mapConversion.xAxisOrdinate ?? 0,
      };

  const mapUnitScale = getMapUnitScale(projectedCRS, lengthUnitScale);
  const mapUnitSuffix = mapUnitScale === 1 ? 'm' : 'map units';
  const baseAngle = axisAngleDegrees(baseMapConversion);
  const activeAngle = axisAngleDegrees(activeDraft);
  const deltaE = activeDraft.eastings - baseMapConversion.eastings;
  const deltaN = activeDraft.northings - baseMapConversion.northings;
  const deltaH = activeDraft.orthogonalHeight - baseMapConversion.orthogonalHeight;
  const deltaAngle = normalizeDegrees(activeAngle - baseAngle);
  const deltaHeightMeters = mapUnitsToMeters(deltaH, projectedCRS, lengthUnitScale);
  const dirty = Math.abs(deltaE) > 1e-6 || Math.abs(deltaN) > 1e-6 || Math.abs(deltaH) > 1e-6 || Math.abs(deltaAngle) > 1e-6;
  const nudgeStep = round2(metersToMapUnits(1, projectedCRS, lengthUnitScale));

  const anchorWorld = useMemo((): WorldPoint => {
    const bounds = coordinateInfo?.originalBounds;
    const centerX = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
    const centerZ = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
    const anchorY = findClampAnchorY(bounds, storeyElevations);
    const xyOffset = projectedDeltaToViewerDelta(
      deltaE,
      deltaN,
      baseMapConversion,
      projectedCRS,
      lengthUnitScale,
    );

    return {
      x: centerX + xyOffset.x,
      y: anchorY + deltaHeightMeters,
      z: centerZ + xyOffset.z,
    };
  }, [
    baseMapConversion,
    coordinateInfo?.originalBounds,
    deltaE,
    deltaN,
    deltaHeightMeters,
    lengthUnitScale,
    projectedCRS,
    storeyElevations,
  ]);
  const gizmoHalfWorldSize = useMemo(
    () => getGizmoWorldSize(coordinateInfo),
    [coordinateInfo],
  );

  useEffect(() => {
    if (!editMode) return;
    let raf = 0;
    const project = () => {
      const renderer = getGlobalRenderer();
      const camera = renderer?.getCamera();
      const canvas = renderer?.getCanvas();
      if (camera && canvas) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const center = camera.projectToScreen(anchorWorld, w, h);
        const heightAxisMeters = gizmoHalfWorldSize * 1.25;
        const heightTip = camera.projectToScreen(
          { ...anchorWorld, y: anchorWorld.y + heightAxisMeters },
          w,
          h,
        );
        const rotationRadians = deltaAngle * Math.PI / 180;
        const ux = { x: Math.cos(rotationRadians), z: -Math.sin(rotationRadians) };
        const uz = { x: Math.sin(rotationRadians), z: Math.cos(rotationRadians) };
        const corner = (sx: number, sz: number) => camera.projectToScreen(
          {
            x: anchorWorld.x + ux.x * sx + uz.x * sz,
            y: anchorWorld.y,
            z: anchorWorld.z + ux.z * sx + uz.z * sz,
          },
          w,
          h,
        );
        const c0 = corner(-gizmoHalfWorldSize, -gizmoHalfWorldSize);
        const c1 = corner(gizmoHalfWorldSize, -gizmoHalfWorldSize);
        const c2 = corner(gizmoHalfWorldSize, gizmoHalfWorldSize);
        const c3 = corner(-gizmoHalfWorldSize, gizmoHalfWorldSize);
        const planeX = camera.projectToScreen(
          {
            ...anchorWorld,
            x: anchorWorld.x + ux.x * DRAG_AXIS_SAMPLE_METERS,
            z: anchorWorld.z + ux.z * DRAG_AXIS_SAMPLE_METERS,
          },
          w,
          h,
        );
        const planeZ = camera.projectToScreen(
          {
            ...anchorWorld,
            x: anchorWorld.x + uz.x * DRAG_AXIS_SAMPLE_METERS,
            z: anchorWorld.z + uz.z * DRAG_AXIS_SAMPLE_METERS,
          },
          w,
          h,
        );
        if (center && heightTip && c0 && c1 && c2 && c3 && planeX && planeZ) {
          setProjection({
            center,
            heightTip,
            heightAxisMeters,
            planeCorners: [c0, c1, c2, c3],
            planeX,
            planeZ,
          });
        }
      }
      raf = requestAnimationFrame(project);
    };
    project();
    return () => cancelAnimationFrame(raf);
  }, [anchorWorld, deltaAngle, editMode, gizmoHalfWorldSize]);

  const handleHeightPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!projection) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const dx = projection.heightTip.x - projection.center.x;
    const dy = projection.heightTip.y - projection.center.y;
    const pixelsPerMeter = Math.hypot(dx, dy);
    if (pixelsPerMeter < 1e-3) return;
    dragStateRef.current = {
      mode: 'height',
      startCursor: { x: e.clientX, y: e.clientY },
      startDraft: activeDraft,
      screenNormal: { x: dx / pixelsPerMeter, y: dy / pixelsPerMeter },
      pixelsPerMeter: pixelsPerMeter / projection.heightAxisMeters,
    };
  }, [activeDraft, projection]);

  const handlePlanePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!projection) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const screenX = {
      x: projection.planeX.x - projection.center.x,
      y: projection.planeX.y - projection.center.y,
    };
    const screenZ = {
      x: projection.planeZ.x - projection.center.x,
      y: projection.planeZ.y - projection.center.y,
    };
    const determinant = screenX.x * screenZ.y - screenX.y * screenZ.x;
    if (Math.abs(determinant) < 1e-3) return;
    dragStateRef.current = {
      mode: 'xy',
      startCursor: { x: e.clientX, y: e.clientY },
      startDraft: activeDraft,
      screenX,
      screenZ,
    };
  }, [activeDraft, projection]);

  const handlePointerMove = useCallback((e: React.PointerEvent<Element>) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    e.preventDefault();
    e.stopPropagation();

    if (dragState.mode === 'height') {
      const dx = e.clientX - dragState.startCursor.x;
      const dy = e.clientY - dragState.startCursor.y;
      const meters = (dx * dragState.screenNormal.x + dy * dragState.screenNormal.y) / dragState.pixelsPerMeter;
      updateDraft({
        orthogonalHeight: round2(
          dragState.startDraft.orthogonalHeight + metersToMapUnits(meters, projectedCRS, lengthUnitScale),
        ),
      });
      return;
    }

    const screenDeltaX = e.clientX - dragState.startCursor.x;
    const screenDeltaY = e.clientY - dragState.startCursor.y;
    const determinant = dragState.screenX.x * dragState.screenZ.y - dragState.screenX.y * dragState.screenZ.x;
    if (Math.abs(determinant) < 1e-3) return;
    const deltaX = ((screenDeltaX * dragState.screenZ.y - screenDeltaY * dragState.screenZ.x) / determinant)
      * DRAG_AXIS_SAMPLE_METERS;
    const deltaZ = ((dragState.screenX.x * screenDeltaY - dragState.screenX.y * screenDeltaX) / determinant)
      * DRAG_AXIS_SAMPLE_METERS;
    const projectedDelta = viewerDeltaToProjectedDelta(
      deltaX,
      deltaZ,
      activeDraft,
      projectedCRS,
      lengthUnitScale,
    );
    updateDraft({
      eastings: round2(dragState.startDraft.eastings + projectedDelta.eastings),
      northings: round2(dragState.startDraft.northings + projectedDelta.northings),
    });
  }, [activeDraft, lengthUnitScale, projectedCRS, updateDraft]);

  const handlePointerUp = useCallback((e: React.PointerEvent<Element>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_err) {
      /* cleanup — safe to ignore: pointer already released by browser */
    }
  }, []);

  const handleReset = useCallback(() => {
    beginDraft(modelId, baseMapConversion);
  }, [baseMapConversion, beginDraft, modelId]);

  const handleApply = useCallback(() => {
    if (!dirty) return;
    setGeorefFields(modelId, 'mapConversion', [
      { field: 'eastings', value: activeDraft.eastings, oldValue: baseMapConversion.eastings },
      { field: 'northings', value: activeDraft.northings, oldValue: baseMapConversion.northings },
      { field: 'orthogonalHeight', value: activeDraft.orthogonalHeight, oldValue: baseMapConversion.orthogonalHeight },
      // MapConversion's cos/sin pair is optional in the IFC schema; fall back
      // to the identity (1, 0) so the diff against an un-rotated source picks
      // up the new explicit rotation rather than skipping the field entirely.
      { field: 'xAxisAbscissa', value: activeDraft.xAxisAbscissa, oldValue: baseMapConversion.xAxisAbscissa ?? 1 },
      { field: 'xAxisOrdinate', value: activeDraft.xAxisOrdinate, oldValue: baseMapConversion.xAxisOrdinate ?? 0 },
    ]);
    resetDraft();
    toast.success('Georeference placement updated');
  }, [activeDraft, baseMapConversion, dirty, modelId, resetDraft, setGeorefFields]);

  const nudge = useCallback((eastDelta: number, northDelta: number) => {
    updateDraft({
      eastings: round2(activeDraft.eastings + eastDelta),
      northings: round2(activeDraft.northings + northDelta),
    });
  }, [activeDraft.eastings, activeDraft.northings, updateDraft]);

  const nudgeHeight = useCallback((heightDelta: number) => {
    updateDraft({
      orthogonalHeight: round2(activeDraft.orthogonalHeight + heightDelta),
    });
  }, [activeDraft.orthogonalHeight, updateDraft]);

  const nudgeRotation = useCallback((angleDelta: number) => {
    updateDraft(axisFromAngleDegrees(activeAngle + angleDelta));
  }, [activeAngle, updateDraft]);

  const handleClose = useCallback(() => {
    setEditMode(false);
    setActiveTool('select');
    resetDraft();
  }, [resetDraft, setActiveTool, setEditMode]);

  if (!editMode || !projection) return null;

  const planePoints = projection.planeCorners.map((point) => `${point.x},${point.y}`).join(' ');
  const minPlaneX = Math.min(...projection.planeCorners.map((point) => point.x));
  const maxPlaneX = Math.max(...projection.planeCorners.map((point) => point.x));
  const minPlaneY = Math.min(...projection.planeCorners.map((point) => point.y));
  const maxPlaneY = Math.max(...projection.planeCorners.map((point) => point.y));
  const hitPadding = 16;
  const [c0, c1, c2, c3] = projection.planeCorners;
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
          <polygon
            points={planePoints}
            fill="url(#cesium-placement-grid)"
            stroke="rgb(45 212 191)"
            strokeWidth="3"
            opacity="0.92"
            pointerEvents="none"
          >
            <title>Drag to move Eastings/Northings</title>
          </polygon>
          <line
            x1={xAxisStart.x}
            y1={xAxisStart.y}
            x2={xAxisEnd.x}
            y2={xAxisEnd.y}
            stroke="white"
            strokeWidth="2"
            opacity="0.8"
            pointerEvents="none"
          />
          <line
            x1={zAxisStart.x}
            y1={zAxisStart.y}
            x2={zAxisEnd.x}
            y2={zAxisEnd.y}
            stroke="white"
            strokeWidth="2"
            opacity="0.8"
            pointerEvents="none"
          />
          <text
            x={projection.center.x}
            y={maxPlaneY + 22}
            textAnchor="middle"
            fill="rgb(153 246 228)"
            fontSize="11"
            fontFamily="monospace"
            fontWeight="700"
            pointerEvents="none"
          >
            DRAG XY
          </text>
          <line
            x1={projection.center.x}
            y1={projection.center.y}
            x2={projection.heightTip.x}
            y2={projection.heightTip.y}
            stroke="rgb(251 191 36)"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.95"
          />
          <circle
            cx={projection.heightTip.x}
            cy={projection.heightTip.y}
            r="10"
            fill="rgb(251 191 36)"
            stroke="white"
            strokeWidth="2"
            cursor="grab"
            pointerEvents="none"
          >
            <title>Drag to change OrthogonalHeight</title>
          </circle>
          <circle
            cx={projection.center.x}
            cy={projection.center.y}
            r="4"
            fill="white"
            stroke="rgb(45 212 191)"
            strokeWidth="2"
          />
        </g>
      </svg>

      <button
        type="button"
        aria-label="Drag Eastings and Northings"
        className="absolute z-[21] cursor-grab bg-transparent active:cursor-grabbing"
        style={{
          left: minPlaneX - hitPadding,
          top: minPlaneY - hitPadding,
          width: Math.max(56, maxPlaneX - minPlaneX + hitPadding * 2),
          height: Math.max(56, maxPlaneY - minPlaneY + hitPadding * 2),
        }}
        onPointerDown={handlePlanePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <button
        type="button"
        aria-label="Drag OrthogonalHeight"
        className="absolute z-[22] cursor-grab rounded-full bg-transparent active:cursor-grabbing"
        style={{
          left: projection.heightTip.x - 18,
          top: projection.heightTip.y - 18,
          width: 36,
          height: 36,
        }}
        onPointerDown={handleHeightPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      <div className="absolute right-4 top-16 z-30 w-[320px] border border-teal-300/40 bg-zinc-950/85 p-3 font-mono text-[10px] text-zinc-100 shadow-2xl backdrop-blur-md">
        <div className="mb-2 flex items-center gap-2">
          <Move className="h-3.5 w-3.5 text-teal-300" />
          <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-200">Move Georeference</span>
          <button
            type="button"
            onClick={handleClose}
            className="ml-auto rounded-sm p-1 text-zinc-400 hover:bg-white/10 hover:text-white"
            aria-label="Close georeference move mode"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-1 border-y border-white/10 py-2">
          <Metric label="Delta E" value={formatSigned(deltaE, mapUnitSuffix)} accent="text-teal-200" />
          <Metric label="Delta N" value={formatSigned(deltaN, mapUnitSuffix)} accent="text-teal-200" />
          <Metric label="Delta Z" value={formatSigned(deltaH, mapUnitSuffix)} accent="text-amber-200" />
          <Metric label="Delta R" value={formatSigned(deltaAngle, 'deg')} accent="text-fuchsia-200" />
        </div>

        <div className="mt-2 space-y-1 text-zinc-400">
          <div className="pb-1 text-[9px] leading-snug text-zinc-500">
            Drag the teal pad to move Eastings/Northings. Drag the yellow knob to change height.
          </div>
          <PreviewRow label="Eastings" value={`${activeDraft.eastings.toFixed(2)} ${mapUnitSuffix}`} />
          <PreviewRow label="Northings" value={`${activeDraft.northings.toFixed(2)} ${mapUnitSuffix}`} />
          <PreviewRow label="OrthogonalHeight" value={`${activeDraft.orthogonalHeight.toFixed(2)} ${mapUnitSuffix}`} />
          <PreviewRow label="XAxis angle" value={`${activeAngle.toFixed(2)} deg`} />
        </div>

        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-[9px]">
          <span className="text-zinc-500">Nudge 1 m</span>
          <button
            type="button"
            onClick={() => nudge(0, nudgeStep)}
            className="border border-white/10 px-2 py-1 text-teal-200 hover:border-teal-300 hover:bg-teal-300/10"
            aria-label="Nudge north"
          >
            N+
          </button>
          <span />
          <button
            type="button"
            onClick={() => nudge(-nudgeStep, 0)}
            className="border border-white/10 px-2 py-1 text-teal-200 hover:border-teal-300 hover:bg-teal-300/10"
            aria-label="Nudge west"
          >
            E-
          </button>
          <button
            type="button"
            onClick={() => nudge(nudgeStep, 0)}
            className="border border-white/10 px-2 py-1 text-teal-200 hover:border-teal-300 hover:bg-teal-300/10"
            aria-label="Nudge east"
          >
            E+
          </button>
          <button
            type="button"
            onClick={() => nudge(0, -nudgeStep)}
            className="border border-white/10 px-2 py-1 text-teal-200 hover:border-teal-300 hover:bg-teal-300/10"
            aria-label="Nudge south"
          >
            N-
          </button>
        </div>

        <div className="mt-2 flex items-center gap-1 text-[9px]">
          <span className="mr-auto text-zinc-500">Height</span>
          <button
            type="button"
            onClick={() => nudgeHeight(-nudgeStep)}
            className="border border-white/10 px-2 py-1 text-amber-200 hover:border-amber-300 hover:bg-amber-300/10"
            aria-label="Nudge height down"
          >
            Z-
          </button>
          <button
            type="button"
            onClick={() => nudgeHeight(nudgeStep)}
            className="border border-white/10 px-2 py-1 text-amber-200 hover:border-amber-300 hover:bg-amber-300/10"
            aria-label="Nudge height up"
          >
            Z+
          </button>
        </div>

        <div className="mt-2 flex items-center gap-1 text-[9px]">
          <span className="mr-auto text-zinc-500">Rotate</span>
          <button
            type="button"
            onClick={() => nudgeRotation(-1)}
            className="border border-white/10 px-2 py-1 text-fuchsia-200 hover:border-fuchsia-300 hover:bg-fuchsia-300/10"
            aria-label="Rotate negative one degree"
          >
            R-
          </button>
          <button
            type="button"
            onClick={() => nudgeRotation(1)}
            className="border border-white/10 px-2 py-1 text-fuchsia-200 hover:border-fuchsia-300 hover:bg-fuchsia-300/10"
            aria-label="Rotate positive one degree"
          >
            R+
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleApply}
            disabled={!dirty}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1.5 border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide',
              dirty
                ? 'border-teal-300 bg-teal-300 text-zinc-950 hover:bg-teal-200'
                : 'border-white/10 text-zinc-500',
            )}
          >
            <Check className="h-3 w-3" />
            Set as georeference
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty}
            className="inline-flex items-center justify-center gap-1 border border-white/10 px-2 py-1.5 text-[10px] uppercase tracking-wide text-zinc-300 hover:bg-white/10 disabled:text-zinc-600"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>
      </div>
    </>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div className="text-[8px] uppercase tracking-[0.16em] text-zinc-500">{label}</div>
      <div className={cn('mt-0.5 whitespace-nowrap text-[10px]', accent)}>{value}</div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="text-zinc-100">{value}</span>
    </div>
  );
}
