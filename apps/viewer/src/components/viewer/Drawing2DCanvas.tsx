/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import React, { useRef, useState, useEffect } from 'react';
import {
  GraphicOverrideEngine,
  calculateDrawingTransform,
  type Drawing2D,
  type ElementData,
} from '@ifc-lite/drawing-2d';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { formatDistance } from './tools/formatDistance';
import { formatArea, computePolygonCentroid } from './tools/computePolygonArea';
import { drawCloudOnCanvas } from './tools/cloudPathGenerator';
import type { PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D, Annotation2DTool, Point2D, SelectedAnnotation2D } from '@/store/slices/drawing2DSlice';
import type { AnnotationFill2D, AnnotationText2D } from '@/hooks/useSymbolicAnnotations';

// Fill colors for IFC types (architectural convention)
const IFC_TYPE_FILL_COLORS: Record<string, string> = {
  // Structural elements - solid gray
  IfcWall: '#b0b0b0',
  IfcWallStandardCase: '#b0b0b0',
  IfcColumn: '#909090',
  IfcBeam: '#909090',
  IfcSlab: '#c8c8c8',
  IfcRoof: '#d0d0d0',
  IfcFooting: '#808080',
  IfcPile: '#707070',

  // Windows/Doors - lighter
  IfcWindow: '#e8f4fc',
  IfcDoor: '#f5e6d3',

  // Stairs/Railings
  IfcStair: '#d8d8d8',
  IfcStairFlight: '#d8d8d8',
  IfcRailing: '#c0c0c0',

  // MEP - distinct colors
  IfcPipeSegment: '#a0d0ff',
  IfcDuctSegment: '#c0ffc0',

  // Furniture
  IfcFurnishingElement: '#ffe0c0',

  // Spaces (usually not shown in section)
  IfcSpace: '#f0f0f0',

  // Default
  default: '#d0d0d0',
};

export function getFillColorForType(ifcType: string): string {
  return IFC_TYPE_FILL_COLORS[ifcType] || IFC_TYPE_FILL_COLORS.default;
}

// ─── IFC annotation overlay helpers (issue #812) ─────────────────────────────

/** Linear sRGB straight-alpha [0..1] tuple → CSS `rgba(...)`. */
function rgbaToCss(c: readonly [number, number, number, number]): string {
  const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, c[3]))})`;
}

/**
 * Map IFC `BoxAlignment` to canvas2d `textAlign` + `textBaseline`. Mirrors
 * the renderer's `parseBoxAlignment` semantics so the 2D overlay anchors
 * text the same way the 3D pipeline does. Unknown / empty strings default
 * to bottom-left (IFC4 IfcTextLiteralWithExtent default).
 */
function alignmentToCanvas(s: string): { align: CanvasTextAlign; baseline: CanvasTextBaseline } {
  const norm = (s ?? '').toLowerCase().trim();
  let align: CanvasTextAlign = 'left';
  let baseline: CanvasTextBaseline = 'alphabetic';
  if (norm.includes('right')) align = 'right';
  else if (norm.includes('center')) align = 'center';
  if (norm.includes('top')) baseline = 'top';
  else if (norm.includes('middle') || (norm.includes('center') && !norm.includes('center-'))) baseline = 'middle';
  return { align, baseline };
}

/**
 * Render IFC annotation fills, lines, and text into the canvas, in screen
 * pixels. The caller supplies:
 *   - `modelToScreen` – drawing-coord → screen-pixel conversion (accounts
 *     for axis flips and sheet-mode paper scale)
 *   - `mmLineToScreen` – mm line weight → screen px stroke width
 *   - `worldHeightToScreenPx` – world-units text height → screen px font size
 *
 * Called from both the sheet-mode and direct-mode render paths in
 * `Drawing2DCanvas`. Splitting it out keeps the two paths in sync without
 * duplicating ~80 lines of canvas calls.
 *
 * Text rendering uses identity transform (no canvas rotate-with-scale) so
 * `direct mode`'s y-flip doesn't mirror glyphs. The baseline direction is
 * recovered in screen space from `dirX/dirY` mapped through `modelToScreen`.
 */
function drawIfcAnnotationsScreenSpace(
  ctx: CanvasRenderingContext2D,
  lines: readonly DrawingLine2D[] | undefined,
  texts: readonly AnnotationText2D[] | undefined,
  fills: readonly AnnotationFill2D[] | undefined,
  modelToScreen: (x: number, y: number) => { x: number; y: number },
  mmLineToScreen: (mmWeight: number) => number,
  worldHeightToScreenPx: (worldHeight: number) => number,
): void {
  // Fills first so lines/text composite cleanly on top.
  if (fills && fills.length > 0) {
    for (const fill of fills) {
      const pts = fill.points;
      if (pts.length < 6) continue;
      const holes = fill.holesOffsets;

      ctx.fillStyle = rgbaToCss(fill.color);
      ctx.beginPath();

      // Outer ring runs from index 0 up to the first hole offset (or end of
      // points if no holes). Each hole offset is a vertex index where the
      // next ring starts. Path subpaths use moveTo + lineTo + closePath; the
      // even-odd fill rule handles the holes.
      const ringStarts: number[] = [0];
      for (let i = 0; i < holes.length; i++) ringStarts.push(holes[i]);
      ringStarts.push(pts.length / 2); // sentinel end

      for (let ri = 0; ri < ringStarts.length - 1; ri++) {
        const start = ringStarts[ri];
        const end = ringStarts[ri + 1];
        if (end - start < 3) continue;
        const first = modelToScreen(pts[start * 2], pts[start * 2 + 1]);
        ctx.moveTo(first.x, first.y);
        for (let i = start + 1; i < end; i++) {
          const p = modelToScreen(pts[i * 2], pts[i * 2 + 1]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
  }

  if (lines && lines.length > 0) {
    // Slightly heavier than the drawing-2d 'annotation' category (0.13 mm)
    // so coplanar overlays read clearly against the cut polygons beneath.
    // This is the 2D equivalent of the 3D thicker-lines suggestion in #812.
    const lineWidthMm = 0.2;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = mmLineToScreen(lineWidthMm);
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const ln of lines) {
      const a = modelToScreen(ln.line.start.x, ln.line.start.y);
      const b = modelToScreen(ln.line.end.x, ln.line.end.y);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  if (texts && texts.length > 0) {
    for (const t of texts) {
      if (!t.content) continue;
      const anchor = modelToScreen(t.x, t.y);
      // Recover baseline direction in SCREEN space. modelToScreen may flip
      // axes (e.g. direct-mode flips Y), so atan2(dirY, dirX) on raw model
      // dirs would draw the text mirrored on those axes.
      const baselineEnd = modelToScreen(t.x + t.dirX, t.y + t.dirY);
      const sx = baselineEnd.x - anchor.x;
      const sy = baselineEnd.y - anchor.y;
      const angle = Math.abs(sx) + Math.abs(sy) > 1e-6 ? Math.atan2(sy, sx) : 0;

      const fontPx = t.targetPx && t.targetPx > 0 ? t.targetPx : worldHeightToScreenPx(t.height);
      const { align, baseline } = alignmentToCanvas(t.alignment);
      // Multi-line literals stack downward in world Y in 3D. In 2D screen
      // space the equivalent is `+ fontPx` per line below the anchor along
      // the baseline-perpendicular (handled by the canvas rotate below).
      const lineOffsetPx = (t.lineYOffset ?? 0) * (fontPx / Math.max(1e-6, t.height));

      ctx.save();
      ctx.fillStyle = t.color ? rgbaToCss(t.color) : '#000000';
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = baseline;
      ctx.translate(anchor.x, anchor.y);
      ctx.rotate(angle);
      ctx.fillText(t.content, 0, lineOffsetPx);
      ctx.restore();
    }
  }
}

// Static constants to avoid creating new objects/arrays on every render
const CANVAS_STYLE = { imageRendering: 'crisp-edges' as const };
const EMPTY_MEASURE_RESULTS: Measure2DResultData[] = [];

export interface Measure2DResultData {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  distance: number;
}

interface Drawing2DCanvasProps {
  drawing: Drawing2D;
  transform: { x: number; y: number; scale: number };
  showHiddenLines: boolean;
  overrideEngine: GraphicOverrideEngine;
  overridesEnabled: boolean;
  entityColorMap: Map<number, [number, number, number, number]>;
  useIfcMaterials: boolean;
  // Measure tool props
  measureMode?: boolean;
  measureStart?: { x: number; y: number } | null;
  measureCurrent?: { x: number; y: number } | null;
  measureResults?: Measure2DResultData[];
  measureSnapPoint?: { x: number; y: number } | null;
  // Sheet mode props
  sheetEnabled?: boolean;
  activeSheet?: import('@ifc-lite/drawing-2d').DrawingSheet | null;
  // Section plane info for axis-specific rendering
  sectionAxis: 'down' | 'front' | 'side';
  // Pinned mode - keep model fixed in place on sheet
  isPinned?: boolean;
  cachedSheetTransformRef?: React.MutableRefObject<{ translateX: number; translateY: number; scaleFactor: number } | null>;
  // Annotation props
  annotation2DActiveTool?: Annotation2DTool;
  annotation2DCursorPos?: Point2D | null;
  polygonAreaPoints?: Point2D[];
  polygonAreaResults?: PolygonArea2DResult[];
  textAnnotations?: TextAnnotation2D[];
  textAnnotationEditing?: string | null;
  cloudAnnotationPoints?: Point2D[];
  cloudAnnotations?: CloudAnnotation2D[];
  // Selection
  selectedAnnotation?: SelectedAnnotation2D | null;
  // IFC annotation overlay (issue #812)
  ifcAnnotationLines?: readonly DrawingLine2D[];
  ifcAnnotationTexts?: readonly AnnotationText2D[];
  ifcAnnotationFills?: readonly AnnotationFill2D[];
}

export function Drawing2DCanvas({
  drawing,
  transform,
  showHiddenLines,
  overrideEngine,
  overridesEnabled,
  entityColorMap,
  useIfcMaterials,
  measureMode = false,
  measureStart = null,
  measureCurrent = null,
  measureResults = EMPTY_MEASURE_RESULTS,
  measureSnapPoint = null,
  sheetEnabled = false,
  activeSheet = null,
  sectionAxis,
  isPinned = false,
  cachedSheetTransformRef,
  annotation2DActiveTool = 'none',
  annotation2DCursorPos = null,
  polygonAreaPoints = [],
  polygonAreaResults = [],
  textAnnotations = [],
  textAnnotationEditing = null,
  cloudAnnotationPoints = [],
  cloudAnnotations = [],
  selectedAnnotation = null,
  ifcAnnotationLines,
  ifcAnnotationTexts,
  ifcAnnotationFills,
}: Drawing2DCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // ResizeObserver to track canvas size changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize((prev) => {
          // Only update if size actually changed to avoid render loops
          if (prev.width !== width || prev.height !== height) {
            return { width, height };
          }
          return prev;
        });
      }
    });

    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width === 0 || canvasSize.height === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size using tracked dimensions
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    ctx.scale(dpr, dpr);

    // Clear with light gray background (shows paper edge when in sheet mode)
    ctx.fillStyle = sheetEnabled && activeSheet ? '#e5e5e5' : '#ffffff';
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    // ═══════════════════════════════════════════════════════════════════════
    // SHEET MODE: Render paper, frame, title block, then drawing in viewport
    // ═══════════════════════════════════════════════════════════════════════
    if (sheetEnabled && activeSheet) {
      const paper = activeSheet.paper;
      const frame = activeSheet.frame;
      const titleBlock = activeSheet.titleBlock;
      const viewport = activeSheet.viewportBounds;
      const scaleBar = activeSheet.scaleBar;
      const northArrow = activeSheet.northArrow;

      // Helper: convert sheet mm to screen pixels
      const mmToScreen = (mm: number) => mm * transform.scale;
      const mmToScreenX = (x: number) => x * transform.scale + transform.x;
      const mmToScreenY = (y: number) => y * transform.scale + transform.y;

      // ─────────────────────────────────────────────────────────────────────
      // 1. Draw paper background (white with shadow)
      // ─────────────────────────────────────────────────────────────────────
      ctx.save();
      // Paper shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
      ctx.shadowBlur = 10 * (transform.scale > 0.5 ? 1 : transform.scale * 2);
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(
        mmToScreenX(0),
        mmToScreenY(0),
        mmToScreen(paper.widthMm),
        mmToScreen(paper.heightMm)
      );
      ctx.restore();

      // Paper border
      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        mmToScreenX(0),
        mmToScreenY(0),
        mmToScreen(paper.widthMm),
        mmToScreen(paper.heightMm)
      );

      // ─────────────────────────────────────────────────────────────────────
      // 2. Draw frame borders
      // ─────────────────────────────────────────────────────────────────────
      const frameLeft = frame.margins.left + frame.margins.bindingMargin;
      const frameTop = frame.margins.top;
      const frameRight = paper.widthMm - frame.margins.right;
      const frameBottom = paper.heightMm - frame.margins.bottom;
      const frameWidth = frameRight - frameLeft;
      const frameHeight = frameBottom - frameTop;

      // Outer border
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, mmToScreen(frame.border.outerLineWeight));
      ctx.strokeRect(
        mmToScreenX(frameLeft),
        mmToScreenY(frameTop),
        mmToScreen(frameWidth),
        mmToScreen(frameHeight)
      );

      // Inner border (if gap > 0)
      if (frame.border.borderGap > 0) {
        const innerLeft = frameLeft + frame.border.borderGap;
        const innerTop = frameTop + frame.border.borderGap;
        const innerWidth = frameWidth - 2 * frame.border.borderGap;
        const innerHeight = frameHeight - 2 * frame.border.borderGap;

        ctx.lineWidth = Math.max(0.5, mmToScreen(frame.border.innerLineWeight));
        ctx.strokeRect(
          mmToScreenX(innerLeft),
          mmToScreenY(innerTop),
          mmToScreen(innerWidth),
          mmToScreen(innerHeight)
        );
      }

      // ─────────────────────────────────────────────────────────────────────
      // 3. Draw title block
      // ─────────────────────────────────────────────────────────────────────
      const innerLeft = frameLeft + frame.border.borderGap;
      const innerTop = frameTop + frame.border.borderGap;
      const innerWidth = frameWidth - 2 * frame.border.borderGap;
      const innerHeight = frameHeight - 2 * frame.border.borderGap;

      let tbX: number, tbY: number, tbW: number, tbH: number;
      switch (titleBlock.position) {
        case 'bottom-right':
          tbW = titleBlock.widthMm;
          tbH = titleBlock.heightMm;
          tbX = innerLeft + innerWidth - tbW;
          tbY = innerTop + innerHeight - tbH;
          break;
        case 'bottom-full':
          tbW = innerWidth;
          tbH = titleBlock.heightMm;
          tbX = innerLeft;
          tbY = innerTop + innerHeight - tbH;
          break;
        case 'right-strip':
          tbW = titleBlock.widthMm;
          tbH = innerHeight;
          tbX = innerLeft + innerWidth - tbW;
          tbY = innerTop;
          break;
        default:
          tbW = titleBlock.widthMm;
          tbH = titleBlock.heightMm;
          tbX = innerLeft + innerWidth - tbW;
          tbY = innerTop + innerHeight - tbH;
      }

      // Title block border
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, mmToScreen(titleBlock.borderWeight));
      ctx.strokeRect(
        mmToScreenX(tbX),
        mmToScreenY(tbY),
        mmToScreen(tbW),
        mmToScreen(tbH)
      );

      // Title block fields - calculate row heights based on font sizes
      const logoSpace = titleBlock.logo ? 50 : 0;
      const revisionSpace = titleBlock.showRevisionHistory ? 20 : 0;
      const availableWidth = tbW - logoSpace - 5;
      const availableHeight = tbH - revisionSpace - 4;
      const numCols = 2;

      // Group fields by row
      const fieldsByRow = new Map<number, typeof titleBlock.fields>();
      for (const field of titleBlock.fields) {
        const row = field.row ?? 0;
        if (!fieldsByRow.has(row)) fieldsByRow.set(row, []);
        fieldsByRow.get(row)!.push(field);
      }

      // Calculate minimum height needed for each row based on its largest font
      const rowCount = Math.max(...Array.from(fieldsByRow.keys()), 0) + 1;
      const rowHeights: number[] = [];
      let totalMinHeight = 0;

      for (let r = 0; r < rowCount; r++) {
        const fields = fieldsByRow.get(r) || [];
        const maxFontSize = fields.length > 0 ? Math.max(...fields.map(f => f.fontSize)) : 3;
        const labelSize = Math.min(maxFontSize * 0.5, 2.2);
        const minRowHeight = labelSize + 1 + maxFontSize + 2;
        rowHeights.push(minRowHeight);
        totalMinHeight += minRowHeight;
      }

      // Scale row heights if they exceed available space
      const rowScaleFactor = totalMinHeight > availableHeight ? availableHeight / totalMinHeight : 1;
      const scaledRowHeights = rowHeights.map(h => h * rowScaleFactor);

      const colWidth = availableWidth / numCols;
      const gridStartX = tbX + logoSpace + 2;
      const gridStartY = tbY + 2;

      // Calculate row Y positions
      const rowYPositions: number[] = [gridStartY];
      for (let i = 0; i < scaledRowHeights.length - 1; i++) {
        rowYPositions.push(rowYPositions[i] + scaledRowHeights[i]);
      }

      // Draw grid lines
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(0.5, mmToScreen(titleBlock.gridWeight));

      // Horizontal lines
      for (let i = 1; i < rowCount; i++) {
        const lineY = rowYPositions[i];
        ctx.beginPath();
        ctx.moveTo(mmToScreenX(gridStartX), mmToScreenY(lineY));
        ctx.lineTo(mmToScreenX(gridStartX + availableWidth - 4), mmToScreenY(lineY));
        ctx.stroke();
      }

      // Vertical dividers (for rows with multiple columns)
      for (const [row, fields] of fieldsByRow) {
        const hasMultipleCols = fields.some(f => (f.colSpan ?? 1) < 2);
        if (hasMultipleCols) {
          const centerX = gridStartX + colWidth;
          const lineY1 = rowYPositions[row];
          const lineY2 = rowYPositions[row] + scaledRowHeights[row];
          ctx.beginPath();
          ctx.moveTo(mmToScreenX(centerX), mmToScreenY(lineY1));
          ctx.lineTo(mmToScreenX(centerX), mmToScreenY(lineY2));
          ctx.stroke();
        }
      }

      // Render field text - scale proportionally with zoom
      for (const [row, fields] of fieldsByRow) {
        const rowY = rowYPositions[row];
        if (rowY === undefined) continue;

        const rowH = scaledRowHeights[row] ?? 5;
        const screenRowH = mmToScreen(rowH);

        // Skip if row is too small to be readable
        if (screenRowH < 4) continue;

        for (const field of fields) {
          const col = field.col ?? 0;
          const fieldX = gridStartX + col * colWidth + 1.5;

          // Calculate font sizes in mm (accounting for compressed rows)
          const effectiveScale = rowScaleFactor < 1 ? rowScaleFactor : 1;
          const labelFontMm = Math.min(field.fontSize * 0.45, 2.2) * Math.max(effectiveScale, 0.7);
          const valueFontMm = field.fontSize * Math.max(effectiveScale, 0.7);

          // Convert to screen pixels - scales naturally with zoom
          const screenLabelFont = mmToScreen(labelFontMm);
          const screenValueFont = mmToScreen(valueFontMm);

          // Skip if too small to read
          if (screenLabelFont < 3) continue;

          const screenRowY = mmToScreenY(rowY);
          const screenFieldX = mmToScreenX(fieldX);

          // Label
          ctx.font = `${screenLabelFont}px Arial, sans-serif`;
          ctx.fillStyle = '#666666';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(field.label, screenFieldX, screenRowY + mmToScreen(0.3));

          // Value below label (spacing in mm, converted to screen)
          const valueY = screenRowY + mmToScreen(labelFontMm + 0.5);
          ctx.font = `${field.fontWeight === 'bold' ? 'bold ' : ''}${screenValueFont}px Arial, sans-serif`;
          ctx.fillStyle = '#000000';
          ctx.fillText(field.value, screenFieldX, valueY);
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 4. Clip to viewport and draw model content
      // ─────────────────────────────────────────────────────────────────────
      ctx.save();

      // Create clip region for viewport
      ctx.beginPath();
      ctx.rect(
        mmToScreenX(viewport.x),
        mmToScreenY(viewport.y),
        mmToScreen(viewport.width),
        mmToScreen(viewport.height)
      );
      ctx.clip();

      // Calculate drawing transform to fit in viewport
      const drawingBounds = {
        minX: drawing.bounds.min.x,
        minY: drawing.bounds.min.y,
        maxX: drawing.bounds.max.x,
        maxY: drawing.bounds.max.y,
      };

      // Axis-specific flipping
      const flipY = sectionAxis !== 'down';
      const flipX = sectionAxis === 'side';

      // Use cached transform when pinned, otherwise calculate new one
      let drawingTransform: { translateX: number; translateY: number; scaleFactor: number };

      if (isPinned && cachedSheetTransformRef?.current) {
        // Use cached transform to keep model fixed in place
        drawingTransform = cachedSheetTransformRef.current;
      } else {
        // Calculate new transform
        const baseTransform = calculateDrawingTransform(drawingBounds, viewport, activeSheet.scale);

        // Adjust for axis-specific flipping
        // calculateDrawingTransform assumes Y-flip (uses maxY), but for 'down' view we don't flip Y
        drawingTransform = {
          ...baseTransform,
          translateY: flipY
            ? baseTransform.translateY
            : baseTransform.translateY - (drawingBounds.maxY + drawingBounds.minY) * baseTransform.scaleFactor,
        };

        // Cache the transform for pinned mode
        if (cachedSheetTransformRef) {
          cachedSheetTransformRef.current = drawingTransform;
        }
      }

      // Apply combined transform: sheet mm -> screen, then drawing coords -> sheet mm
      // Drawing coord (meters) * scaleFactor = sheet mm, + translateX/Y
      // Then sheet mm -> screen via mmToScreenX/Y
      const drawModelContent = () => {
        // Determine flip behavior based on section axis
        // - 'down' (plan view): DON'T flip Y so north (Z+) is up
        // - 'front' and 'side': flip Y so height (Y+) is up
        // - 'side': also flip X to look from conventional direction

        // For each polygon/line, transform from model coords to screen coords
        const modelToScreen = (x: number, y: number) => {
          // Apply axis-specific flipping
          const adjustedX = flipX ? -x : x;
          const adjustedY = flipY ? -y : y;
          // Model to sheet mm
          const sheetX = adjustedX * drawingTransform.scaleFactor + drawingTransform.translateX;
          const sheetY = adjustedY * drawingTransform.scaleFactor + drawingTransform.translateY;
          // Sheet mm to screen
          return { x: mmToScreenX(sheetX), y: mmToScreenY(sheetY) };
        };

        // Line width in screen pixels (convert mm to screen)
        const mmLineToScreen = (mmWeight: number) => Math.max(0.5, mmToScreen(mmWeight / drawingTransform.scaleFactor * 0.001));

        // Fill cut polygons
        for (const polygon of drawing.cutPolygons) {
          let fillColor = getFillColorForType(polygon.ifcType);
          let opacity = 1;

          if (useIfcMaterials) {
            const materialColor = entityColorMap.get(polygon.entityId);
            if (materialColor) {
              const r = Math.round(materialColor[0] * 255);
              const g = Math.round(materialColor[1] * 255);
              const b = Math.round(materialColor[2] * 255);
              fillColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              opacity = materialColor[3];
            }
          } else if (overridesEnabled) {
            const elementData: ElementData = {
              expressId: polygon.entityId,
              ifcType: polygon.ifcType,
            };
            const result = overrideEngine.applyOverrides(elementData);
            fillColor = result.style.fillColor;
            opacity = result.style.opacity;
          }

          ctx.globalAlpha = opacity;
          ctx.fillStyle = fillColor;
          ctx.beginPath();

          if (polygon.polygon.outer.length > 0) {
            const first = modelToScreen(polygon.polygon.outer[0].x, polygon.polygon.outer[0].y);
            ctx.moveTo(first.x, first.y);
            for (let i = 1; i < polygon.polygon.outer.length; i++) {
              const pt = modelToScreen(polygon.polygon.outer[i].x, polygon.polygon.outer[i].y);
              ctx.lineTo(pt.x, pt.y);
            }
            ctx.closePath();

            for (const hole of polygon.polygon.holes) {
              if (hole.length > 0) {
                const holeFirst = modelToScreen(hole[0].x, hole[0].y);
                ctx.moveTo(holeFirst.x, holeFirst.y);
                for (let i = 1; i < hole.length; i++) {
                  const pt = modelToScreen(hole[i].x, hole[i].y);
                  ctx.lineTo(pt.x, pt.y);
                }
                ctx.closePath();
              }
            }
          }
          ctx.fill('evenodd');
          ctx.globalAlpha = 1;
        }

        // Stroke polygon outlines
        for (const polygon of drawing.cutPolygons) {
          let strokeColor = '#000000';
          let lineWeight = 0.5;

          if (overridesEnabled) {
            const elementData: ElementData = {
              expressId: polygon.entityId,
              ifcType: polygon.ifcType,
            };
            const result = overrideEngine.applyOverrides(elementData);
            strokeColor = result.style.strokeColor;
            lineWeight = result.style.lineWeight;
          }

          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = Math.max(0.5, mmToScreen(lineWeight) * 0.3);
          ctx.beginPath();

          if (polygon.polygon.outer.length > 0) {
            const first = modelToScreen(polygon.polygon.outer[0].x, polygon.polygon.outer[0].y);
            ctx.moveTo(first.x, first.y);
            for (let i = 1; i < polygon.polygon.outer.length; i++) {
              const pt = modelToScreen(polygon.polygon.outer[i].x, polygon.polygon.outer[i].y);
              ctx.lineTo(pt.x, pt.y);
            }
            ctx.closePath();

            for (const hole of polygon.polygon.holes) {
              if (hole.length > 0) {
                const holeFirst = modelToScreen(hole[0].x, hole[0].y);
                ctx.moveTo(holeFirst.x, holeFirst.y);
                for (let i = 1; i < hole.length; i++) {
                  const pt = modelToScreen(hole[i].x, hole[i].y);
                  ctx.lineTo(pt.x, pt.y);
                }
                ctx.closePath();
              }
            }
          }
          ctx.stroke();
        }

        // Draw lines (projection, silhouette, etc.)
        const lineBounds = drawing.bounds;
        const lineMargin = Math.max(lineBounds.max.x - lineBounds.min.x, lineBounds.max.y - lineBounds.min.y) * 0.5;
        const lineMinX = lineBounds.min.x - lineMargin;
        const lineMaxX = lineBounds.max.x + lineMargin;
        const lineMinY = lineBounds.min.y - lineMargin;
        const lineMaxY = lineBounds.max.y + lineMargin;

        for (const line of drawing.lines) {
          if (line.category === 'cut') continue;
          if (!showHiddenLines && line.visibility === 'hidden') continue;

          const { start, end } = line.line;
          if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(end.x) || !isFinite(end.y)) continue;
          if (start.x < lineMinX || start.x > lineMaxX || start.y < lineMinY || start.y > lineMaxY ||
            end.x < lineMinX || end.x > lineMaxX || end.y < lineMinY || end.y > lineMaxY) continue;

          let strokeColor = '#000000';
          let lineWidth = 0.25;
          let dashPattern: number[] = [];

          switch (line.category) {
            case 'projection': lineWidth = 0.25; break;
            case 'hidden': lineWidth = 0.18; strokeColor = '#666666'; dashPattern = [4, 2]; break;
            case 'silhouette': lineWidth = 0.35; break;
            case 'crease': lineWidth = 0.18; break;
            case 'boundary': lineWidth = 0.25; break;
            case 'annotation': lineWidth = 0.13; break;
          }

          if (line.visibility === 'hidden') {
            strokeColor = '#888888';
            dashPattern = [4, 2];
            lineWidth *= 0.7;
          }

          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = Math.max(0.5, mmToScreen(lineWidth) * 0.3);
          ctx.setLineDash(dashPattern);

          const screenStart = modelToScreen(start.x, start.y);
          const screenEnd = modelToScreen(end.x, end.y);

          ctx.beginPath();
          ctx.moveTo(screenStart.x, screenStart.y);
          ctx.lineTo(screenEnd.x, screenEnd.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // IFC annotation overlay (issue #812)
        drawIfcAnnotationsScreenSpace(
          ctx,
          ifcAnnotationLines,
          ifcAnnotationTexts,
          ifcAnnotationFills,
          modelToScreen,
          (mm) => Math.max(0.5, mmToScreen(mm) * 0.3),
          (worldHeight) => Math.max(8, worldHeight * drawingTransform.scaleFactor * transform.scale),
        );
      };

      drawModelContent();
      ctx.restore();

      // ─────────────────────────────────────────────────────────────────────
      // 6. Draw scale bar at BOTTOM LEFT of title block
      // Uses actual drawingTransform.scaleFactor which accounts for dynamic scaling
      // ─────────────────────────────────────────────────────────────────────
      if (scaleBar.visible && tbH > 10) {
        // Position: bottom left with small margin
        const sbX = tbX + 3;
        const sbY = tbY + tbH - 8; // 8mm from bottom (leaves room for label)

        // Calculate effective scale from the actual drawing transform
        // scaleFactor = mm per meter, so effective scale ratio = 1000 / scaleFactor
        const effectiveScaleFactor = drawingTransform.scaleFactor;

        // Scale bar length: we want to show a nice round number of meters
        // Calculate how many mm on paper for the desired real-world length
        const maxBarWidth = Math.min(tbW * 0.3, 50); // Max 30% of width or 50mm

        // Find a nice round length that fits
        // Start with the configured length and adjust if needed
        let targetLengthM = scaleBar.totalLengthM;
        let sbLengthMm = targetLengthM * effectiveScaleFactor;

        // If bar would be too long, reduce the target length
        while (sbLengthMm > maxBarWidth && targetLengthM > 0.5) {
          targetLengthM = targetLengthM / 2;
          sbLengthMm = targetLengthM * effectiveScaleFactor;
        }

        // If bar would be too short, increase the target length
        while (sbLengthMm < maxBarWidth * 0.3 && targetLengthM < 100) {
          targetLengthM = targetLengthM * 2;
          sbLengthMm = targetLengthM * effectiveScaleFactor;
        }

        // Clamp to max width
        sbLengthMm = Math.min(sbLengthMm, maxBarWidth);

        // Actual length represented by the bar
        const actualTotalLength = sbLengthMm / effectiveScaleFactor;

        const sbHeight = Math.min(scaleBar.heightMm, 3);

        // Scale bar divisions
        const divisions = scaleBar.primaryDivisions;
        const divWidth = sbLengthMm / divisions;
        for (let i = 0; i < divisions; i++) {
          ctx.fillStyle = i % 2 === 0 ? scaleBar.fillColor : '#ffffff';
          ctx.fillRect(
            mmToScreenX(sbX + i * divWidth),
            mmToScreenY(sbY),
            mmToScreen(divWidth),
            mmToScreen(sbHeight)
          );
        }

        // Scale bar border
        ctx.strokeStyle = scaleBar.strokeColor;
        ctx.lineWidth = Math.max(1, mmToScreen(scaleBar.lineWeight));
        ctx.strokeRect(
          mmToScreenX(sbX),
          mmToScreenY(sbY),
          mmToScreen(sbLengthMm),
          mmToScreen(sbHeight)
        );

        // Distance labels - only at 0 and end
        const labelFontSize = Math.max(7, mmToScreen(1.8));
        ctx.font = `${labelFontSize}px Arial, sans-serif`;
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';
        const labelScreenY = mmToScreenY(sbY + sbHeight) + 1;

        ctx.textAlign = 'left';
        ctx.fillText('0', mmToScreenX(sbX), labelScreenY);

        ctx.textAlign = 'right';
        const endLabel = actualTotalLength < 1
          ? `${(actualTotalLength * 100).toFixed(0)}cm`
          : `${actualTotalLength.toFixed(0)}m`;
        ctx.fillText(endLabel, mmToScreenX(sbX + sbLengthMm), labelScreenY);
      }

      // ─────────────────────────────────────────────────────────────────────
      // 7. Draw north arrow at BOTTOM RIGHT of title block
      // ─────────────────────────────────────────────────────────────────────
      if (northArrow.style !== 'none' && tbH > 10) {
        // Position: bottom right with margin
        const naSize = Math.min(northArrow.sizeMm, 8, tbH * 0.6);
        const naX = tbX + tbW - naSize - 5; // Right side with margin
        const naY = tbY + tbH - naSize / 2 - 3; // Bottom with margin

        ctx.save();
        ctx.translate(mmToScreenX(naX), mmToScreenY(naY));
        ctx.rotate((northArrow.rotation * Math.PI) / 180);

        // Draw arrow
        const arrowLen = mmToScreen(naSize);
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.moveTo(0, -arrowLen / 2);
        ctx.lineTo(-arrowLen / 6, arrowLen / 2);
        ctx.lineTo(0, arrowLen / 3);
        ctx.lineTo(arrowLen / 6, arrowLen / 2);
        ctx.closePath();
        ctx.fill();

        // Draw "N" label
        const nFontSize = Math.max(8, mmToScreen(2.5));
        ctx.font = `bold ${nFontSize}px Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('N', 0, -arrowLen / 2 - 1);

        ctx.restore();
      }

    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // NON-SHEET MODE: Original rendering (drawing coords -> screen)
      // ═══════════════════════════════════════════════════════════════════════

      // Apply transform with axis-specific flipping
      // - 'down' (plan view): DON'T flip Y so north (Z+) is up
      // - 'front' and 'side': flip Y so height (Y+) is up
      // - 'side': also flip X to look from conventional direction
      const scaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
      const scaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;

      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(scaleX, scaleY);

      // ═══════════════════════════════════════════════════════════════════════
      // 1. FILL CUT POLYGONS (with color from IFC materials, override engine, or type fallback)
      // ═══════════════════════════════════════════════════════════════════════
      for (const polygon of drawing.cutPolygons) {
        // Get fill color - priority: IFC materials > override engine > IFC type fallback
        let fillColor = getFillColorForType(polygon.ifcType);
        let strokeColor = '#000000';
        let opacity = 1;

        // Use actual IFC material colors from the mesh data
        if (useIfcMaterials) {
          const materialColor = entityColorMap.get(polygon.entityId);
          if (materialColor) {
            // Convert RGBA [0-1] to hex color
            const r = Math.round(materialColor[0] * 255);
            const g = Math.round(materialColor[1] * 255);
            const b = Math.round(materialColor[2] * 255);
            fillColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
            opacity = materialColor[3];
          }
        } else if (overridesEnabled) {
          const elementData: ElementData = {
            expressId: polygon.entityId,
            ifcType: polygon.ifcType,
          };
          const result = overrideEngine.applyOverrides(elementData);
          fillColor = result.style.fillColor;
          strokeColor = result.style.strokeColor;
          opacity = result.style.opacity;
        }

        ctx.globalAlpha = opacity;
        ctx.fillStyle = fillColor;
        ctx.beginPath();
        if (polygon.polygon.outer.length > 0) {
          ctx.moveTo(polygon.polygon.outer[0].x, polygon.polygon.outer[0].y);
          for (let i = 1; i < polygon.polygon.outer.length; i++) {
            ctx.lineTo(polygon.polygon.outer[i].x, polygon.polygon.outer[i].y);
          }
          ctx.closePath();

          // Draw holes (inner boundaries)
          for (const hole of polygon.polygon.holes) {
            if (hole.length > 0) {
              ctx.moveTo(hole[0].x, hole[0].y);
              for (let i = 1; i < hole.length; i++) {
                ctx.lineTo(hole[i].x, hole[i].y);
              }
              ctx.closePath();
            }
          }
        }
        ctx.fill('evenodd');
        ctx.globalAlpha = 1;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // 2. STROKE CUT POLYGON OUTLINES (with color from override engine)
      // ═══════════════════════════════════════════════════════════════════════
      for (const polygon of drawing.cutPolygons) {
        let strokeColor = '#000000';
        let lineWeight = 0.5;

        if (overridesEnabled) {
          const elementData: ElementData = {
            expressId: polygon.entityId,
            ifcType: polygon.ifcType,
          };
          const result = overrideEngine.applyOverrides(elementData);
          strokeColor = result.style.strokeColor;
          lineWeight = result.style.lineWeight;
        }

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWeight / transform.scale;
        ctx.beginPath();
        if (polygon.polygon.outer.length > 0) {
          ctx.moveTo(polygon.polygon.outer[0].x, polygon.polygon.outer[0].y);
          for (let i = 1; i < polygon.polygon.outer.length; i++) {
            ctx.lineTo(polygon.polygon.outer[i].x, polygon.polygon.outer[i].y);
          }
          ctx.closePath();

          // Stroke holes too
          for (const hole of polygon.polygon.holes) {
            if (hole.length > 0) {
              ctx.moveTo(hole[0].x, hole[0].y);
              for (let i = 1; i < hole.length; i++) {
                ctx.lineTo(hole[i].x, hole[i].y);
              }
              ctx.closePath();
            }
          }
        }
        ctx.stroke();
      }

      // ═══════════════════════════════════════════════════════════════════════
      // 3. DRAW PROJECTION/SILHOUETTE LINES (skip 'cut' - already in polygons)
      // ═══════════════════════════════════════════════════════════════════════
      // Pre-compute bounds for line validation
      const lineBounds = drawing.bounds;
      const lineMargin = Math.max(lineBounds.max.x - lineBounds.min.x, lineBounds.max.y - lineBounds.min.y) * 0.5;
      const lineMinX = lineBounds.min.x - lineMargin;
      const lineMaxX = lineBounds.max.x + lineMargin;
      const lineMinY = lineBounds.min.y - lineMargin;
      const lineMaxY = lineBounds.max.y + lineMargin;

      for (const line of drawing.lines) {
        // Skip 'cut' lines - they're triangulation edges, already handled by polygons
        if (line.category === 'cut') continue;

        // Skip hidden lines if not showing
        if (!showHiddenLines && line.visibility === 'hidden') continue;

        // Skip lines with invalid coordinates (NaN, Infinity, or far outside bounds)
        const { start, end } = line.line;
        if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(end.x) || !isFinite(end.y)) {
          continue;
        }
        if (start.x < lineMinX || start.x > lineMaxX || start.y < lineMinY || start.y > lineMaxY ||
          end.x < lineMinX || end.x > lineMaxX || end.y < lineMinY || end.y > lineMaxY) {
          continue;
        }

        // Set line style based on category
        let strokeColor = '#000000';
        let lineWidth = 0.25;
        let dashPattern: number[] = [];

        switch (line.category) {
          case 'projection':
            lineWidth = 0.25;
            strokeColor = '#000000';
            break;
          case 'hidden':
            lineWidth = 0.18;
            strokeColor = '#666666';
            dashPattern = [2, 1];
            break;
          case 'silhouette':
            lineWidth = 0.35;
            strokeColor = '#000000';
            break;
          case 'crease':
            lineWidth = 0.18;
            strokeColor = '#000000';
            break;
          case 'boundary':
            lineWidth = 0.25;
            strokeColor = '#000000';
            break;
          case 'annotation':
            lineWidth = 0.13;
            strokeColor = '#000000';
            break;
        }

        // Hidden visibility overrides
        if (line.visibility === 'hidden') {
          strokeColor = '#888888';
          dashPattern = [2, 1];
          lineWidth *= 0.7;
        }

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth / transform.scale;
        ctx.setLineDash(dashPattern.map((d) => d / transform.scale));

        ctx.beginPath();
        ctx.moveTo(line.line.start.x, line.line.start.y);
        ctx.lineTo(line.line.end.x, line.line.end.y);
        ctx.stroke();

        ctx.setLineDash([]);
      }

      ctx.restore();

      // IFC annotation overlay (issue #812). Rendered after ctx.restore so we
      // can size lines and text in screen pixels rather than fighting the
      // ctx.scale applied above (which would inverse-scale everything).
      const directScaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
      const directScaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;
      drawIfcAnnotationsScreenSpace(
        ctx,
        ifcAnnotationLines,
        ifcAnnotationTexts,
        ifcAnnotationFills,
        (x, y) => ({ x: x * directScaleX + transform.x, y: y * directScaleY + transform.y }),
        // No paper scale here: take a baseline 0.3 px per "default mm" so
        // weights match the heavier projection lines visually. Annotation
        // strokes in IFC are intentionally lighter than projection lines,
        // but a hair too thin on a 1× screen disappears entirely.
        (mmWeight) => Math.max(0.5, mmWeight * transform.scale * 0.3),
        // World height directly to screen pixels through the active zoom.
        // 8 px floor so labels stay legible when zoomed way out.
        (worldHeight) => Math.max(8, worldHeight * transform.scale),
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. RENDER MEASUREMENTS (in screen space)
    // ═══════════════════════════════════════════════════════════════════════
    const drawMeasureLine = (
      start: { x: number; y: number },
      end: { x: number; y: number },
      distance: number,
      color: string = '#2196F3',
      isActive: boolean = false
    ) => {
      // Convert drawing coords to screen coords with axis-specific transforms
      const measureScaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
      const measureScaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;
      const screenStart = {
        x: start.x * measureScaleX + transform.x,
        y: start.y * measureScaleY + transform.y,
      };
      const screenEnd = {
        x: end.x * measureScaleX + transform.x,
        y: end.y * measureScaleY + transform.y,
      };

      // Draw line
      ctx.strokeStyle = color;
      ctx.lineWidth = isActive ? 2 : 1.5;
      ctx.setLineDash(isActive ? [6, 3] : []);
      ctx.beginPath();
      ctx.moveTo(screenStart.x, screenStart.y);
      ctx.lineTo(screenEnd.x, screenEnd.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw endpoints
      ctx.fillStyle = color;
      const endpointRadius = isActive ? 5 : 4;
      ctx.beginPath();
      ctx.arc(screenStart.x, screenStart.y, endpointRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(screenEnd.x, screenEnd.y, endpointRadius, 0, Math.PI * 2);
      ctx.fill();

      // Draw distance label
      const midX = (screenStart.x + screenEnd.x) / 2;
      const midY = (screenStart.y + screenEnd.y) / 2;

      // Format distance using shared utility
      const labelText = formatDistance(distance);

      // Background for label
      ctx.font = '12px system-ui, sans-serif';
      const textMetrics = ctx.measureText(labelText);
      const padding = 4;
      const bgWidth = textMetrics.width + padding * 2;
      const bgHeight = 18;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(midX - bgWidth / 2, midY - bgHeight / 2, bgWidth, bgHeight);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(midX - bgWidth / 2, midY - bgHeight / 2, bgWidth, bgHeight);

      // Text
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, midX, midY);
    };

    // Draw completed measurements
    for (const result of measureResults) {
      drawMeasureLine(result.start, result.end, result.distance, '#2196F3', false);
    }

    // Draw active measurement
    if (measureStart && measureCurrent) {
      const dx = measureCurrent.x - measureStart.x;
      const dy = measureCurrent.y - measureStart.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      drawMeasureLine(measureStart, measureCurrent, distance, '#FF5722', true);
    }

    // Draw snap indicator
    if (measureMode && measureSnapPoint) {
      // Use axis-specific transforms (matching canvas rendering)
      const snapScaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
      const snapScaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;
      const screenSnap = {
        x: measureSnapPoint.x * snapScaleX + transform.x,
        y: measureSnapPoint.y * snapScaleY + transform.y,
      };

      // Draw snap crosshair
      ctx.strokeStyle = '#4CAF50';
      ctx.lineWidth = 1.5;
      const snapSize = 12;

      ctx.beginPath();
      ctx.moveTo(screenSnap.x - snapSize, screenSnap.y);
      ctx.lineTo(screenSnap.x + snapSize, screenSnap.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(screenSnap.x, screenSnap.y - snapSize);
      ctx.lineTo(screenSnap.x, screenSnap.y + snapSize);
      ctx.stroke();

      // Draw snap circle
      ctx.beginPath();
      ctx.arc(screenSnap.x, screenSnap.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 5. RENDER POLYGON AREA MEASUREMENTS (in screen space)
    // ═══════════════════════════════════════════════════════════════════════
    const annotScaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
    const annotScaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;
    const drawingToScreenX = (x: number) => x * annotScaleX + transform.x;
    const drawingToScreenY = (y: number) => y * annotScaleY + transform.y;

    // Draw completed polygon areas
    for (const result of polygonAreaResults) {
      if (result.points.length < 3) continue;

      // Draw filled polygon
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = '#2196F3';
      ctx.beginPath();
      const first = result.points[0];
      ctx.moveTo(drawingToScreenX(first.x), drawingToScreenY(first.y));
      for (let i = 1; i < result.points.length; i++) {
        ctx.lineTo(drawingToScreenX(result.points[i].x), drawingToScreenY(result.points[i].y));
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // Draw outline
      ctx.strokeStyle = '#2196F3';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(drawingToScreenX(first.x), drawingToScreenY(first.y));
      for (let i = 1; i < result.points.length; i++) {
        ctx.lineTo(drawingToScreenX(result.points[i].x), drawingToScreenY(result.points[i].y));
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw vertex dots
      ctx.fillStyle = '#2196F3';
      for (const pt of result.points) {
        ctx.beginPath();
        ctx.arc(drawingToScreenX(pt.x), drawingToScreenY(pt.y), 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw area label at centroid
      const centroid = computePolygonCentroid(result.points);
      const cx = drawingToScreenX(centroid.x);
      const cy = drawingToScreenY(centroid.y);
      const areaText = formatArea(result.area);
      const perimText = `P: ${formatDistance(result.perimeter)}`;

      ctx.font = 'bold 12px system-ui, sans-serif';
      const areaMetrics = ctx.measureText(areaText);
      ctx.font = '10px system-ui, sans-serif';
      const perimMetrics = ctx.measureText(perimText);
      const labelW = Math.max(areaMetrics.width, perimMetrics.width) + 12;
      const labelH = 32;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fillRect(cx - labelW / 2, cy - labelH / 2, labelW, labelH);
      ctx.strokeStyle = '#2196F3';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - labelW / 2, cy - labelH / 2, labelW, labelH);

      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(areaText, cx, cy - 6);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#666666';
      ctx.fillText(perimText, cx, cy + 8);
    }

    // Draw in-progress polygon
    if (polygonAreaPoints.length > 0 && annotation2DActiveTool === 'polygon-area') {
      // Draw lines between placed vertices
      ctx.strokeStyle = '#FF5722';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      const first = polygonAreaPoints[0];
      ctx.moveTo(drawingToScreenX(first.x), drawingToScreenY(first.y));
      for (let i = 1; i < polygonAreaPoints.length; i++) {
        ctx.lineTo(drawingToScreenX(polygonAreaPoints[i].x), drawingToScreenY(polygonAreaPoints[i].y));
      }

      // Draw preview line from last vertex to cursor
      if (annotation2DCursorPos) {
        ctx.lineTo(drawingToScreenX(annotation2DCursorPos.x), drawingToScreenY(annotation2DCursorPos.y));
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // If 3+ points and cursor is near first vertex, show closing preview
      if (polygonAreaPoints.length >= 3 && annotation2DCursorPos) {
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = '#FF5722';
        ctx.beginPath();
        ctx.moveTo(drawingToScreenX(first.x), drawingToScreenY(first.y));
        for (let i = 1; i < polygonAreaPoints.length; i++) {
          ctx.lineTo(drawingToScreenX(polygonAreaPoints[i].x), drawingToScreenY(polygonAreaPoints[i].y));
        }
        ctx.lineTo(drawingToScreenX(annotation2DCursorPos.x), drawingToScreenY(annotation2DCursorPos.y));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Draw vertex dots
      ctx.fillStyle = '#FF5722';
      for (const pt of polygonAreaPoints) {
        ctx.beginPath();
        ctx.arc(drawingToScreenX(pt.x), drawingToScreenY(pt.y), 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // First vertex indicator (larger, shows it can be clicked to close)
      if (polygonAreaPoints.length >= 3) {
        ctx.strokeStyle = '#FF5722';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(drawingToScreenX(first.x), drawingToScreenY(first.y), 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. RENDER TEXT ANNOTATIONS (in screen space)
    // ═══════════════════════════════════════════════════════════════════════
    for (const textAnnotation of textAnnotations) {
      // Don't render text that is currently being edited (the editor overlay handles it)
      if (textAnnotation.id === textAnnotationEditing) continue;
      if (!textAnnotation.text.trim()) continue;

      const sx = drawingToScreenX(textAnnotation.position.x);
      const sy = drawingToScreenY(textAnnotation.position.y);

      ctx.font = `${textAnnotation.fontSize}px system-ui, sans-serif`;
      const lines = textAnnotation.text.split('\n');
      const lineHeight = textAnnotation.fontSize * 1.3;
      let maxWidth = 0;
      for (const line of lines) {
        const m = ctx.measureText(line);
        if (m.width > maxWidth) maxWidth = m.width;
      }

      const padding = 6;
      const bgW = maxWidth + padding * 2;
      const bgH = lines.length * lineHeight + padding * 2;

      // Background
      ctx.fillStyle = textAnnotation.backgroundColor;
      ctx.fillRect(sx, sy, bgW, bgH);

      // Border
      ctx.strokeStyle = textAnnotation.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx, sy, bgW, bgH);

      // Text
      ctx.fillStyle = textAnnotation.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], sx + padding, sy + padding + i * lineHeight);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7. RENDER CLOUD ANNOTATIONS (in screen space)
    // ═══════════════════════════════════════════════════════════════════════
    const screenScale = Math.abs(transform.scale);

    // Draw completed clouds
    for (const cloud of cloudAnnotations) {
      if (cloud.points.length < 2) continue;
      const p1 = cloud.points[0];
      const p2 = cloud.points[1];

      // Determine arc radius based on rectangle size (in drawing coords)
      const rectW = Math.abs(p2.x - p1.x);
      const rectH = Math.abs(p2.y - p1.y);
      const arcRadius = Math.min(rectW, rectH) * 0.15 || 0.2;

      // Draw cloud fill
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = cloud.color;
      drawCloudOnCanvas(ctx, p1, p2, arcRadius, drawingToScreenX, drawingToScreenY, screenScale);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Draw cloud stroke
      ctx.strokeStyle = cloud.color;
      ctx.lineWidth = 2;
      drawCloudOnCanvas(ctx, p1, p2, arcRadius, drawingToScreenX, drawingToScreenY, screenScale);
      ctx.stroke();

      // Draw label at center
      if (cloud.label) {
        const labelX = drawingToScreenX((p1.x + p2.x) / 2);
        const labelY = drawingToScreenY((p1.y + p2.y) / 2);

        ctx.font = 'bold 12px system-ui, sans-serif';
        const labelMetrics = ctx.measureText(cloud.label);
        const lW = labelMetrics.width + 10;
        const lH = 20;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(labelX - lW / 2, labelY - lH / 2, lW, lH);
        ctx.strokeStyle = cloud.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(labelX - lW / 2, labelY - lH / 2, lW, lH);

        ctx.fillStyle = cloud.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cloud.label, labelX, labelY);
      }
    }

    // Draw in-progress cloud (rectangle preview from first corner to cursor)
    if (cloudAnnotationPoints.length === 1 && annotation2DCursorPos && annotation2DActiveTool === 'cloud') {
      const p1 = cloudAnnotationPoints[0];
      const p2 = annotation2DCursorPos;

      const sx1 = drawingToScreenX(p1.x);
      const sy1 = drawingToScreenY(p1.y);
      const sx2 = drawingToScreenX(p2.x);
      const sy2 = drawingToScreenY(p2.y);

      ctx.strokeStyle = '#E53935';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(
        Math.min(sx1, sx2), Math.min(sy1, sy2),
        Math.abs(sx2 - sx1), Math.abs(sy2 - sy1)
      );
      ctx.setLineDash([]);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. RENDER SELECTION HIGHLIGHT
    // ═══════════════════════════════════════════════════════════════════════
    if (selectedAnnotation) {
      const SEL_COLOR = '#1976D2';
      const SEL_HANDLE_SIZE = 5;

      const drawSelectionRect = (x: number, y: number, w: number, h: number) => {
        const margin = 4;
        ctx.strokeStyle = SEL_COLOR;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x - margin, y - margin, w + margin * 2, h + margin * 2);
        ctx.setLineDash([]);

        // Corner handles
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = SEL_COLOR;
        ctx.lineWidth = 1.5;
        const corners = [
          [x - margin, y - margin],
          [x + w + margin, y - margin],
          [x - margin, y + h + margin],
          [x + w + margin, y + h + margin],
        ];
        for (const [cx, cy] of corners) {
          ctx.fillRect(cx - SEL_HANDLE_SIZE, cy - SEL_HANDLE_SIZE, SEL_HANDLE_SIZE * 2, SEL_HANDLE_SIZE * 2);
          ctx.strokeRect(cx - SEL_HANDLE_SIZE, cy - SEL_HANDLE_SIZE, SEL_HANDLE_SIZE * 2, SEL_HANDLE_SIZE * 2);
        }
      };

      switch (selectedAnnotation.type) {
        case 'measure': {
          const result = measureResults.find((r) => r.id === selectedAnnotation.id);
          if (result) {
            const sa = { x: drawingToScreenX(result.start.x), y: drawingToScreenY(result.start.y) };
            const sb = { x: drawingToScreenX(result.end.x), y: drawingToScreenY(result.end.y) };
            const minX = Math.min(sa.x, sb.x);
            const minY = Math.min(sa.y, sb.y);
            const w = Math.abs(sb.x - sa.x);
            const h = Math.abs(sb.y - sa.y);
            drawSelectionRect(minX, minY, w, h);
          }
          break;
        }
        case 'polygon': {
          const result = polygonAreaResults.find((r) => r.id === selectedAnnotation.id);
          if (result && result.points.length >= 3) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of result.points) {
              const sx = drawingToScreenX(pt.x);
              const sy = drawingToScreenY(pt.y);
              if (sx < minX) minX = sx;
              if (sy < minY) minY = sy;
              if (sx > maxX) maxX = sx;
              if (sy > maxY) maxY = sy;
            }
            drawSelectionRect(minX, minY, maxX - minX, maxY - minY);
          }
          break;
        }
        case 'text': {
          const annotation = textAnnotations.find((a) => a.id === selectedAnnotation.id);
          if (annotation && annotation.text.trim()) {
            const sx = drawingToScreenX(annotation.position.x);
            const sy = drawingToScreenY(annotation.position.y);
            ctx.font = `${annotation.fontSize}px system-ui, sans-serif`;
            const lines = annotation.text.split('\n');
            const lineHeight = annotation.fontSize * 1.3;
            const padding = 6;
            let maxWidth = 0;
            for (const line of lines) {
              const m = ctx.measureText(line);
              if (m.width > maxWidth) maxWidth = m.width;
            }
            const bgW = maxWidth + padding * 2;
            const bgH = lines.length * lineHeight + padding * 2;
            drawSelectionRect(sx, sy, bgW, bgH);
          }
          break;
        }
        case 'cloud': {
          const cloud = cloudAnnotations.find((a) => a.id === selectedAnnotation.id);
          if (cloud && cloud.points.length >= 2) {
            const sp1x = drawingToScreenX(cloud.points[0].x);
            const sp1y = drawingToScreenY(cloud.points[0].y);
            const sp2x = drawingToScreenX(cloud.points[1].x);
            const sp2y = drawingToScreenY(cloud.points[1].y);
            const minX = Math.min(sp1x, sp2x);
            const minY = Math.min(sp1y, sp2y);
            drawSelectionRect(minX, minY, Math.abs(sp2x - sp1x), Math.abs(sp2y - sp1y));
          }
          break;
        }
      }
    }
  }, [drawing, transform, showHiddenLines, canvasSize, overrideEngine, overridesEnabled, entityColorMap, useIfcMaterials, measureMode, measureStart, measureCurrent, measureResults, measureSnapPoint, sheetEnabled, activeSheet, sectionAxis, isPinned, annotation2DActiveTool, annotation2DCursorPos, polygonAreaPoints, polygonAreaResults, textAnnotations, textAnnotationEditing, cloudAnnotationPoints, cloudAnnotations, selectedAnnotation, ifcAnnotationLines, ifcAnnotationTexts, ifcAnnotationFills]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={CANVAS_STYLE}
    />
  );
}
