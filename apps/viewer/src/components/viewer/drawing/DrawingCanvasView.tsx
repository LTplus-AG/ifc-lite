/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Spinner } from '@/components/ui/spinner';

/** The Drawing panel's canvas region (#5494): the drawing with its markup and
 *  layers, the generating / error / empty states, and the only thing that
 *  still floats over the paper, the text annotation editor. */


import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { Drawing2DCanvas } from '../Drawing2DCanvas';
import { TextAnnotationEditor } from '../TextAnnotationEditor';
import type { DrawingViewModel } from './useDrawingViewModel';
import type { DrawingLayers } from './useDrawingLayers';

export function DrawingCanvasView({ vm, layers }: { vm: DrawingViewModel; layers: DrawingLayers }) {
  const { t } = useTranslation();
  const { drawing, status, sectionPlane, viewTransform, displayOptions } = vm;
  const hasContent = !!drawing && (drawing.cutPolygons.length > 0 || drawing.lines?.length > 0 || layers.dxfUnderlayData.length > 0 || vm.hasReferences);
  const editingAnnotation = vm.textAnnotation2DEditing
    ? vm.textAnnotations2D.find((a) => a.id === vm.textAnnotation2DEditing) ?? null
    : null;

  return (
    <div
      ref={vm.containerRef}
      data-drawing-canvas
      className={`relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-zinc-950 ${vm.cursorClass}`}
      {...vm.canvasMouseHandlers}
    >
      {status === 'generating' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80">
          <Spinner className="mb-4 h-8 w-8 text-primary" />
          <div className="text-sm font-medium">{vm.progressPhase}</div>
          <div className="mt-2 h-2 w-48 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all duration-200" style={{ width: `${vm.progress}%` }} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground tabular-nums">{Math.round(vm.progress)}%</div>
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-destructive">
            <p className="font-medium">{t('section2d.error.generation')}</p>
            <p className="text-sm text-muted-foreground">{vm.drawingError}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => vm.runtime.generateDrawing(false)}>
              {t('section2d.error.retry')}
            </Button>
          </div>
        </div>
      )}

      {status === 'ready' && drawing && hasContent && (
        <Drawing2DCanvas
          drawing={drawing}
          snapshotSourceDrawing={vm.sourceDrawing ?? drawing}
          transform={viewTransform}
          showHiddenLines={displayOptions.showHiddenLines}
          overrideEngine={vm.overrideEngine}
          overridesEnabled={vm.overridesEnabled}
          entityColorMap={vm.entityColorMap}
          useIfcMaterials={vm.activePresetId === 'preset-3d-colors'}
          measureMode={vm.measure2DMode}
          measureStart={vm.measure2DStart}
          measureCurrent={vm.measure2DCurrent}
          measureResults={vm.measure2DResults}
          measureSnapPoint={vm.measure2DSnapPoint}
          sheetEnabled={vm.sheetEnabled}
          activeSheet={vm.activeSheet}
          sectionAxis={sectionPlane.axis}
          isPinned={vm.isPinned}
          cachedSheetTransformRef={vm.cachedSheetTransformRef}
          annotation2DActiveTool={vm.annotation2DActiveTool}
          annotation2DCursorPos={vm.annotation2DCursorPos}
          polygonAreaPoints={vm.polygonArea2DPoints}
          polygonAreaResults={vm.polygonArea2DResults}
          textAnnotations={vm.textAnnotations2D}
          textAnnotationEditing={vm.textAnnotation2DEditing}
          cloudAnnotationPoints={vm.cloudAnnotation2DPoints}
          cloudAnnotations={vm.cloudAnnotations2D}
          selectedAnnotation={vm.selectedAnnotation2D}
          ifcAnnotationLines={layers.ifcAnnotationData.lines}
          ifcAnnotationTexts={layers.ifcAnnotationData.texts}
          ifcAnnotationFills={layers.ifcAnnotationData.fills}
          dxfUnderlays={layers.dxfUnderlayData}
          scanPoints={displayOptions.showScanSection ? layers.scanSectionLayer.points : undefined}
          scanOpacity={displayOptions.scanSectionOpacity}
          unitDisplayOverrides={vm.unitDisplayOverrides}
          paperTheme={vm.paperTheme}
        />
      )}

      {editingAnnotation && (() => {
        const scaleX = sectionPlane.axis === 'side' ? -viewTransform.scale : viewTransform.scale;
        const scaleY = sectionPlane.axis === 'down' ? viewTransform.scale : -viewTransform.scale;
        return (
          <TextAnnotationEditor
            annotation={editingAnnotation}
            screenX={editingAnnotation.position.x * scaleX + viewTransform.x}
            screenY={editingAnnotation.position.y * scaleY + viewTransform.y}
            onConfirm={vm.handleTextConfirm}
            onCancel={vm.handleTextCancel}
          />
        );
      })()}

      {status === 'ready' && drawing && !hasContent && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-muted-foreground">
            <p className="font-medium">{t('section2d.empty.title')}</p>
            <p className="mt-1 text-sm">{t('section2d.empty.description')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
