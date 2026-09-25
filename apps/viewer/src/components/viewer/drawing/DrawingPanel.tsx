/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel (#5494): the `drawing` workspace panel's view, docked in
 * the bottom strip, floating, or popped out. A slim action row (the cut it
 * shows, Regenerate, Export — the strip / floating / pop-out host owns title
 * and Close, #5498), one toolbar row, the canvas with the settings drawers
 * beside it, and a status line. Its runtime (generation, persistence, the
 * Section-tool auto-open) is `DrawingRuntimeHost` and runs whether or not
 * this is mounted (#5492).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, PencilRuler, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { AXIS_INFO } from '../tools/sectionConstants';
import { TitleBlockEditor } from '../TitleBlockEditor';
import { useDrawingViewModel } from './useDrawingViewModel';
import { useDrawingLayers } from './useDrawingLayers';
import { DrawingToolbar, type DrawingWidthTier } from './DrawingToolbar';
import { DrawingExportMenu } from './DrawingExportMenu';
import { DrawingCanvasView } from './DrawingCanvasView';
import { DrawingStatusLine } from './DrawingStatusLine';
import { DrawingInspector } from './DrawingInspector';

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
  const vm = useDrawingViewModel();
  const layers = useDrawingLayers(vm);
  const panelRef = useRef<HTMLDivElement>(null);
  const { tier, width: panelWidth } = usePanelMetrics(panelRef);
  const { sectionPlane, status, displayOptions } = vm;

  // The same wording the Section tool's header uses for the cut.
  const cutLabel = sectionPlane.custom !== undefined
    ? t('sectionTool.header.custom', { distance: sectionPlane.custom.distance.toFixed(2) })
    : t('sectionTool.header.axis', { axis: t(AXIS_INFO[sectionPlane.axis].labelKey), position: sectionPlane.position.toFixed(1) });

  return (
    <div ref={panelRef} className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <PencilRuler className="h-4 w-4 shrink-0" />
          <span className="shrink-0 text-sm font-medium">{t('section2d.heading')}</span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">{cutLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <HeaderAction label={t('section2d.regenerate')} onClick={() => vm.runtime.generateDrawing(false)} disabled={status === 'generating'}>
            {status === 'generating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </HeaderAction>
          <DrawingExportMenu
            hasDrawing={!!vm.drawing} compact={tier === 'narrow'}
            onExportSvg={layers.handleExportSVG} onExportDxf={layers.handleExportDXF}
            onExportPdf={layers.handleExportPDF} onPrint={layers.handlePrint}
            displayedScale={displayOptions.scale || 100}
            sheetEnabled={vm.sheetEnabled} activeSheet={vm.activeSheet}
          />
        </div>
      </div>

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
