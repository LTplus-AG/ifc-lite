/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Home,
  ZoomIn,
  ZoomOut,
  Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { useIfc } from '@/hooks/useIfc';
import { emitCameraInteracted } from '@/lib/tours/events';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { cn } from '@/lib/utils';
import { collectPhysicalEntityIds, countPhysicalObjects } from '@/lib/physical-objects';
import { ViewCube, type ViewCubeRef } from './ViewCube';
import { AxisHelper, type AxisHelperRef } from './AxisHelper';
import { BasepointOverlay } from './BasepointOverlay';
import { PointCloudPanel } from './PointCloudPanel';
import { Crosshair } from 'lucide-react';

/**
 * Overlay chrome drawn on top of the 3D viewport.
 *
 * The three `hide*` props exist for the embed (`?hideViewCube=`, `?hideAxis=`,
 * `?hideScale=`): a host iframe is often too small for the full chrome. They
 * default to `false`, so the standalone viewer is unaffected.
 */
export function ViewportOverlays({
  hideViewCube = false,
  hideAxis = false,
  hideScale = false,
}: { hideViewCube?: boolean; hideAxis?: boolean; hideScale?: boolean } = {}) {
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const ghostExceptEntities = useViewerStore((s) => s.ghostExceptEntities);
  const basketPresentationVisible = useViewerStore((s) => s.basketPresentationVisible);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const isMobile = useViewerStore((s) => s.isMobile);
  const setOnCameraRotationChange = useViewerStore((s) => s.setOnCameraRotationChange);
  const setOnScaleChange = useViewerStore((s) => s.setOnScaleChange);
  const { ifcDataStore, models } = useIfc();

  // Cesium state
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);

  // Use refs for rotation to avoid re-renders - ViewCube updates itself directly
  const cameraRotationRef = useRef({ azimuth: 45, elevation: 25 });
  const viewCubeRef = useRef<ViewCubeRef | null>(null);
  const axisHelperRef = useRef<AxisHelperRef | null>(null);
  const lastCubeGestureEmitRef = useRef(0);

  // Local state for scale - updated via callback, no global re-renders
  const [scale, setScale] = useState(10);
  const lastScaleRef = useRef(10);

  // Register callback for real-time rotation updates - updates ViewCube directly
  useEffect(() => {
    const handleRotationChange = (rotation: { azimuth: number; elevation: number }) => {
      cameraRotationRef.current = rotation;
      // Update ViewCube directly via ref (no React re-render)
      const viewCubeRotationX = -rotation.elevation;
      const viewCubeRotationY = -rotation.azimuth;
      viewCubeRef.current?.updateRotation(viewCubeRotationX, viewCubeRotationY);
      axisHelperRef.current?.updateRotation(viewCubeRotationX, viewCubeRotationY);
    };
    setOnCameraRotationChange(handleRotationChange);
    return () => setOnCameraRotationChange(null);
  }, [setOnCameraRotationChange]);

  // Register callback for real-time scale updates
  // Only update state if scale changed significantly (>1%) to avoid unnecessary re-renders
  useEffect(() => {
    const handleScaleChange = (newScale: number) => {
      const lastScale = lastScaleRef.current;
      // Only update if scale changed by more than 1%
      if (Math.abs(newScale - lastScale) / lastScale > 0.01) {
        lastScaleRef.current = newScale;
        setScale(newScale);
      }
    };
    setOnScaleChange(handleScaleChange);
    return () => setOnScaleChange(null);
  }, [setOnScaleChange]);

  // Get names of selected storeys. `selectedStoreys` holds raw model-space
  // expressIds (see HierarchyPanel's `setStoreysSelection`), which may belong
  // to ANY federated model, not just the active one — `ifcDataStore` only
  // tracks the active model (`modelSlice.ts`). Resolve each id through the
  // model whose own spatial hierarchy actually contains it as a storey,
  // falling back to the active store for legacy single-model mode.
  const storeyNames = selectedStoreys.size > 0 && (ifcDataStore || models.size > 0)
    ? Array.from(selectedStoreys).map((id) => {
        const ownStore = models.size > 0
          ? Array.from(models.values()).find(
              (m) => m.ifcDataStore?.spatialHierarchy?.byStorey.has(id),
            )?.ifcDataStore
          : ifcDataStore;
        return ownStore?.entities.getName(id) || `Storey #${id}`;
      })
    : null;

  // Physical objects in the loaded model — the denominator. Derived from the
  // entity index, NOT from `geometryResult.meshes`, so an object that never
  // produced geometry still shows up as "not visible" instead of vanishing
  // from both sides of the ratio. Memoised on the store identity: the walk is
  // one schema lookup per distinct type name, but the model can hold millions
  // of ids and this runs on every camera-driven re-render otherwise.
  const physicalIds = useMemo(
    () => collectPhysicalEntityIds(ifcDataStore?.entityIndex?.byType),
    [ifcDataStore],
  );

  const objectCounts = useMemo(
    () => countPhysicalObjects(physicalIds, {
      hiddenEntities,
      isolatedEntities,
      classFilter,
      ghostExceptEntities,
    }),
    [physicalIds, hiddenEntities, isolatedEntities, classFilter, ghostExceptEntities],
  );

  // Initial rotation values (ViewCube will update itself via ref)
  const initialRotationX = -cameraRotationRef.current.elevation;
  const initialRotationY = -cameraRotationRef.current.azimuth;

  const handleViewChange = useCallback((view: string) => {
    const viewMap: Record<string, 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'> = {
      top: 'top',
      bottom: 'bottom',
      front: 'front',
      back: 'back',
      left: 'left',
      right: 'right',
    };
    const mappedView = viewMap[view];
    if (mappedView && cameraCallbacks.setPresetView) {
      cameraCallbacks.setPresetView(mappedView);
      emitCameraInteracted('preset');
    }
  }, [cameraCallbacks]);

  const handleHome = useCallback(() => {
    goHomeFromStore();
  }, []);

  const handleFitAll = useCallback(() => {
    cameraCallbacks.fitAll?.();
  }, [cameraCallbacks]);

  const handleZoomIn = useCallback(() => {
    cameraCallbacks.zoomIn?.();
  }, [cameraCallbacks]);

  const handleZoomOut = useCallback(() => {
    cameraCallbacks.zoomOut?.();
  }, [cameraCallbacks]);

  // Format scale value for display
  const formatScale = (worldSize: number): string => {
    if (worldSize >= 1000) {
      return `${(worldSize / 1000).toFixed(1)}km`;
    } else if (worldSize >= 1) {
      return `${worldSize.toFixed(1)}m`;
    } else if (worldSize >= 0.1) {
      return `${(worldSize * 100).toFixed(0)}cm`;
    } else {
      return `${(worldSize * 1000).toFixed(0)}mm`;
    }
  };

  return (
    <>
      <PointCloudPanelMount />
      {/* Touch navigation stays available on mobile. On desktop BOTH toolbar
          styles carry zoom and Home from the shared camera command list
          (`toolbar/CameraCommands`) — when this guard first narrowed to
          mobile only the ribbon did, which left classic users with no zoom
          button anywhere. */}
      {isMobile && !cesiumEnabled && (
        <div
          className="absolute left-4 bottom-[15%] flex flex-col gap-1 rounded-md border bg-background/90 p-1 backdrop-blur-sm"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Home view" className="min-h-[44px] min-w-[44px]" onClick={handleHome}>
                <Home className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Home (H)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Zoom in" className="min-h-[44px] min-w-[44px]" onClick={handleZoomIn}>
                <ZoomIn className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Zoom In (+)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Zoom out" className="min-h-[44px] min-w-[44px]" onClick={handleZoomOut}>
                <ZoomOut className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Zoom Out (-)</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Hidden-object count. Reports what is WITHHELD, not a ratio: the
          number a user acts on is "what am I not seeing", and "1442 of 1446
          visible" makes them do the subtraction to find the 4 that matter.
          Passive, so an unfiltered model carries no chrome at all.

          Styled as the bottom-left scale/axis cluster is: bare text at
          `text-xs text-foreground/80`, no pill, no border, no backdrop, no
          off-palette accent. The 3D overlays along the bottom edge are
          deliberately plain, and this sits in that row. */}
      {(objectCounts.hidden > 0 || objectCounts.ghosted > 0) && (
        <div
          className={cn(
            'absolute right-4 flex flex-col items-end gap-1',
            basketPresentationVisible ? 'bottom-28' : 'bottom-4',
          )}
          role="status"
        >
          <span className="text-xs text-foreground/80 tabular-nums">
            {[
              objectCounts.hidden > 0 && `${objectCounts.hidden} hidden`,
              objectCounts.ghosted > 0 && `${objectCounts.ghosted} ghosted`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      )}

      {/* Context Info — Storey names. Top-center on mobile (URL bar steals the bottom). */}
      {storeyNames && storeyNames.length > 0 && (
        <div className={cn(
          'absolute left-1/2 -translate-x-1/2 px-4 py-2 bg-background/80 backdrop-blur-sm rounded-full border shadow-sm',
          isMobile ? 'top-4' : basketPresentationVisible ? 'bottom-28' : 'bottom-4',
        )}>
          <div className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-primary" />
            <span className="font-medium">
              {storeyNames.length === 1
                ? storeyNames[0]
                : `${storeyNames.length} storeys`}
            </span>
          </div>
        </div>
      )}

      {/* ViewCube (top-right) */}
      {!hideViewCube && (
        <div className="absolute top-6 right-6" {...tourAnchor(TOUR_ANCHORS.viewcube)}>
          <ViewCube
            ref={viewCubeRef}
            onViewChange={handleViewChange}
            onDrag={(deltaX, deltaY) => {
              cameraCallbacks.orbit?.(deltaX, deltaY);
              // Throttled: onDrag fires per pointer move.
              const now = performance.now();
              if (now - lastCubeGestureEmitRef.current > 500) {
                lastCubeGestureEmitRef.current = now;
                emitCameraInteracted('orbit');
              }
            }}
            rotationX={initialRotationX}
            rotationY={initialRotationY}
          />
        </div>
      )}

      {/* Basepoint toggle + Axis Helper + Scale Bar — desktop only; mobile keeps the viewport unobstructed.
          `hideScale`/`hideAxis` drop their own item only: the BasepointToggleButton stays reachable
          even with both set, so hiding the scene-reference readouts never hides the toggle too. */}
      {!isMobile && (
        <div className="absolute bottom-4 left-4 flex flex-col-reverse items-start gap-3">
          {!hideScale && (
            <div className="flex flex-col items-start gap-1" data-testid="viewport-scale-readout">
              <div className="h-1 w-24 bg-foreground/80 rounded-full" />
              <span className="text-xs text-foreground/80">{formatScale(scale)}</span>
            </div>
          )}
          {!hideAxis && (
            <div data-testid="viewport-axis-helper">
              <AxisHelper
                ref={axisHelperRef}
                rotationX={initialRotationX}
                rotationY={initialRotationY}
              />
            </div>
          )}
          <BasepointToggleButton />
        </div>
      )}

      {/* Per-model IFC (0,0,0) markers — toggled via BasepointToggleButton.
          Hidden by default; component returns null when the toggle is off. */}
      <BasepointOverlay />
    </>
  );
}

/**
 * Toggle for the per-model IFC-origin overlay. Sits next to the AxisHelper so
 * it's discoverable in the same "scene reference" cluster.
 */
function BasepointToggleButton() {
  const showModelBasepoints = useViewerStore((s) => s.showModelBasepoints);
  const toggleShowModelBasepoints = useViewerStore((s) => s.toggleShowModelBasepoints);
  const modelCount = useViewerStore((s) => s.models.size);
  if (modelCount === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleShowModelBasepoints}
          aria-label={showModelBasepoints ? 'Hide model basepoints' : 'Show model basepoints'}
          className={cn(
            'h-6 w-6 inline-flex items-center justify-center border transition-colors',
            showModelBasepoints
              ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
              : 'border-zinc-300 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/80 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
          aria-pressed={showModelBasepoints}
        >
          <Crosshair className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {showModelBasepoints ? 'Hide model basepoints' : 'Show model basepoints (IFC 0,0,0)'}
      </TooltipContent>
    </Tooltip>
  );
}


/**
 * Tiny indirection so the panel can subscribe to its own slice without
 * pulling extra state into the parent overlay component.
 */
function PointCloudPanelMount() {
  const count = useViewerStore((s) => s.pointCloudAssetCount);
  // BIM↔scan deviation is a CROSS-MODEL operation: the point cloud is one
  // federated model, the BIM mesh is another. `renderer.computeDeviations()`
  // builds its BVH from EVERY mesh in the scene (`collectAllSceneMeshes`),
  // so the compute button must appear whenever ANY loaded model contributes
  // triangles — not just the active one. Gating on `s.geometryResult` (the
  // ACTIVE model's result) hid the button whenever the point cloud was the
  // active model (its synthetic geometryResult has totalTriangles === 0),
  // which is exactly the common case — so deviation could never be computed
  // and the colour mode showed every point at the ramp centre (grey). Sum
  // across all loaded models to mirror the scene the BVH is actually built from.
  const triangleCount = useViewerStore((s) => {
    let total = 0;
    for (const m of s.models.values()) total += m.geometryResult?.totalTriangles ?? 0;
    return total;
  });
  return <PointCloudPanel assetCount={count} triangleCount={triangleCount} />;
}
