/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel (#5494): the `drawing` workspace panel's view, docked in
 * the bottom strip, floating, or popped out. A slim action row (the cut it
 * shows, Regenerate, Match 3D, Export — the strip / floating / pop-out host
 * owns title and Close, #5498), one toolbar row, the canvas with the
 * settings drawers beside it, and a status line. Its runtime (generation,
 * persistence) is `DrawingRuntimeHost` and runs whether or not this is
 * mounted (#5492).
 *
 * The Section tool does not auto-open this panel (#5497): the action row
 * shows a "Section parked · Resume" banner instead whenever the cut it is
 * showing has been parked (`sectionPlane.parked`, set by
 * `store/section-active.ts` when the Section tool is not the active tool),
 * so a docked/floating drawing that outlives the tool never looks live
 * without saying so.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PencilRuler, RefreshCw, Video } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { AXIS_INFO, presetViewForAxis } from '../tools/sectionConstants';
import { TitleBlockEditor } from '../TitleBlockEditor';
import { useDrawingViewModel } from './useDrawingViewModel';
import { useDrawingLayers } from './useDrawingLayers';
import { DrawingToolbar, type DrawingWidthTier } from './DrawingToolbar';
import { DrawingExportMenu } from './DrawingExportMenu';
import { DrawingCanvasView } from './DrawingCanvasView';
import { DrawingStatusLine } from './DrawingStatusLine';
import { DrawingInspector } from './DrawingInspector';
import { DrawingSectionCutMenu } from './DrawingSectionCutMenu';

/** Labels need ~1180px for one row; icons alone fit from ~640px; below that
 *  the rarest items overflow (see DrawingToolbar). */
function tierFor(width: number): DrawingWidthTier {
  return width >= 1180 ? 'wide' : width >= 640 ? 'compact' : 'narrow';
}

/** The host (bottom strip, floating window, pop-out, mobile sheet) owns the
 *  size, so the chrome adapts to the width it actually gets; the inspector
 *  column also needs the raw pixel width to decide its overlay fallback. */
function usePanelMetrics(ref: React.RefObject<HTMLDivElement | null>): { tier: DrawingWidthTier; width: number } {
  const [tier, setTier] = useState<DrawingWidthTier>('wide');
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setTier(tierFor(entry.contentRect.width));
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return { tier, width };
}

function HeaderAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DrawingPanel(): React.ReactElement {
  const { t } = useTranslation();
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setProjectionMode = useViewerStore((s) => s.setProjectionMode);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const vm = useDrawingViewModel();
  const layers = useDrawingLayers(vm);
  const panelRef = useRef<HTMLDivElement>(null);
  const { tier, width: panelWidth } = usePanelMetrics(panelRef);
  const { sectionPlane, status, displayOptions } = vm;
  const isCustomPlane = sectionPlane.custom !== undefined;

  // The same wording the Section tool's header uses for the cut.
  const cutLabel = isCustomPlane
    ? t('sectionTool.header.custom', { distance: sectionPlane.custom!.distance.toFixed(2) })
    : t('sectionTool.header.axis', { axis: t(AXIS_INFO[sectionPlane.axis].labelKey), position: sectionPlane.position.toFixed(1) });

  // The Section tool no longer auto-opens this panel (#5497): a docked or
  // floating drawing can outlive the tool and keep showing the last cut with
  // the tool closed. `sectionPlane.parked` (set by `store/section-active.ts`
  // the instant the Section tool stops being the active tool) is the single
  // source of truth for that state — surfaced here instead of silently
  // showing a cut the user can no longer edit.
  const isParked = sectionPlane.parked === true && activeTool !== 'section';
  const handleResumeSection = useCallback(() => setActiveTool('section'), [setActiveTool]);

  // Floor plan / the Section tool used to force the 3D view to top-down
  // ortho on every activation; that is now this explicit action (#5497).
  const handleMatchView = useCallback(() => {
    setProjectionMode('orthographic');
    cameraCallbacks.setPresetView?.(presetViewForAxis(sectionPlane.axis, sectionPlane.flipped));
  }, [setProjectionMode, cameraCallbacks, sectionPlane.axis, sectionPlane.flipped]);

  return (
    <div ref={panelRef} className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <PencilRuler className="h-4 w-4 shrink-0" />
          <span className="shrink-0 text-sm font-medium">{t('section2d.heading')}</span>
          <DrawingSectionCutMenu cutLabel={cutLabel} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <HeaderAction label={t('section2d.regenerate')} onClick={() => vm.runtime.generateDrawing(false)} disabled={status === 'generating'}>
            {status === 'generating' ? <Spinner size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </HeaderAction>
          <Tooltip>
            <TooltipTrigger asChild>
              {tier === 'narrow' ? (
                <Button
                  variant="ghost" size="icon-sm"
                  aria-label={t('section2d.matchView.button')}
                  onClick={handleMatchView} disabled={isCustomPlane}
                >
                  <Video className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs"
                  aria-label={t('section2d.matchView.button')}
                  onClick={handleMatchView} disabled={isCustomPlane}
                >
                  <Video className="h-3.5 w-3.5" />
                  {t('section2d.matchView.button')}
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent>{t(isCustomPlane ? 'section2d.matchView.unavailableTitle' : 'section2d.matchView.title')}</TooltipContent>
          </Tooltip>
          <DrawingExportMenu
            hasDrawing={!!vm.drawing} compact={tier === 'narrow'}
            onExportSvg={layers.handleExportSVG} onExportDxf={layers.handleExportDXF}
            onExportPdf={layers.handleExportPDF} onPrint={layers.handlePrint}
            displayedScale={displayOptions.scale || 100}
            sheetEnabled={vm.sheetEnabled} activeSheet={vm.activeSheet}
            markupCounts={vm.markupCounts}
            visibleUnderlayCount={layers.dxfUnderlayData.filter((underlay) => underlay.opacity > 0).length}
          />
        </div>
      </div>

      {isParked && (
        <div
          data-drawing-parked-banner
          className="flex shrink-0 items-center gap-1.5 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <span>{t('section2d.parked.label')}</span>
          <span aria-hidden="true">·</span>
          <Button
            variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-amber-900 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100"
            onClick={handleResumeSection} title={t('section2d.parked.resumeTitle')}
          >
            {t('section2d.parked.resume')}
          </Button>
        </div>
      )}

      <DrawingToolbar
        tier={tier}
        activeTool={vm.annotation2DActiveTool} onSelectTool={vm.selectTool}
        hasMarkup={vm.hasMarkup} onClearMarkup={vm.clearAllAnnotations2D}
        display={{
          symbolic: displayOptions.useSymbolicRepresentations,
          ifcAnnotations: displayOptions.showIfcAnnotations,
          projection: displayOptions.showConstructionProjection,
          overlay3D: displayOptions.show3DOverlay,
          printPreview: displayOptions.showPrintPreview,
        }}
        ifcAnnotationsAvailable={sectionPlane.axis === 'down'}
        projectionAvailable={sectionPlane.custom === undefined}
        onToggleSymbolic={vm.toggleSymbolicRepresentations}
        onToggleIfcAnnotations={vm.toggleIfcAnnotations}
        onToggleProjection={vm.toggleConstructionProjection}
        onToggleOverlay3D={vm.toggle3DOverlay}
        onTogglePrintPreview={vm.togglePrintPreview}
        openDrawer={vm.openDrawer}
        drawerActivity={{
          overrides: vm.activePresetId !== null,
          sheet: vm.sheetEnabled,
          underlays: vm.dxfUnderlays.length > 0,
          scan: layers.scanSectionLayer.hasPointCloud && displayOptions.showScanSection,
        }}
        onToggleDrawer={vm.toggleDrawer}
        zoomPercent={Math.round(vm.viewTransform.scale * 100)}
        onZoomIn={vm.zoomIn} onZoomOut={vm.zoomOut} onFit={vm.fitToView}
        pinned={vm.isPinned} onTogglePinned={vm.togglePinned}
      />

      <div className="relative flex min-h-0 flex-1">
        <DrawingCanvasView vm={vm} layers={layers} />
        <DrawingInspector vm={vm} layers={layers} panelWidth={panelWidth} />
      </div>

      <DrawingStatusLine
        activeTool={vm.annotation2DActiveTool}
        measureStarted={vm.measure2DStart !== null}
        shiftLocked={vm.measure2DShiftLocked}
        snapped={vm.measure2DSnapPoint !== null}
        polygonPointCount={vm.polygonArea2DPoints.length}
        cloudPointCount={vm.cloudAnnotation2DPoints.length}
        textEditing={vm.textAnnotation2DEditing !== null}
        selection={vm.selectedAnnotation2D}
        counts={vm.markupCounts}
        underlayCount={layers.dxfUnderlayData.length}
        updating={vm.runtime.isRegenerating}
      />

      <TitleBlockEditor open={vm.titleBlockEditorVisible} onOpenChange={vm.setTitleBlockEditorVisible} />
    </div>
  );
}
