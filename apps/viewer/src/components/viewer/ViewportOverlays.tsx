/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState, useRef } from 'react';
import {
  Home,
  ZoomIn,
  ZoomOut,
  Layers,
  Globe2,
  Mountain,
  Building2,
  Satellite,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import type { CesiumDataSource } from '@/store/slices/cesiumSlice';
import { goHomeFromStore } from '@/store/homeView';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { isTauri } from '@/lib/platform';
import { ViewCube, type ViewCubeRef } from './ViewCube';
import { AxisHelper, type AxisHelperRef } from './AxisHelper';
import { PointCloudPanel } from './PointCloudPanel';

const isDesktop = isTauri();

export function ViewportOverlays({ hideViewCube = false }: { hideViewCube?: boolean } = {}) {
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const basketPresentationVisible = useViewerStore((s) => s.basketPresentationVisible);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const isMobile = useViewerStore((s) => s.isMobile);
  const setOnCameraRotationChange = useViewerStore((s) => s.setOnCameraRotationChange);
  const setOnScaleChange = useViewerStore((s) => s.setOnScaleChange);
  const { ifcDataStore, geometryResult } = useIfc();

  // Cesium state
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const cesiumDataSource = useViewerStore((s) => s.cesiumDataSource);
  const setCesiumDataSource = useViewerStore((s) => s.setCesiumDataSource);
  const cesiumTerrainEnabled = useViewerStore((s) => s.cesiumTerrainEnabled);
  const setCesiumTerrainEnabled = useViewerStore((s) => s.setCesiumTerrainEnabled);
  const toggleCesium = useViewerStore((s) => s.toggleCesium);

  // Use refs for rotation to avoid re-renders - ViewCube updates itself directly
  const cameraRotationRef = useRef({ azimuth: 45, elevation: 25 });
  const viewCubeRef = useRef<ViewCubeRef | null>(null);
  const axisHelperRef = useRef<AxisHelperRef | null>(null);

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

  // Get names of selected storeys
  const storeyNames = selectedStoreys.size > 0 && ifcDataStore
    ? Array.from(selectedStoreys).map(id => 
        ifcDataStore.entities.getName(id) || `Storey #${id}`
      )
    : null;

  // Calculate visible count considering visibility filters
  const totalCount = geometryResult?.meshes?.length ?? 0;
  let visibleCount = totalCount;
  if (isolatedEntities !== null) {
    visibleCount = isolatedEntities.size;
  } else if (hiddenEntities.size > 0) {
    visibleCount = totalCount - hiddenEntities.size;
  }

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
      {/* Bottom-right: Cesium settings overlay OR Navigation controls (Cesium is web-only) */}
      {cesiumEnabled && !isDesktop ? (
        <CesiumSettingsOverlay
          dataSource={cesiumDataSource}
          onDataSourceChange={setCesiumDataSource}
          terrainEnabled={cesiumTerrainEnabled}
          onTerrainChange={setCesiumTerrainEnabled}
          onClose={toggleCesium}
        />
      ) : (
        <div
          className={cn(
            'absolute flex flex-col gap-1 bg-background/90 backdrop-blur-sm border p-1',
            // Mobile: bottom-left at ~15% up from lower edge — thumb-reachable on
            // portrait phones and well clear of the URL bar. Tight radii + flat
            // background match the codebase's brutalist panel-chrome vocabulary.
            isMobile ? 'left-4 bottom-[15%] rounded-md' : 'bottom-4 right-4 rounded-lg shadow-sm',
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className={cn(isMobile && 'min-h-[44px] min-w-[44px]')} onClick={handleHome}>
                <Home className={cn(isMobile ? 'h-5 w-5' : 'h-4 w-4')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Home (H)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className={cn(isMobile && 'min-h-[44px] min-w-[44px]')} onClick={handleZoomIn}>
                <ZoomIn className={cn(isMobile ? 'h-5 w-5' : 'h-4 w-4')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Zoom In (+)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className={cn(isMobile && 'min-h-[44px] min-w-[44px]')} onClick={handleZoomOut}>
                <ZoomOut className={cn(isMobile ? 'h-5 w-5' : 'h-4 w-4')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Zoom Out (-)</TooltipContent>
          </Tooltip>
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
        <div className="absolute top-6 right-6">
          <ViewCube
            ref={viewCubeRef}
            onViewChange={handleViewChange}
            onDrag={(deltaX, deltaY) => cameraCallbacks.orbit?.(deltaX, deltaY)}
            rotationX={initialRotationX}
            rotationY={initialRotationY}
          />
        </div>
      )}

      {/* Axis Helper + Scale Bar — desktop only; mobile keeps the viewport unobstructed */}
      {!isMobile && (
        <>
          <div className="absolute bottom-16 left-4">
            <AxisHelper
              ref={axisHelperRef}
              rotationX={initialRotationX}
              rotationY={initialRotationY}
            />
          </div>
          <div className="absolute bottom-4 left-4 flex flex-col items-start gap-1">
            <div className="h-1 w-24 bg-foreground/80 rounded-full" />
            <span className="text-xs text-foreground/80">{formatScale(scale)}</span>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Cesium Settings Overlay — replaces nav controls when Cesium is on  */
/* ------------------------------------------------------------------ */

const DATA_SOURCES: { value: CesiumDataSource; label: string; icon: typeof Globe2 }[] = [
  { value: 'google-photorealistic', label: 'Google 3D', icon: Globe2 },
  { value: 'osm-buildings', label: 'OSM', icon: Building2 },
  { value: 'bing-aerial', label: 'Aerial', icon: Satellite },
];

function CesiumSettingsOverlay({
  dataSource,
  onDataSourceChange,
  terrainEnabled,
  onTerrainChange,
  onClose,
}: {
  dataSource: CesiumDataSource;
  onDataSourceChange: (ds: CesiumDataSource) => void;
  terrainEnabled: boolean;
  onTerrainChange: (enabled: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-4 right-4 z-10 pointer-events-auto bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-2 min-w-[160px]">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          3D World
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="h-5 w-5" onClick={onClose}>
              <X className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Disable Cesium overlay</TooltipContent>
        </Tooltip>
      </div>

      {/* Data Source Buttons */}
      <div className="flex flex-col gap-0.5">
        {DATA_SOURCES.map((ds) => {
          const Icon = ds.icon;
          const active = dataSource === ds.value;
          return (
            <button
              key={ds.value}
              onClick={() => onDataSourceChange(ds.value)}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors text-left',
                active
                  ? 'bg-teal-600 text-white'
                  : 'hover:bg-muted text-foreground/80',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {ds.label}
            </button>
          );
        })}
      </div>

      {/* Terrain Toggle */}
      <label className="flex items-center gap-2 px-2 py-1 cursor-pointer border-t border-border pt-2">
        <Mountain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-foreground/80">Terrain</span>
        <input
          type="checkbox"
          checked={terrainEnabled}
          onChange={(e) => onTerrainChange(e.target.checked)}
          className="ml-auto accent-teal-500"
        />
      </label>
    </div>
  );
}

/**
 * Tiny indirection so the panel can subscribe to its own slice without
 * pulling extra state into the parent overlay component.
 */
function PointCloudPanelMount() {
  const count = useViewerStore((s) => s.pointCloudAssetCount);
  // Triangle total comes from the merged geometry result. The panel
  // gates the BIM↔scan deviation compute button on triangleCount > 0
  // so the user can't trigger an empty-BVH compute pass.
  const triangleCount = useViewerStore((s) => s.geometryResult?.totalTriangles ?? 0);
  return <PointCloudPanel assetCount={count} triangleCount={triangleCount} />;
}
