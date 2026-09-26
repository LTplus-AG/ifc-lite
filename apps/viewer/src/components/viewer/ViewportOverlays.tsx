/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState, useRef } from 'react';
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
import { emitCameraInteracted } from '@/lib/tours/events';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { cn } from '@/lib/utils';
import { useViewportStatusSummary } from '@/hooks/useViewportStatusSummary';
import { ViewCube, type ViewCubeRef } from './ViewCube';
import { AxisHelper, type AxisHelperRef } from './AxisHelper';
import { FlySpeedIndicator } from './FlySpeedIndicator';
import { OrbitPivotMarker } from './OrbitPivotMarker';
import { Crosshair } from 'lucide-react';
import { useTranslation } from '@/i18n';
// Mounted here, not in `ViewportContainer.tsx` (at its module budget): a
// zero-net addition since this already lives inside the same viewport panel.
import { ViewportHud } from '../viewport-ui/hud/ViewportHud';
import { EditModeHudChip } from './EditModeHudChip';
import { ViewportLoadingCard } from './ViewportLoadingCard';
import { SectionParkedChip } from './tools/SectionParkedChip';

/**
 * Overlay chrome drawn on top of the 3D viewport.
 *
 * The three `hide*` props exist for the embed: a host iframe is often too
 * small for the full chrome. They default to `false`, so the standalone
 * viewer is unaffected.
 *
 * Only two of them are host-controllable. `hideAxis` and `hideScale` carry the
 * `?hideAxis=`/`?hideScale=` URL params and INIT's `config.hideAxis`/
 * `.hideScale` (`useEmbedRuntimeOverlays.ts`). `hideViewCube` has NO param
 * behind it -- `urlParams.ts` never parses one and `EmbedUrlParams` never
 * declared one -- the embed passes it unconditionally, so the ViewCube is
 * always off there. This comment named a `?hideViewCube=` from #3316 until
 * #2934's closing sweep; no such param has ever been parsed, so a host that
 * sent it got exactly the silent no-op #2934 is about.
 */
export function ViewportOverlays({
  hideViewCube = false,
  hideAxis = false,
  hideScale = false,
}: { hideViewCube?: boolean; hideAxis?: boolean; hideScale?: boolean } = {}) {
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const isMobile = useViewerStore((s) => s.isMobile);
  const setOnCameraRotationChange = useViewerStore((s) => s.setOnCameraRotationChange);
  const setOnScaleChange = useViewerStore((s) => s.setOnScaleChange);
  const { t } = useTranslation();

  // The storey pill and the hidden/ghosted count moved into `StatusBar` for
  // desktop (#5504); the status bar is hidden on mobile
  // (`ViewerLayout.tsx`'s `{!isMobile && <StatusBar />}`), so mobile keeps
  // showing both here, off the same shared derivation `StatusBar` uses.
  const { storeyNames, objectCounts } = useViewportStatusSummary();

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

  // Surface the `pointclouds` side panel the first time a point cloud loads
  // (#5507) — the same moment the old floating `PointCloudPanel` card used to
  // appear, before it moved into the docked sidebar. Fires once per
  // "0 -> some assets" transition, not on every render while assets stay
  // loaded, so a user who switches away to another panel isn't yanked back.
  // Resets when the last asset unloads so a later reload surfaces it again.
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  const pointCloudPanelIntroducedRef = useRef(false);
  useEffect(() => {
    if (pointCloudAssetCount > 0 && !pointCloudPanelIntroducedRef.current) {
      pointCloudPanelIntroducedRef.current = true;
      useViewerStore.getState().openWorkspacePanel('pointclouds', 'programmatic');
    } else if (pointCloudAssetCount === 0) {
      pointCloudPanelIntroducedRef.current = false;
    }
  }, [pointCloudAssetCount]);

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
      {/* HUD kernel (#5485); mounted first so its regions exist before
          anything below portals in. */}
      <ViewportHud />
      <EditModeHudChip />
      <ViewportLoadingCard />
      <SectionParkedChip />
      <FlySpeedIndicator />
      <OrbitPivotMarker />
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
              <Button variant="ghost" size="icon-sm" aria-label={t('viewportLighting.overlays.mobileNav.homeAria')} className="min-h-[44px] min-w-[44px]" onClick={handleHome}>
                <Home className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('viewportLighting.overlays.mobileNav.homeTooltip')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('viewportLighting.overlays.mobileNav.zoomInAria')} className="min-h-[44px] min-w-[44px]" onClick={handleZoomIn}>
                <ZoomIn className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('viewportLighting.overlays.mobileNav.zoomInAria')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('viewportLighting.overlays.mobileNav.zoomOutAria')} className="min-h-[44px] min-w-[44px]" onClick={handleZoomOut}>
                <ZoomOut className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('viewportLighting.overlays.mobileNav.zoomOutAria')}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Hidden-object count. Desktop shows this in `StatusBar` (#5504); mobile
          has no status bar (`ViewerLayout.tsx`'s `{!isMobile && <StatusBar
          />}`), so it keeps its own copy here, off the same shared
          derivation. Reports what is WITHHELD, not a ratio: the number a
          user acts on is "what am I not seeing", and "1442 of 1446 visible"
          makes them do the subtraction to find the 4 that matter. Passive,
          so an unfiltered model carries no chrome at all.

          Styled as the bottom-left scale/axis cluster is: bare text at
          `text-xs text-foreground/80`, no pill, no border, no backdrop, no
          off-palette accent. The 3D overlays along the bottom edge are
          deliberately plain, and this sits in that row. */}
      {isMobile && (objectCounts.hidden > 0 || objectCounts.ghosted > 0) && (
        <output className="absolute right-4 bottom-4 flex flex-col items-end gap-1">
          <span className="text-xs text-foreground/80 tabular-nums">
            {[
              objectCounts.hidden > 0 && t('shellChrome.statusBar.hiddenCount', { count: objectCounts.hidden }),
              objectCounts.ghosted > 0 && t('shellChrome.statusBar.ghostedCount', { count: objectCounts.ghosted }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </output>
      )}

      {/* Context Info — Storey names. Desktop shows this in `StatusBar`
          (#5504); mobile keeps it here, top-center (the URL bar steals the
          bottom). */}
      {isMobile && storeyNames && storeyNames.length > 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 top-4 px-4 py-2 bg-background/80 backdrop-blur-sm rounded-full border shadow-sm">
          <div className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4 text-primary" />
            <span className="font-medium">
              {storeyNames.length === 1
                ? storeyNames[0]
                : t('viewportLighting.overlays.storeyCount', { count: storeyNames.length })}
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
          Mounted on the shared scene-overlay kernel in `ViewportContainer`
          (#5512), not here: it returns null when the toggle is off, so
          `<BasepointOverlay />` living outside this component's own
          render tree changes nothing about when the marker shows. */}
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
  const { t } = useTranslation();
  if (modelCount === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleShowModelBasepoints}
          aria-label={showModelBasepoints ? t('viewportLighting.overlays.basepointToggle.hide') : t('viewportLighting.overlays.basepointToggle.showAria')}
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
        {showModelBasepoints ? t('viewportLighting.overlays.basepointToggle.hide') : t('viewportLighting.overlays.basepointToggle.showTooltip')}
      </TooltipContent>
    </Tooltip>
  );
}
