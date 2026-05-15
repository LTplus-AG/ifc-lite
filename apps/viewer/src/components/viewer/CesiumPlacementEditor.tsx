/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, GripVertical, Move, RotateCcw, X } from 'lucide-react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { toast } from '@/components/ui/toast';
import { getGlobalRenderer } from '@/hooks/useBCF';
import {
  closestYOnVerticalLineFromRay,
  getMapUnitScale,
  intersectRayWithHorizontalPlane,
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
// rather than projected screen-axis pixels. Screen-space linearisations alias
// badly when the gizmo plane is near-edge-on to the camera (det → 0), which
// previously produced "huge jumps" for XY drag at oblique tilts. Ray-based
// math stays exact at any camera angle short of full grazing.
type DragState =
  | {
      mode: 'height';
      startDraft: CesiumPlacementDraft;
      anchorX: number;
      anchorZ: number;
      startWorldY: number;
    }
  | {
      mode: 'xy';
      startDraft: CesiumPlacementDraft;
      planeY: number;
      startHit: WorldPoint;
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

interface PointerRay {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

/**
 * Resolve a CSS-pixel pointer event into a world-space ray via the renderer
 * camera. Returns null when the renderer/canvas isn't mounted yet.
 *
 * Note: `unprojectToRay` consumes drawing-buffer pixels, so we rescale the
 * CSS-pixel pointer coordinates by `canvas.width / rect.width` (and the same
 * for height). Mixing CSS and drawing-buffer units silently scales the ray
 * direction on high-DPI displays — the previous gizmo bug-pattern.
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

const PANEL_WIDTH = 320;
const PANEL_MARGIN = 16;
const PANEL_STORAGE_KEY = 'ifc-lite:cesium-placement-panel:v1';

interface PanelPreferences {
  x?: number;
  y?: number;
  collapsed?: boolean;
}

function readPanelPreferences(): PanelPreferences {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PanelPreferences;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('[CesiumPlacementEditor] failed to read panel prefs', err);
    return {};
  }
}

function writePanelPreferences(prefs: PanelPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[CesiumPlacementEditor] failed to persist panel prefs', err);
  }
}

interface ContainerBox {
  width: number;
  height: number;
}

function clampPanelPosition(
  x: number,
  y: number,
  panelHeight: number,
  container: ContainerBox,
): ScreenPoint {
  // ViewportContainer is the offset parent — its width is the panel-group
  // centre column, not the full window. Clamp inside its rect, leaving
  // PANEL_MARGIN on every edge.
  const maxX = Math.max(PANEL_MARGIN, container.width - PANEL_WIDTH - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, container.height - panelHeight - PANEL_MARGIN);
  return {
    x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
    y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
  };
}

function defaultPanelPosition(panelHeight: number, container: ContainerBox): ScreenPoint {
  return {
    x: Math.max(PANEL_MARGIN, container.width - PANEL_WIDTH - PANEL_MARGIN),
    y: Math.max(PANEL_MARGIN, container.height - panelHeight - PANEL_MARGIN),
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
    planeCorners: [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  } | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  // Panel chrome state: position (draggable, persisted), collapse, and the
  // header-drag offset captured on pointer-down. Position is lazy-initialised
  // from localStorage so we don't flicker through a centred mount.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelCollapsed, setPanelCollapsed] = useState<boolean>(
    () => readPanelPreferences().collapsed ?? false,
  );
  const [panelPosition, setPanelPosition] = useState<ScreenPoint | null>(() => {
    const prefs = readPanelPreferences();
    if (typeof prefs.x === 'number' && typeof prefs.y === 'number') {
      return { x: prefs.x, y: prefs.y };
    }
    return null;
  });
  const panelDragRef = useRef<{ offsetX: number; offsetY: number; pointerId: number } | null>(null);

  // Resolve the panel's positioning container (its `offsetParent`, which is
  // ViewportContainer's relative root). We measure it for default placement,
  // clamping, and drag math so the panel stays inside the centre viewport
  // column instead of being computed against the whole window.
  const getContainerBox = useCallback((): ContainerBox | null => {
    const parent = panelRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return null;
    const rect = parent.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, []);

  const getContainerOrigin = useCallback((): { left: number; top: number } | null => {
    const parent = panelRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return null;
    const rect = parent.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }, []);

  // When a saved position exists, clamp it on mount and after resizes so
  // it stays inside the viewport container. When no saved position exists
  // we leave panelPosition === null and rely on CSS right/bottom anchoring
  // for the default bottom-right placement, which avoids a measure-first
  // flicker and works even when the offsetParent isn't measurable yet.
  useLayoutEffect(() => {
    const apply = () => {
      const container = getContainerBox();
      if (!container) return;
      const height = panelRef.current?.offsetHeight ?? 280;
      setPanelPosition((prev) => {
        if (prev === null) return null;
        return clampPanelPosition(prev.x, prev.y, height, container);
      });
    };
    apply();
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [panelCollapsed, getContainerBox]);

  useEffect(() => {
    if (!panelPosition) return;
    writePanelPreferences({ x: panelPosition.x, y: panelPosition.y, collapsed: panelCollapsed });
  }, [panelPosition, panelCollapsed]);

  const handlePanelHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore drags that originate inside the header's action buttons —
    // those have their own click handlers.
    if ((e.target as HTMLElement).closest('[data-panel-action]')) return;
    if (!panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    panelDragRef.current = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      pointerId: e.pointerId,
    };
  }, []);

  const handlePanelHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const container = getContainerBox();
    const origin = getContainerOrigin();
    if (!container || !origin) return;
    const height = panelRef.current?.offsetHeight ?? 280;
    // Translate pointer-client coords into container-local coords, then clamp.
    const localX = e.clientX - drag.offsetX - origin.left;
    const localY = e.clientY - drag.offsetY - origin.top;
    setPanelPosition(clampPanelPosition(localX, localY, height, container));
  }, [getContainerBox, getContainerOrigin]);

  const handlePanelHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    panelDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_err) {
      /* cleanup — safe to ignore: pointer already released by browser */
    }
  }, []);

  const togglePanelCollapsed = useCallback(() => {
    setPanelCollapsed((prev) => !prev);
  }, []);

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
        if (center && heightTip && c0 && c1 && c2 && c3) {
          setProjection({
            center,
            heightTip,
            planeCorners: [c0, c1, c2, c3],
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
    const ray = rayFromPointerEvent(e.clientX, e.clientY);
    if (!ray) return;
    const startWorldY = closestYOnVerticalLineFromRay(ray, anchorWorld.x, anchorWorld.z);
    if (startWorldY === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      mode: 'height',
      startDraft: activeDraft,
      anchorX: anchorWorld.x,
      anchorZ: anchorWorld.z,
      startWorldY,
    };
  }, [activeDraft, anchorWorld.x, anchorWorld.z, projection]);

  const handlePlanePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!projection) return;
    const ray = rayFromPointerEvent(e.clientX, e.clientY);
    if (!ray) return;
    const startHit = intersectRayWithHorizontalPlane(ray, anchorWorld.y);
    if (!startHit) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      mode: 'xy',
      startDraft: activeDraft,
      planeY: anchorWorld.y,
      startHit,
    };
  }, [activeDraft, anchorWorld.y, projection]);

  const handlePointerMove = useCallback((e: React.PointerEvent<Element>) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    e.preventDefault();
    e.stopPropagation();

    const ray = rayFromPointerEvent(e.clientX, e.clientY);
    if (!ray) return;

    if (dragState.mode === 'height') {
      const worldY = closestYOnVerticalLineFromRay(ray, dragState.anchorX, dragState.anchorZ);
      if (worldY === null) return;
      const deltaMeters = worldY - dragState.startWorldY;
      updateDraft({
        orthogonalHeight: round2(
          dragState.startDraft.orthogonalHeight
            + metersToMapUnits(deltaMeters, projectedCRS, lengthUnitScale),
        ),
      });
      return;
    }

    const hit = intersectRayWithHorizontalPlane(ray, dragState.planeY);
    if (!hit) return;
    const deltaX = hit.x - dragState.startHit.x;
    const deltaZ = hit.z - dragState.startHit.z;
    // The horizontal-plane hit gives the world-space displacement directly;
    // viewerDeltaToProjectedDelta then applies the file's xAxis rotation and
    // unit scale to express it in Eastings/Northings.
    const projectedDelta = viewerDeltaToProjectedDelta(
      deltaX,
      deltaZ,
      dragState.startDraft,
      projectedCRS,
      lengthUnitScale,
    );
    updateDraft({
      eastings: round2(dragState.startDraft.eastings + projectedDelta.eastings),
      northings: round2(dragState.startDraft.northings + projectedDelta.northings),
    });
  }, [lengthUnitScale, projectedCRS, updateDraft]);

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

  if (!editMode) return null;

  // The gizmo overlay (SVG axes + drag pads) renders only once we have a
  // valid projection of the anchor; the side panel renders unconditionally
  // so the user can still nudge, apply, or close even if the gizmo is
  // off-screen or behind the camera.
  const gizmoVisuals = projection
    ? (() => {
        const planePoints = projection.planeCorners
          .map((point) => `${point.x},${point.y}`)
          .join(' ');
        const minPlaneX = Math.min(...projection.planeCorners.map((p) => p.x));
        const maxPlaneX = Math.max(...projection.planeCorners.map((p) => p.x));
        const minPlaneY = Math.min(...projection.planeCorners.map((p) => p.y));
        const maxPlaneY = Math.max(...projection.planeCorners.map((p) => p.y));
        const hitPadding = 16;
        const [c0, c1, c2, c3] = projection.planeCorners;
        const xAxisStart = { x: (c0.x + c3.x) / 2, y: (c0.y + c3.y) / 2 };
        const xAxisEnd = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
        const zAxisStart = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
        const zAxisEnd = { x: (c2.x + c3.x) / 2, y: (c2.y + c3.y) / 2 };
        return {
          planePoints,
          minPlaneX,
          maxPlaneX,
          minPlaneY,
          maxPlaneY,
          hitPadding,
          xAxisStart,
          xAxisEnd,
          zAxisStart,
          zAxisEnd,
        };
      })()
    : null;

  const renderGizmo = () => {
    if (!gizmoVisuals || !projection) return null;
    const {
      planePoints,
      minPlaneX,
      maxPlaneX,
      minPlaneY,
      maxPlaneY,
      hitPadding,
      xAxisStart,
      xAxisEnd,
      zAxisStart,
      zAxisEnd,
    } = gizmoVisuals;
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
      </>
    );
  };

  return (
    <>
      {renderGizmo()}

      <div
        ref={panelRef}
        className={cn(
          'absolute z-30 select-none border-2 border-zinc-900 dark:border-zinc-100',
          'bg-white text-zinc-900 dark:bg-black dark:text-zinc-100 font-mono',
        )}
        style={{
          left: panelPosition?.x ?? 0,
          top: panelPosition?.y ?? 0,
          width: PANEL_WIDTH,
          visibility: panelPosition ? 'visible' : 'hidden',
          boxShadow: '4px 4px 0px 0px rgba(0,0,0,0.35)',
        }}
      >
        {/* Header — drag handle, title, dirty indicator, collapse/close */}
        <div
          className={cn(
            'flex items-center gap-2 px-2.5 py-2 border-b-2 border-zinc-900 dark:border-zinc-100',
            'bg-zinc-50 dark:bg-zinc-950 cursor-grab active:cursor-grabbing touch-none',
          )}
          onPointerDown={handlePanelHeaderPointerDown}
          onPointerMove={handlePanelHeaderPointerMove}
          onPointerUp={handlePanelHeaderPointerUp}
          onPointerCancel={handlePanelHeaderPointerUp}
          role="toolbar"
          aria-label="Move georeference panel header"
        >
          <GripVertical className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-600" aria-hidden />
          <Move className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <span className="text-[11px] font-bold uppercase tracking-[0.18em]">
            Move Georef
          </span>
          {dirty && (
            <span
              className="h-1.5 w-1.5 bg-amber-500"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              data-panel-action
              onClick={togglePanelCollapsed}
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center border border-transparent',
                'hover:bg-zinc-200 dark:hover:bg-zinc-800',
              )}
              aria-label={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
              aria-expanded={!panelCollapsed}
            >
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 transition-transform',
                  panelCollapsed && '-rotate-90',
                )}
              />
            </button>
            <button
              type="button"
              data-panel-action
              onClick={handleClose}
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center border border-transparent',
                'hover:bg-zinc-200 dark:hover:bg-zinc-800',
              )}
              aria-label="Close georeference move mode"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {!panelCollapsed && (
          <div className="p-3 text-[10px]">
            <div className="grid grid-cols-4 gap-1 border-b border-zinc-200 dark:border-zinc-800 pb-2">
              <Metric
                label="Delta E"
                value={formatSigned(deltaE, mapUnitSuffix)}
                accent="text-emerald-700 dark:text-emerald-300"
              />
              <Metric
                label="Delta N"
                value={formatSigned(deltaN, mapUnitSuffix)}
                accent="text-emerald-700 dark:text-emerald-300"
              />
              <Metric
                label="Delta Z"
                value={formatSigned(deltaH, mapUnitSuffix)}
                accent="text-amber-700 dark:text-amber-300"
              />
              <Metric
                label="Delta R"
                value={formatSigned(deltaAngle, 'deg')}
                accent="text-fuchsia-700 dark:text-fuchsia-300"
              />
            </div>

            <div className="mt-2 space-y-1">
              <div className="pb-1 text-[9px] leading-snug text-zinc-500 dark:text-zinc-400">
                Drag the pad on the model to move Eastings/Northings. Drag the
                knob to change height.
              </div>
              <PreviewRow
                label="Eastings"
                value={`${activeDraft.eastings.toFixed(2)} ${mapUnitSuffix}`}
              />
              <PreviewRow
                label="Northings"
                value={`${activeDraft.northings.toFixed(2)} ${mapUnitSuffix}`}
              />
              <PreviewRow
                label="OrthogonalHeight"
                value={`${activeDraft.orthogonalHeight.toFixed(2)} ${mapUnitSuffix}`}
              />
              <PreviewRow label="XAxis angle" value={`${activeAngle.toFixed(2)} deg`} />
            </div>

            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-[9px]">
              <span className="text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                Nudge 1 m
              </span>
              <NudgeButton onClick={() => nudge(0, nudgeStep)} aria-label="Nudge north">
                N+
              </NudgeButton>
              <span />
              <NudgeButton onClick={() => nudge(-nudgeStep, 0)} aria-label="Nudge west">
                E-
              </NudgeButton>
              <NudgeButton onClick={() => nudge(nudgeStep, 0)} aria-label="Nudge east">
                E+
              </NudgeButton>
              <NudgeButton onClick={() => nudge(0, -nudgeStep)} aria-label="Nudge south">
                N-
              </NudgeButton>
            </div>

            <div className="mt-2 flex items-center gap-1 text-[9px]">
              <span className="mr-auto text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                Height
              </span>
              <NudgeButton
                onClick={() => nudgeHeight(-nudgeStep)}
                tone="amber"
                aria-label="Nudge height down"
              >
                Z-
              </NudgeButton>
              <NudgeButton
                onClick={() => nudgeHeight(nudgeStep)}
                tone="amber"
                aria-label="Nudge height up"
              >
                Z+
              </NudgeButton>
            </div>

            <div className="mt-2 flex items-center gap-1 text-[9px]">
              <span className="mr-auto text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                Rotate
              </span>
              <NudgeButton
                onClick={() => nudgeRotation(-1)}
                tone="fuchsia"
                aria-label="Rotate negative one degree"
              >
                R-
              </NudgeButton>
              <NudgeButton
                onClick={() => nudgeRotation(1)}
                tone="fuchsia"
                aria-label="Rotate positive one degree"
              >
                R+
              </NudgeButton>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleApply}
                disabled={!dirty}
                className={cn(
                  'inline-flex flex-1 items-center justify-center gap-1.5 border-2 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors',
                  dirty
                    ? 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:border-emerald-700 dark:border-emerald-500 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400 dark:hover:border-emerald-400'
                    : 'border-zinc-300 bg-zinc-100 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600 cursor-not-allowed',
                )}
              >
                <Check className="h-3 w-3" />
                Set as georeference
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={!dirty}
                className={cn(
                  'inline-flex items-center justify-center gap-1 border-2 px-2 py-1.5 text-[10px] uppercase tracking-wide transition-colors',
                  dirty
                    ? 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'
                    : 'border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-900 dark:bg-zinc-950 dark:text-zinc-600 cursor-not-allowed',
                )}
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div className="text-[8px] uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      <div className={cn('mt-0.5 whitespace-nowrap text-[10px] font-semibold', accent)}>
        {value}
      </div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  );
}

type NudgeButtonProps = {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'emerald' | 'amber' | 'fuchsia';
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>;

function NudgeButton({ children, onClick, tone = 'emerald', ...rest }: NudgeButtonProps) {
  const toneClass = {
    emerald:
      'text-emerald-700 hover:bg-emerald-50 hover:border-emerald-600 dark:text-emerald-300 dark:hover:bg-emerald-950 dark:hover:border-emerald-400',
    amber:
      'text-amber-700 hover:bg-amber-50 hover:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950 dark:hover:border-amber-400',
    fuchsia:
      'text-fuchsia-700 hover:bg-fuchsia-50 hover:border-fuchsia-600 dark:text-fuchsia-300 dark:hover:bg-fuchsia-950 dark:hover:border-fuchsia-400',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'border-2 border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900',
        'px-2 py-1 font-bold tracking-wider transition-colors',
        toneClass,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
