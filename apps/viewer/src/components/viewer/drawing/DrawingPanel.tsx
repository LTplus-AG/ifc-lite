/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel (#5494): the `drawing` workspace panel's view, docked in
 * the bottom strip, floating, or popped out. A slim action row (the cut it
 * shows, Regenerate, Match 3D, Export — the strip / floating / pop-out host
 * owns title and Close, #5498), one toolbar row, the canvas with the
 * settings drawers beside it, and a status line while a tool or markup has
 * something to say. Docked in the strip, the action row moves into the
 * strip's tab row beside the "Drawing" tab (#8802 R3b), so the canvas does
 * not sit under three header rows. Its runtime (generation, persistence) is
 * `DrawingRuntimeHost` and runs whether or not this is mounted (#5492).
 *
 * The Section tool does not auto-open this panel (#5497): the action row
 * shows a "Section parked · Resume" banner instead whenever the cut it is
 * showing has been parked (`sectionPlane.parked`, set by
 * `store/section-active.ts` when the Section tool is not the active tool),
 * so a docked/floating drawing that outlives the tool never looks live
 * without saying so.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Video } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { AXIS_INFO, presetViewForAxis } from '../tools/sectionConstants';
import { TitleBlockEditor } from '../TitleBlockEditor';
import { useDrawingViewModel } from './useDrawingViewModel';
import { useDrawingLayers } from './useDrawingLayers';
import { AssistantAction } from '../assistant/AssistantAction';
import { DrawingToolbar, type DrawingWidthTier } from './DrawingToolbar';
import { DrawingExportMenu } from './DrawingExportMenu';
import { DrawingCanvasView } from './DrawingCanvasView';
import { DrawingStatusLine } from './DrawingStatusLine';
import { DrawingInspector } from './DrawingInspector';
import { DrawingSectionCutMenu } from './DrawingSectionCutMenu';
import { useBottomStripHeaderSlot } from '../bottom-strip-header-slot';
import { constructionProjectionEnabled } from '@/lib/drawing/construction-projection';

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

/** A cut position as the header shows it: one decimal, none when it is whole ("50", "37.5"). */
function formatCutPosition(position: number): string {
  return String(Number(position.toFixed(1)));
}

function HeaderDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

function HeaderAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} disabled={disabled}>{children}</Button>
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
  const headerSlot = useBottomStripHeaderSlot();
  const navigationPreset = useViewerStore((s) => s.navigationPreset);

  // The same wording the Section tool's header uses for the cut.
  const cut = isCustomPlane
    ? t('sectionTool.header.custom', { distance: sectionPlane.custom!.distance.toFixed(2) })
    : t('sectionTool.header.axis', { axis: t(AXIS_INFO[sectionPlane.axis].labelKey), position: formatCutPosition(sectionPlane.position) });
  // With several cutting planes the drawing is the ACTIVE plane's (#7545): name it, so "which plane is this?" has an answer.
  const hasOtherPlanes = useViewerStore((s) => s.inactiveSectionPlanes.length > 0);
  const cutLabel = hasOtherPlanes && sectionPlane.name ? t('section2d.cutNamed', { name: sectionPlane.name, cut }) : cut;

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

  const cutMenu = <DrawingSectionCutMenu cutLabel={cutLabel} displayLabel={t('section2d.cutPlane', { cut: cutLabel })} />;
  const actions = (
    <>
      <HeaderAction label={t('section2d.regenerate')} onClick={() => vm.runtime.generateDrawing(false)} disabled={status === 'generating'}>
        {status === 'generating' ? <Spinner size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </HeaderAction>
      <Tooltip>
        <TooltipTrigger asChild>
          {tier === 'narrow' ? (
            <Button
              variant="ghost" size="icon-xs"
              aria-label={t('section2d.matchView.button')}
              onClick={handleMatchView} disabled={isCustomPlane}
            >
              <Video className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
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
        hasDrawing={!!vm.exportableDrawing} compact={tier === 'narrow'}
        onExportSvg={layers.handleExportSVG} onExportDxf={layers.handleExportDXF}
        onExportPdf={layers.handleExportPDF} onPrint={layers.handlePrint}
        displayedScale={displayOptions.scale || 100}
        sheetEnabled={vm.sheetEnabled} activeSheet={vm.activeSheet}
        markupCounts={vm.markupCounts}
        visibleRasterReferenceCount={vm.visibleRasterReferenceCount}
        visibleUnderlayCount={layers.dxfUnderlayData.filter((underlay) => underlay.opacity > 0).length}
      />
      <AssistantAction />
    </>
  );

  return (
    <div ref={panelRef} className="flex h-full w-full flex-col overflow-hidden bg-background">
      {headerSlot ? createPortal(
        <div data-drawing-header className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center">
            <HeaderDivider />
            {cutMenu}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {actions}
            <HeaderDivider />
          </div>
        </div>,
        headerSlot,
      ) : (
        <div data-drawing-header className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1">
          <div className="flex min-w-0 items-center">{cutMenu}</div>
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </div>
      )}

      {isParked && (
        <div
          data-drawing-parked-banner
          className="flex shrink-0 items-center gap-1.5 border-b bg-status-warn/15 px-3 py-1 text-xs text-foreground"
        >
          <span>{t('section2d.parked.label')}</span>
          <span aria-hidden="true">·</span>
          <Button
            variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs font-medium text-foreground hover:bg-status-warn/20"
            onClick={handleResumeSection} title={t('section2d.parked.resumeTitle')}
          >
            {t('section2d.parked.resume')}
          </Button>
        </div>
      )}

      <DrawingToolbar
        tier={tier}
        activeTool={vm.annotation2DActiveTool} onSelectTool={vm.selectTool}
        selectHint={t(navigationPreset === 'trackpad' ? 'section2d.tip.trackpad' : 'section2d.tip.pan')}
        hasMarkup={vm.hasMarkup} onClearMarkup={vm.clearAllAnnotations2D}
        display={{
          symbolic: displayOptions.useSymbolicRepresentations,
          ifcAnnotations: displayOptions.showIfcAnnotations,
          projection: constructionProjectionEnabled(displayOptions.showConstructionProjection, sectionPlane),
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
