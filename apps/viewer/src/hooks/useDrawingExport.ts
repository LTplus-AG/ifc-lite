/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { resolvedElementTags, elementTagsSvg } from '@/lib/drawing/element-tags';
import { elementTagsDxf, drawElementTagsPdf } from '@/lib/drawing/element-tag-export';
import { buildDxfUnderlaySvg, drawDxfUnderlaysPdf, mappedDxfUnderlayOptions } from '@/lib/export/drawing-vector-underlays';
import { drawingReferenceSvg, snapshotDrawingReferences, rasterizeReferenceLayer } from '@/lib/export/drawing-raster-references';
import type React from 'react';
import { posthog, trackExportCompleted } from '@/lib/analytics';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { useTranslation, type UseTranslationResult } from '@/i18n';
import { recordActivity } from '@/lib/activity/activity-journal';
import { pdfLineStyleFor } from '@/lib/export/pdf-line-style';
import {
  GraphicOverrideEngine,
  renderFrame,
  renderTitleBlock,
  exportToDXF,
  formatScaleFactorLabel,
  makeEntityKey, isPolygonCutLine, entityIdAttr, escapeXml, svgNum,
  type Drawing2D,
  type PdfScaleLayout,
  type DrawingSheet,
  type TitleBlockExtras,
} from '@ifc-lite/drawing-2d';
import { computePdfSectionLayout, makeSectionMapPoint } from '@/hooks/pdfSectionLayout';
import { resolveSheetTransform } from '@/lib/drawing/sheet-transform';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key';
import { formatDistance } from '@/components/viewer/tools/formatDistance';
import { formatArea, computePolygonCentroid } from '@/components/viewer/tools/computePolygonArea';
import { generateCloudSVGPath } from '@/components/viewer/tools/cloudPathGenerator';
import type { PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D } from '@/store/slices/drawing2DSlice';
import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { buildDxfExportTransform, resolveDxfExportGeoreference } from '@/hooks/dxfExportGeoref';
import { createDxfDownload } from '@/hooks/dxfDownload';
import { rasterizeSvgToPngDataUrl, SHEET_PDF_DPI } from './drawing-svg-raster';
export { rasterizeSvgToPngDataUrl, SHEET_PDF_DPI, MAX_SHEET_RASTER_PIXELS, MAX_SHEET_RASTER_DIMENSION_PX } from './drawing-svg-raster';
import { DEFAULT_SCAN_SVG_CAP, type ScanBandPoint } from '@/hooks/scanSectionMath';
import { assertValidSvgDrawingBounds, computeSvgExportViewport, svgExportMmToWorld, svgExportScale } from '@/hooks/svgExportViewport';
import { polygonPathData } from '@/hooks/svgPolygonPath';
import { makePropertiesGetter } from '@/hooks/drawingElementProperties';
import { styleCutPolygons, type CutPolygonStyleContext } from '@/components/viewer/drawing/cut-polygon-style';
import { drawCutPolygonsPdf, isPagePoint, prepareCutPolygonsPdf, type PdfCutPolygon } from '@/lib/export/section-pdf-cut-polygons';
import { titleBlockWithEffectiveScale } from '@/hooks/titleBlockScaleField';
import { scanOutlineDxfLayers, type ScanOutlineLayer } from '@/lib/scan-outline/scan-outline';
import { boundsWithDimensions, dimensionsToSvg, drawDimensionsPdf } from '@/lib/export/dimension-export';
import { noticeOtherCutDimensionsLeftOut, useExportDimensionGraphics, type ExportDimensionGraphics } from '@/hooks/useExportDimensions';

type DrawingSvg = { svg: string; warnings: string[] };

function tryDrawingSvg(generate: () => DrawingSvg | null): DrawingSvg | null {
  try { return generate(); }
  catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return null; }
}

/**
 * Render the point-cloud scan overlay as SVG circles (issue #1805), capped
 * hard at `DEFAULT_SCAN_SVG_CAP` (independent of, and typically tighter
 * than, the on-screen render cap) so an exported file stays a sane size —
 * a deterministic stride, same technique `selectScanBand` uses for the
 * render cap, keeps the exported subset reproducible.
 */
function buildScanSectionSvg(
  points: readonly ScanBandPoint[],
  mapPoint: (x: number, y: number) => { x: number; y: number },
  radiusModelUnits: number,
  opacity: number,
  cap: number = DEFAULT_SCAN_SVG_CAP,
): string {
  if (points.length === 0 || opacity <= 0) return '';
  const stride = points.length > cap ? Math.ceil(points.length / cap) : 1;
  let svg = `  <g id="scan-section" opacity="${svgNum(opacity, 2)}">\n`;
  for (let i = 0; i < points.length; i += stride) {
    const p = mapPoint(points[i].point.x, points[i].point.y);
    const color = points[i].color;
    const fill = color
      ? `#${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
      : '#8a8a8a';
    svg += `    <circle cx="${svgNum(p.x, 4)}" cy="${svgNum(p.y, 4)}" r="${svgNum(radiusModelUnits, 4)}" fill="${fill}" stroke="none"/>\n`;
  }
  svg += '  </g>\n';
  return svg;
}

export interface UseDrawingExportParams {
  drawing: Drawing2D | null;
  displayOptions: {
    showHiddenLines: boolean;
    scale: number;
    showScanSection: boolean;
    scanSectionOpacity: number;
    scanSectionIncludeInExport: boolean;
  };
  sectionPlane: { axis: 'down' | 'front' | 'side'; position: number; flipped: boolean; custom?: unknown };
  activePresetId: string | null;
  entityColorMap: Map<number, [number, number, number, number]>;
  overridesEnabled: boolean;
  overrideEngine: GraphicOverrideEngine;
  measure2DResults: Array<{ id: string; start: { x: number; y: number }; end: { x: number; y: number }; distance: number }>;
  polygonArea2DResults: PolygonArea2DResult[];
  textAnnotations2D: TextAnnotation2D[];
  cloudAnnotations2D: CloudAnnotation2D[];
  sheetEnabled: boolean;
  activeSheet: DrawingSheet | null;
  /** DXF underlays pre-mapped to drawing space, rendered beneath the drawing (issue #1782) */
  dxfUnderlays: readonly DxfUnderlayRenderData[];
  /** Legacy single-model data store — the anchor-selection fallback for the DXF georeference lookup (issue #1861); federated models come from the store's `models` map. */
  ifcDataStore: IfcDataStore | null;
  /** Geometry coordinate info (RTC offset + origin shift), for the DXF world-coordinate re-derivation (issue #1861). */
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
  /** Point-cloud scan overlay, already in drawing space (issue #1805), and its traced outline (#6871) */
  scanSection: { points: readonly ScanBandPoint[]; outline?: ScanOutlineLayer | null };
  /** Pin View state, shared with the preview canvas. While pinned the sheet
   *  placement is HELD across a regenerate; print/export must honour the same
   *  held placement or it silently prints a different layout from the one on
   *  screen (see `resolveSheetTransform`). */
  isPinned?: boolean;
  /** The preview's pinned-transform cache. Read-only here — the preview owns
   *  the write, so exporting never perturbs what is on screen. */
  cachedSheetTransformRef?: React.MutableRefObject<CachedSheetTransform | null>;
}

export interface NativeDrawingArtifact { blob: Blob; filename: string; warnings: string[]; georeferenced?: boolean }
/** The panel's toolbar used to do nothing when no drawing was ready; it still does. */
class NoNativeDrawingError extends Error { constructor() { super('No completed native drawing is available.'); } }
/** A requested 1:N scale whose page layout is out of range (shown with the scale-specific message). */
class InvalidPdfScaleError extends Error {}
export interface UseDrawingExportResult {
  createSvgArtifact(): NativeDrawingArtifact;
  createDxfArtifact(): NativeDrawingArtifact;
  createPdfArtifact(scaleFactor?: number): Promise<NativeDrawingArtifact>;
  getExportDimensionGraphics: (paperScale: number) => ReturnType<ReturnType<typeof useExportDimensionGraphics>>;
  formatDistance: (distance: number) => string;
  handleExportSVG: () => void;
  handleExportDXF: () => void;
  /**
   * Export the section as a true-vector PDF at an exact scale (issue #2042).
   * `scaleFactor` is the "N" in "1:N" (e.g. 100 for 1:100); omit to use the
   * drawing's current on-screen scale ("as displayed").
   */
  handleExportPDF: (scaleFactor?: number) => void;
  handlePrint: () => void;
}

export function createDrawingExport({
  drawing,
  displayOptions,
  sectionPlane,
  activePresetId,
  entityColorMap,
  overridesEnabled,
  overrideEngine,
  polygonArea2DResults,
  textAnnotations2D,
  cloudAnnotations2D,
  sheetEnabled,
  activeSheet,
  dxfUnderlays,
  ifcDataStore,
  coordinateInfo,
  scanSection,
  isPinned = false,
  cachedSheetTransformRef,
}: UseDrawingExportParams, services: { t: UseTranslationResult['t']; dimensionGraphicsAt: ExportDimensionGraphics; warn?: (message: string) => void }): UseDrawingExportResult {
  const { t, dimensionGraphicsAt } = services;
  // Georef inputs for the DXF export (PR #1871 review, P1): placement edits
  // applied in CesiumPlacementEditor live in `georefMutations` (per model
  // id), not in `ifcDataStore`, and in a federation the georef frame is the
  // ANCHOR model's, not necessarily the legacy store's. Read the same store
  // fields ViewportContainer's Cesium georef memo reads so
  // `resolveDxfExportGeoreference` sees the identical inputs.
  const { models: storeModels, anchorModelIdOverride, georefMutations } = useViewerStore.getState();

  // One properties cache per export, shared by every cut polygon it styles.
  const cutPolygonStyleContext = (): CutPolygonStyleContext => ({
    useIfcMaterials: activePresetId === 'preset-3d-colors',
    entityColorMap,
    overridesEnabled,
    overrideEngine,
    getElementProperties: makePropertiesGetter(storeModels, ifcDataStore),
  });

  // A nonempty outer ring produces no path when a mapped vertex is non-finite.
  const cutPolygonWarnings = (styled: ReadonlyArray<{ polygon: { polygon: { outer: readonly unknown[] } }; geometry: string }>): string[] => {
    const count = styled.filter((p) => !p.geometry && p.polygon.polygon.outer.length > 0).length;
    if (count === 0) return [];
    const one = count === 1;
    return [`${count} cut polygon${one ? '' : 's'} with invalid coordinates ${one ? 'was' : 'were'} left out of the drawing.`];
  };

  // Generate SVG that matches the canvas rendering exactly
  const generateExportSVG = (): DrawingSvg | null => {
    if (!drawing) return null;

    const { bounds } = drawing;
    assertValidSvgDrawingBounds(bounds);
    const styleContext = cutPolygonStyleContext();

    // World-metres -> paper-mm arithmetic for the direct SVG export,
    // extracted to svgExportViewport.ts (see that file's docstring for why
    // this transform doesn't map points at all — the SVG's own
    // width/height-vs-viewBox ratio does the scaling).
    // Same scale as the viewport below, so a negative or NaN scale cannot size the dimensions differently.
    const dims = dimensionGraphicsAt(svgExportScale(displayOptions.scale), sectionPlane.axis); // the viewBox must hold them too
    const viewport = computeSvgExportViewport(boundsWithDimensions(bounds, dims), displayOptions.scale, sectionPlane.axis);
    const { widthMm: svgWidthMm, heightMm: svgHeightMm, viewBoxMinX, viewBoxMinY, viewBoxWidth: viewWidth, viewBoxHeight: viewHeight, flipX, flipY, effectiveScale } = viewport;

    // Convert mm on paper to model units (meters)
    // At 1:100 scale, 1mm on paper = 0.1m in model space
    // Formula: modelUnits = paperMm * scale / 1000
    const mmToModel = (mm: number) => svgExportMmToWorld(mm, effectiveScale);

    // flipX/flipY (axis-specific, matching canvas rendering) come from
    // `viewport` above — computeSvgExportViewport resolves the same
    // 'down'/'front'/'side' rule this hook used to compute inline.

    // Helper to get polygon path with axis-specific coordinate transformation
    const polygonToPath = (polygon: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }): string =>
      polygonPathData(polygon, (x, y) => ({ x: flipX ? -x : x, y: flipY ? -y : y }));

    // Start building SVG
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${svgNum(svgWidthMm, 2)}mm"
     height="${svgNum(svgHeightMm, 2)}mm"
     viewBox="${svgNum(viewBoxMinX, 4)} ${svgNum(viewBoxMinY, 4)} ${svgNum(viewWidth, 4)} ${svgNum(viewHeight, 4)}">
  <rect x="${svgNum(viewBoxMinX, 4)}" y="${svgNum(viewBoxMinY, 4)}" width="${svgNum(viewWidth, 4)}" height="${svgNum(viewHeight, 4)}" fill="#FFFFFF"/>
`;

    const mapUnderlay = (x: number, y: number) => ({ x: flipX ? -x : x, y: flipY ? -y : y });
    svg += drawingReferenceSvg(useViewerStore.getState(), drawing.config.plane, mapUnderlay);
    // Shared drawing-space geometry; apply the same final axis mapping as IFC.
    svg += buildDxfUnderlaySvg(
      dxfUnderlays,
      mapUnderlay,
      mmToModel,
      1, // text height is already in model units (metres)
      escapeXml,
    );

    // 1. FILL CUT POLYGONS (with color from IFC materials or override engine)
    const styledPolygons = styleCutPolygons(drawing.cutPolygons, styleContext, (p) => polygonToPath(p.polygon));
    svg += '  <g id="polygon-fills">\n';
    for (const { polygon, style: { fillColor, fillOpacity }, geometry: pathData } of styledPolygons) {
      if (!pathData) continue;
      svg += `    <path d="${pathData}" fill="${escapeXml(fillColor)}" fill-opacity="${svgNum(fillOpacity, 2)}" fill-rule="evenodd" ${entityIdAttr(polygon.entityId)} data-ifc-type="${escapeXml(polygon.ifcType)}"/>\n`;
    }
    svg += '  </g>\n';

    // 2. STROKE CUT POLYGON OUTLINES (with color from override engine)
    svg += '  <g id="polygon-outlines">\n';
    for (const { polygon, style: { strokeColor, lineWeight }, geometry: pathData } of styledPolygons) {
      // Convert line weight (mm on paper) to model units
      const svgLineWeight = mmToModel(lineWeight);
      if (!pathData) continue;
      svg += `    <path d="${pathData}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${svgNum(svgLineWeight, 4)}" ${entityIdAttr(polygon.entityId)}/>\n`;
    }
    svg += '  </g>\n';

    // 3. DRAW PROJECTION/SILHOUETTE LINES
    // Pre-compute bounds for line validation
    const lineBounds = drawing.bounds;
    const lineMargin = Math.max(lineBounds.max.x - lineBounds.min.x, lineBounds.max.y - lineBounds.min.y) * 0.5;
    const lineMinX = lineBounds.min.x - lineMargin;
    const lineMaxX = lineBounds.max.x + lineMargin;
    const lineMinY = lineBounds.min.y - lineMargin;
    const lineMaxY = lineBounds.max.y + lineMargin;

    svg += '  <g id="drawing-lines">\n';
    for (const line of drawing.lines) {
      if (isPolygonCutLine(line)) continue;

      // Skip hidden lines if not showing
      if (!displayOptions.showHiddenLines && line.visibility === 'hidden') continue;

      // Skip lines with invalid coordinates
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
      let dashArray = '';

      switch (line.category) {
        case 'cut': lineWidth = 0.5; break;
        case 'projection':
          lineWidth = 0.25;
          strokeColor = '#000000';
          break;
        case 'hidden':
          lineWidth = 0.18;
          strokeColor = '#666666';
          dashArray = '2 1';
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
        dashArray = '2 1';
        lineWidth *= 0.7;
      }

      // Convert line width from mm on paper to model units
      const svgLineWidth = mmToModel(lineWidth);
      const dashAttr = dashArray ? ` stroke-dasharray="${dashArray.split(' ').map(d => svgNum(mmToModel(parseFloat(d)), 4)).join(' ')}"` : '';

      // Transform line endpoints with axis-specific flipping
      const startT = { x: flipX ? -start.x : start.x, y: flipY ? -start.y : start.y };
      const endT = { x: flipX ? -end.x : end.x, y: flipY ? -end.y : end.y };
      svg += `    <line x1="${svgNum(startT.x, 4)}" y1="${svgNum(startT.y, 4)}" x2="${svgNum(endT.x, 4)}" y2="${svgNum(endT.y, 4)}" stroke="${strokeColor}" stroke-width="${svgNum(svgLineWidth, 4)}"${dashAttr}/>\n`;
    }
    svg += '  </g>\n';

    // 5. DRAW POLYGON AREA MEASUREMENTS
    if (polygonArea2DResults.length > 0) {
      svg += '  <g id="polygon-area-measurements">\n';
      for (const result of polygonArea2DResults) {
        if (result.points.length < 3) continue;
        const pointsStr = result.points.map(p => {
          const pt = { x: flipX ? -p.x : p.x, y: flipY ? -p.y : p.y };
          return `${svgNum(pt.x, 4)},${svgNum(pt.y, 4)}`;
        }).join(' ');

        const measureColor = '#2196F3';
        const lineWidth = mmToModel(0.3);

        svg += `    <polygon points="${pointsStr}" fill="rgba(33,150,243,0.1)" stroke="${measureColor}" stroke-width="${svgNum(lineWidth, 4)}" stroke-dasharray="${svgNum(mmToModel(1), 4)} ${svgNum(mmToModel(0.5), 4)}"/>\n`;

        // Label at centroid
        const centroid = computePolygonCentroid(result.points);
        const ct = { x: flipX ? -centroid.x : centroid.x, y: flipY ? -centroid.y : centroid.y };
        const areaText = formatArea(result.area);
        const fontSize = mmToModel(3);

        svg += `    <text x="${svgNum(ct.x, 4)}" y="${svgNum(ct.y, 4)}" font-family="Arial, sans-serif" font-size="${svgNum(fontSize, 4)}" fill="#000000" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escapeXml(areaText)}</text>\n`;
      }
      svg += '  </g>\n';
    }

    // 6. DRAW TEXT ANNOTATIONS
    if (textAnnotations2D.length > 0) {
      svg += '  <g id="text-annotations">\n';
      for (const annotation of textAnnotations2D) {
        if (!annotation.text.trim()) continue;
        const pt = { x: flipX ? -annotation.position.x : annotation.position.x, y: flipY ? -annotation.position.y : annotation.position.y };
        const fontSize = mmToModel(2.5);
        const padding = mmToModel(1);
        const lines = annotation.text.split('\n');
        const lineHeight = fontSize * 1.3;
        const approxWidth = Math.max(...lines.map(l => l.length * fontSize * 0.6)) + padding * 2;
        const height = lines.length * lineHeight + padding * 2;

        svg += `    <rect x="${svgNum(pt.x, 4)}" y="${svgNum(pt.y, 4)}" width="${svgNum(approxWidth, 4)}" height="${svgNum(height, 4)}" fill="${escapeXml(annotation.backgroundColor)}" stroke="${escapeXml(annotation.borderColor)}" stroke-width="${svgNum(mmToModel(0.15), 4)}"/>\n`;
        for (let i = 0; i < lines.length; i++) {
          svg += `    <text x="${svgNum((pt.x + padding), 4)}" y="${svgNum((pt.y + padding + fontSize * 0.8 + i * lineHeight), 4)}" font-family="Arial, sans-serif" font-size="${svgNum(fontSize, 4)}" fill="${escapeXml(annotation.color)}">${escapeXml(lines[i])}</text>\n`;
        }
      }
      svg += '  </g>\n';
    }

    // 7. DRAW CLOUD ANNOTATIONS
    if (cloudAnnotations2D.length > 0) {
      svg += '  <g id="cloud-annotations">\n';
      for (const cloud of cloudAnnotations2D) {
        if (cloud.points.length < 2) continue;
        const rectW = Math.abs(cloud.points[1].x - cloud.points[0].x);
        const rectH = Math.abs(cloud.points[1].y - cloud.points[0].y);
        const arcRadius = Math.min(rectW, rectH) * 0.15 || 0.2;

        const transformX = (x: number) => flipX ? -x : x;
        const transformY = (y: number) => flipY ? -y : y;
        const pathData = generateCloudSVGPath(cloud.points[0], cloud.points[1], arcRadius, transformX, transformY);
        const lineWidth = mmToModel(0.4);

        svg += `    <path d="${pathData}" fill="rgba(229,57,53,0.05)" stroke="${escapeXml(cloud.color)}" stroke-width="${svgNum(lineWidth, 4)}"/>\n`;

        if (cloud.label) {
          const cx = transformX((cloud.points[0].x + cloud.points[1].x) / 2);
          const cy = transformY((cloud.points[0].y + cloud.points[1].y) / 2);
          const fontSize = mmToModel(3);
          svg += `    <text x="${svgNum(cx, 4)}" y="${svgNum(cy, 4)}" font-family="Arial, sans-serif" font-size="${svgNum(fontSize, 4)}" fill="${escapeXml(cloud.color)}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escapeXml(cloud.label)}</text>\n`;
        }
      }
      svg += '  </g>\n';
    }

    // POINT-CLOUD SCAN OVERLAY (issue #1805) — on top, same drawing-space
    // content as cutPolygons/lines, so it needs the same flipX/flipY the
    // rest of this direct export applies via `transformPt`.
    if (displayOptions.showScanSection && displayOptions.scanSectionIncludeInExport) {
      svg += buildScanSectionSvg(
        scanSection.points,
        (x, y) => ({ x: flipX ? -x : x, y: flipY ? -y : y }),
        mmToModel(0.3),
        displayOptions.scanSectionOpacity,
      );
    }

    svg += elementTagsSvg(resolvedElementTags(drawing), (x, y) => ({ x: flipX ? -x : x, y: flipY ? -y : y }), mmToModel(3.5));
    svg += dimensionsToSvg(dims, (x, y) => ({ x: flipX ? -x : x, y: flipY ? -y : y }), mmToModel);
    svg += '</svg>';
    return { svg, warnings: cutPolygonWarnings(styledPolygons) };
  };

  // Generate SVG with drawing sheet (frame, title block, scale bar)
  // This generates coordinates directly in paper mm space (like the canvas rendering)
  const generateSheetSVG = (): DrawingSvg | null => {
    if (!drawing || !activeSheet) return null;

    const { bounds } = drawing;
    const styleContext = cutPolygonStyleContext();

    // Sheet dimensions in mm
    const paperWidth = activeSheet.paper.widthMm;
    const paperHeight = activeSheet.paper.heightMm;
    const viewport = activeSheet.viewportBounds;

    // Flips, cache read and the axis-corrected transform all come from the
    // ONE resolver the preview canvas (`Drawing2DCanvas.tsx`) also calls, so
    // print/export cannot derive any of the three separately (#2940: print
    // used the raw, always-Y-flip-assuming transform, which only matched the
    // preview for axes that flip Y and left plan ('down') sections off-centre
    // on paper; and print recomputed from current bounds while a PINNED
    // preview held a cached placement).
    //
    // Read-only on the cache by construction: `resolveSheetTransform` never
    // writes, and this path does not write either — printing must not move
    // what is on screen.
    const resolved = resolveSheetTransform({
      sheet: activeSheet,
      drawingBounds: { minX: bounds.min.x, minY: bounds.min.y, maxX: bounds.max.x, maxY: bounds.max.y },
      axis: sectionPlane.axis,
      isPinned,
      cached: cachedSheetTransformRef?.current,
    });
    const { flipX, flipY } = resolved;
    const { translateX, translateY, scaleFactor } = resolved.transform;

    // Helper: convert model coordinates to paper mm (matching canvas rendering exactly)
    const modelToPaper = (x: number, y: number): { x: number; y: number } => {
      const adjustedX = flipX ? -x : x;
      const adjustedY = flipY ? -y : y;
      return {
        x: adjustedX * scaleFactor + translateX,
        y: adjustedY * scaleFactor + translateY,
      };
    };

    // Start building SVG (paper coordinates in mm)
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${paperWidth}mm"
     height="${paperHeight}mm"
     viewBox="0 0 ${paperWidth} ${paperHeight}">
  <!-- Background -->
  <rect x="0" y="0" width="${paperWidth}" height="${paperHeight}" fill="#FFFFFF"/>

`;

    // Create clipping path for viewport FIRST (so it can be used by drawing content)
    svg += `  <defs>
    <clipPath id="viewport-clip">
      <rect x="${svgNum(viewport.x, 2)}" y="${svgNum(viewport.y, 2)}" width="${svgNum(viewport.width, 2)}" height="${svgNum(viewport.height, 2)}"/>
    </clipPath>
  </defs>

`;

    // Drawing content FIRST (so frame/title block render on top)
    svg += `  <g id="drawing-content" clip-path="url(#viewport-clip)">
`;

    // Helper to get polygon path in paper coordinates
    const polygonToPath = (polygon: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }): string =>
      polygonPathData(polygon, modelToPaper);

    svg += drawingReferenceSvg(useViewerStore.getState(), drawing.config.plane, modelToPaper);
    svg += buildDxfUnderlaySvg(
      dxfUnderlays,
      modelToPaper,
      (mm) => mm, // CAD lineweights are paper millimetres, as in raw SVG/PDF.
      scaleFactor, // metres -> mm on paper
      escapeXml,
    );

    // Render polygon fills
    const styledPolygons = styleCutPolygons(drawing.cutPolygons, styleContext, (p) => polygonToPath(p.polygon));
    svg += '    <g id="polygon-fills">\n';
    for (const { polygon, style: { fillColor, fillOpacity }, geometry: pathData } of styledPolygons) {
      if (pathData) {
        svg += `      <path d="${pathData}" fill="${escapeXml(fillColor)}" fill-opacity="${svgNum(fillOpacity, 2)}" fill-rule="evenodd" ${entityIdAttr(polygon.entityId)} data-ifc-type="${escapeXml(polygon.ifcType)}"/>\n`;
      }
    }
    svg += '    </g>\n';

    // Render polygon outlines
    svg += '    <g id="polygon-outlines">\n';
    for (const { polygon, style: { strokeColor, lineWeight }, geometry: pathData } of styledPolygons) {
      if (pathData) {
        // lineWeight is in mm on paper
        const svgLineWeight = lineWeight * 0.3; // Scale down for better appearance
        svg += `      <path d="${pathData}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${svgNum(svgLineWeight, 4)}" ${entityIdAttr(polygon.entityId)}/>\n`;
      }
    }
    svg += '    </g>\n';

    // Render drawing lines
    const lineBounds = drawing.bounds;
    const lineMargin = Math.max(lineBounds.max.x - lineBounds.min.x, lineBounds.max.y - lineBounds.min.y) * 0.5;
    const lineMinX = lineBounds.min.x - lineMargin;
    const lineMaxX = lineBounds.max.x + lineMargin;
    const lineMinY = lineBounds.min.y - lineMargin;
    const lineMaxY = lineBounds.max.y + lineMargin;

    svg += '    <g id="drawing-lines">\n';
    for (const line of drawing.lines) {
      if (isPolygonCutLine(line)) continue;
      if (!displayOptions.showHiddenLines && line.visibility === 'hidden') continue;

      const { start, end } = line.line;
      if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(end.x) || !isFinite(end.y)) continue;
      if (start.x < lineMinX || start.x > lineMaxX || start.y < lineMinY || start.y > lineMaxY ||
        end.x < lineMinX || end.x > lineMaxX || end.y < lineMinY || end.y > lineMaxY) continue;

      let strokeColor = '#000000';
      let lineWidth = 0.25;
      let dashArray = '';

      switch (line.category) {
        case 'cut': lineWidth = 0.5; break;
        case 'projection': lineWidth = 0.25; break;
        case 'hidden': lineWidth = 0.18; strokeColor = '#666666'; dashArray = '1 0.5'; break;
        case 'silhouette': lineWidth = 0.35; break;
        case 'crease': lineWidth = 0.18; break;
        case 'boundary': lineWidth = 0.25; break;
        case 'annotation': lineWidth = 0.13; break;
      }

      if (line.visibility === 'hidden') {
        strokeColor = '#888888';
        dashArray = '1 0.5';
        lineWidth *= 0.7;
      }

      const paperStart = modelToPaper(start.x, start.y);
      const paperEnd = modelToPaper(end.x, end.y);

      // lineWidth is in mm on paper
      const svgLineWidth = lineWidth * 0.3;
      const dashAttr = dashArray ? ` stroke-dasharray="${dashArray}"` : '';
      svg += `      <line x1="${svgNum(paperStart.x, 4)}" y1="${svgNum(paperStart.y, 4)}" x2="${svgNum(paperEnd.x, 4)}" y2="${svgNum(paperEnd.y, 4)}" stroke="${strokeColor}" stroke-width="${svgNum(svgLineWidth, 4)}"${dashAttr}/>\n`;
    }
    svg += '    </g>\n';

    // POINT-CLOUD SCAN OVERLAY (issue #1805) — on top, inside the clipped
    // drawing-content group like everything else. `modelToPaper` already
    // applies the same flip + scale/translate the rest of the sheet uses.
    if (displayOptions.showScanSection && displayOptions.scanSectionIncludeInExport) {
      svg += buildScanSectionSvg(
        scanSection.points,
        modelToPaper,
        0.3, // mm on paper
        displayOptions.scanSectionOpacity,
      );
    }

    svg += elementTagsSvg(resolvedElementTags(drawing), modelToPaper, 3.5);
    svg += dimensionsToSvg(dimensionGraphicsAt(1000 / scaleFactor, { flipX, flipY }), modelToPaper, (mm) => mm);
    svg += '  </g>\n\n';
    // Render frame (on top of drawing content)
    const frameResult = renderFrame(activeSheet.paper, activeSheet.frame);
    svg += frameResult.svgElements;
    svg += '\n';

    // Render title block with scale bar and north arrow inside
    // Pass effectiveScaleFactor from the actual transform (not just configured scale)
    // This ensures scale bar shows correct values when dynamically scaled
    const titleBlockExtras: TitleBlockExtras = {
      scaleBar: activeSheet.scaleBar,
      northArrow: activeSheet.northArrow,
      scale: activeSheet.scale,
      effectiveScaleFactor: scaleFactor,
    };
    // Correct the "Scale" field for a viewport-fit-clamped sheet (#2131's
    // defect class; see titleBlockScaleField.ts).
    const titleBlockResult = renderTitleBlock(
      titleBlockWithEffectiveScale(activeSheet.titleBlock, activeSheet.scale.factor, scaleFactor),
      frameResult.innerBounds,
      activeSheet.revisions,
      titleBlockExtras
    );
    svg += titleBlockResult.svgElements;
    svg += '\n';

    svg += '</svg>';
    return { svg, warnings: cutPolygonWarnings(styledPolygons) };
  };
  const createSvgArtifact = (): NativeDrawingArtifact => {
    const result = sheetEnabled && activeSheet ? generateSheetSVG() : generateExportSVG();
    if (!result) throw new NoNativeDrawingError();
    const { svg, warnings } = result;
    for (const message of warnings) services.warn?.(message);
    const stem = sheetEnabled && activeSheet
      ? `${sanitizeFilename(activeSheet.name, { fallback: 'sheet' })}-${sectionPlane.axis}-${sectionPlane.position}`
      : `section-${sectionPlane.axis}-${sectionPlane.position}`;
    return { blob: new Blob([svg], { type: 'image/svg+xml' }), filename: `${stem}.svg`, warnings };
  };
  const handleExportSVG = () => {
    try { const artifact = createSvgArtifact(); downloadFile(artifact.blob, artifact.filename, 'image/svg+xml'); }
    catch (error) { if (!(error instanceof NoNativeDrawingError)) toast.error(error instanceof Error ? error.message : String(error)); return; }
    trackExportCompleted({ format: 'svg', surface: 'drawing_panel' });
    posthog.capture('drawing_exported', { format: 'svg', axis: sectionPlane.axis, sheet_enabled: sheetEnabled });
    noticeOtherCutDimensionsLeftOut(t);
  };
  // Export DXF (issue #1861). Unlike SVG, DXF has no paper space, so this
  // always exports the raw model-space drawing (sheet frame/title block are
  // not represented) — real-world metres, with a plan ('down') section
  // re-georeferenced to true IFC world coordinates (and further to
  // map/CRS coordinates when the model has an IfcMapConversion). DXF
  // reference vectors are embedded from the same mapped drawing geometry.
  // The point-cloud scan overlay (issue #1805) is likewise deliberately
  // excluded: it is a raster-like screen aid (tens of thousands of circles),
  // not vector content — SVG export carries it (opt-in) instead.
  const getExportDimensionGraphics = (paperScale: number) => dimensionGraphicsAt(paperScale, sectionPlane.axis);
  const createDxfArtifact = (): NativeDrawingArtifact => {
    if (!drawing) throw new NoNativeDrawingError();
    const isCustomPlane = sectionPlane.custom !== undefined;
    // Anchor-model effective georef, INCLUDING user placement edits
    // (georefMutations) — see resolveDxfExportGeoreference's docs. The
    // drawing-frame `coordinateInfo` below is unrelated: it undoes the
    // render-frame shift and stays the merged drawing's regardless of which
    // model anchors the georef.
    const georeference = resolveDxfExportGeoreference({
      models: storeModels,
      legacyDataStore: ifcDataStore,
      legacyCoordinateInfo: coordinateInfo,
      anchorModelIdOverride,
      georefMutations,
    });
    const coordinateTransform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: sectionPlane.axis,
      isCustomPlane,
      flipped: sectionPlane.flipped,
      georeference,
    });
    const isGeoreferenced = georeference !== null && sectionPlane.axis === 'down' && !isCustomPlane;
    // R12 has no $INSUNITS (see dxf/writer.ts); state the unit — and the
    // target CRS when the export is actually map-projected — in the 999
    // comment every DXF reader shows a human but none need to parse.
    const metadataComment = isGeoreferenced
      ? `ifc-lite section export - units: metres, CRS: ${georeference!.projectedCRS.name || 'unknown'}`
      : undefined;
    const dxf = exportToDXF(drawing, {
      showHiddenLines: displayOptions.showHiddenLines,
      coordinateTransform,
      metadataComment,
      underlays: [...mappedDxfUnderlayOptions(dxfUnderlays, sectionPlane.axis), elementTagsDxf(drawing, 3.5 * displayOptions.scale / 1000)],
      // The traced scan outline (#6871) on its own layer, through the same
      // georeference transform as the cut.
      polylineLayers: displayOptions.showScanSection ? scanOutlineDxfLayers(scanSection.outline) : [],
      dimensions: dimensionGraphicsAt(displayOptions.scale, sectionPlane.axis),
    });
    const stem = `section-${sectionPlane.axis}-${sectionPlane.position}`;
    const artifact = createDxfDownload(dxf, `${stem}.dxf`);
    const warnings = artifact.hadUnmappable ? ['Some characters have no DXF R12 text encoding and were exported as "?".'] : [];
    for (const message of warnings) services.warn?.(message);
    return { blob: artifact.blob, filename: artifact.filename, warnings, georeferenced: isGeoreferenced };
  };
  const handleExportDXF = () => {
    let artifact: NativeDrawingArtifact;
    try { artifact = createDxfArtifact(); downloadFile(artifact.blob, artifact.filename, 'application/dxf'); }
    catch (error) { if (!(error instanceof NoNativeDrawingError)) toast.error(error instanceof Error ? error.message : String(error)); return; }
    trackExportCompleted({ format: 'dxf', surface: 'drawing_panel' });
    posthog.capture('drawing_exported', { format: 'dxf', axis: sectionPlane.axis, georeferenced: artifact.georeferenced ?? false });
  };
  // Export scaled PDF (issue #2042): a true-vector PDF sized so the
  // requested scale ("1:N") is EXACT — the page itself is sized to the
  // drawing extent + margin (via computePdfScaleLayout) rather than fit
  // into a fixed named paper size, so the scale can never be silently
  // shrunk to make the drawing fit (see pdf-scale.ts for why that matters).
  //
  // Scope, deliberately smaller than the SVG export: cut-polygon fills and
  // outlines (same colours as the SVG, via resolveCutPolygonStyle) and
  // drawing LINES, live element tags and dimensions. Not yet included: text/cloud annotations, and the
  // point-cloud scan overlay. Those are straightforward follow-ups once this scale
  // plumbing is reviewed; see the PR description. Reference raster pages and
  // DXF vectors are included beneath these strokes (#6615).
  //
  // The drawing-sheet frame / title block / scale bar are NOT on that list
  // any more, and this path is not where they will arrive. It is the
  // NON-SHEET path: since #2941/#2942 the sheet case returns from the
  // branch at the top of `handleExportPDF` and never reaches here. This
  // path is still the only PDF export for the "as displayed" / scaled
  // drawing (#2042) and is not dead — it is the only true-vector PDF of
  // the DRAWING the viewer emits, so the branch above is where the raster
  // trade-off is written down. (Not the only vector PDF in the app:
  // `lib/lists/export/pdf.ts` writes a Lists/schedule report through
  // `jspdf-autotable` with no `addImage` at all. That is a table, not a
  // drawing. The 3D view export, `lib/export/view-pdf/`, IS a raster.)
  const createPdfArtifact = async (scaleFactor?: number, deliver?: (artifact: NativeDrawingArtifact) => void): Promise<NativeDrawingArtifact> => {
    const warnings: string[] = [];
    const warn = (message: string) => { warnings.push(message); services.warn?.(message); };
    if (!drawing) throw new NoNativeDrawingError();

    // Drawing Sheet mode (#2941: frame/title block/scale bar missing from
    // the PDF; #2942: nothing in the PDF is to scale). Root cause for both:
    // this handler never checked `sheetEnabled`/`activeSheet` at all — it
    // always ran the raw-drawing "v1" path below, which lays the cut
    // geometry onto a page sized by `computePdfSectionLayout` (fit-to-page)
    // at `displayOptions.scale` (the on-screen "as displayed" scale), never
    // the sheet's own paper size (activeSheet.paper, see
    // generateSheetSVG at line ~567) or its own scale
    // (activeSheet.scale.factor, generateSheetSVG line ~576). SVG/DXF/Print
    // all branch on `sheetEnabled && activeSheet` (e.g. handleExportSVG
    // above); PDF alone didn't. Reuse the already-correct sheet SVG instead
    // of re-deriving a second sheet layout for jsPDF's vector primitives.
    //
    // THE TRADE-OFF THIS BRANCH MAKES, stated so the next reader does not
    // have to rediscover it by zooming into an exported sheet:
    //
    //   A sheet-mode PDF is a RASTER, not vector. It carries one PNG per
    //   page ({@link SHEET_PDF_DPI}, capped by MAX_SHEET_RASTER_PIXELS),
    //   so its text and lines are resolution-dependent and will pixelate
    //   under zoom or on a plotter finer than the effective dpi.
    //
    // Before this branch existed, sheet mode fell through to the v1 path
    // below and produced true-vector output — but of the wrong drawing:
    // no frame, no title block, no scale bar (#2941) and at
    // `displayOptions.scale` rather than the sheet's own (#2942). So the
    // choice was not "vector vs raster", it was "a resolution-independent
    // PDF that is not the sheet and is not to scale" vs "the correct sheet
    // at the correct scale, rasterized". Correctness won.
    //
    // This shared producer preserves the established native raster sheet.
    // Converting its complete layout to vector is a separate output change
    // that needs its own sheet/scale oracle, rather than part of exposing
    // the existing exporter to another caller.
    //
    // The route for a user who needs vector today is the SVG export, which
    // is not an approximation of this: `handleExportSVG` above emits the
    // SAME `generateSheetSVG()` string, with no raster step at all. The
    // over-cap toast below already points there; this note records that
    // the recommendation applies to EVERY sheet PDF, not only capped ones.
    //
    // The non-sheet path below is untouched by any of this and stays true
    // vector — see `useDrawingExport.pdfVectorPaths.test.tsx`, which pins
    // both halves of that split.
    if (sheetEnabled && activeSheet) {
      const sheet = generateSheetSVG();
      if (!sheet) throw new Error('No completed native sheet is available.');
      const { widthMm, heightMm } = activeSheet.paper;
      return recordActivity({ kind: 'export', title: 'activityTray.job.export', panel: 'drawing',
        subject: `${activeSheet.name} · PDF` }, async () => {
          const { jsPDF } = await import('jspdf');
          const { dataUrl, fit } = await rasterizeSvgToPngDataUrl(sheet.svg, widthMm, heightMm);
          const doc = new jsPDF({
            unit: 'mm',
            format: [widthMm, heightMm],
            orientation: widthMm >= heightMm ? 'landscape' : 'portrait',
          });
          // Full paper rectangle, deliberately NOT `fit.widthPx / dpi`: the
          // image must span the sheet whatever the raster cost, or a capped
          // export would print a smaller sheet at the same nominal scale.
          doc.addImage(dataUrl, 'PNG', 0, 0, widthMm, heightMm);
          for (const message of sheet.warnings) warn(message);

          if (fit.capped) {
            // FLOOR, not round: 299.53 dpi renders as "reduced from 300 to
            // 300" under rounding, which reads as a no-op notice, and
            // overstating the resolution delivered is the direction that
            // misleads.
            warn(
              `Sheet rasterized at ${Math.floor(fit.effectiveDpi)} dpi instead of ` +
              `${SHEET_PDF_DPI} — a ${Math.round(widthMm)}x${Math.round(heightMm)} mm sheet ` +
              `exceeds the browser's canvas limit at full resolution. Use the SVG export ` +
              `for a vector sheet at any size.`,
            );
          }

          const stem = `${sanitizeFilename(activeSheet.name, { fallback: 'sheet' })}-${sectionPlane.axis}-${sectionPlane.position}`;
          const artifact = { blob: doc.output('blob'), filename: `${stem}.pdf`, warnings: [...warnings] };
          trackExportCompleted({ format: 'pdf', surface: 'drawing_panel' });
          posthog.capture('drawing_exported', {
            format: 'pdf',
            axis: sectionPlane.axis,
            scale_factor: activeSheet.scale.factor,
            sheet_enabled: true,
            // What the SHEET got, not what was asked for — the same
            // distinction `PdfViewExportDialog` records as `shading_dpi`.
            raster_dpi: Math.floor(fit.effectiveDpi),
            raster_capped: fit.capped,
          });
          deliver?.(artifact);
          return artifact;
      });
    }

    const effectiveScale = scaleFactor ?? displayOptions.scale ?? 100;

    // Axis-specific flipping, matching the SVG "as displayed" export above.
    // The layout (page size + offsets) MUST be derived from the bounds as
    // they are actually drawn (i.e. flipped), not the raw drawing bounds —
    // see pdfSectionLayout.ts module doc: deriving it from un-flipped bounds
    // only lands the drawing on the page when bounds happen to be symmetric
    // about zero, which is not the case for a model at ordinary world
    // coordinates (showstopper found on PR #2119).
    const currentAxis = sectionPlane.axis;
    const dimensionSnapshot = dimensionGraphicsAt(effectiveScale, currentAxis);
    let layout: PdfScaleLayout;
    try { layout = computePdfSectionLayout(boundsWithDimensions(drawing.bounds, dimensionSnapshot), currentAxis, effectiveScale, 10); }
    catch (err) { throw new InvalidPdfScaleError(err instanceof Error ? err.message : String(err)); }
    const mapPoint = makeSectionMapPoint(currentAxis, layout);

    // Prepared before the reference snapshot is taken, so a throw here cannot
    // strand it.
    const cutPolygons = prepareCutPolygonsPdf(drawing.cutPolygons, cutPolygonStyleContext(), mapPoint);
    const referenceSnapshot = snapshotDrawingReferences(useViewerStore.getState(), drawing.config.plane);
    // Own mapped vectors at click time; model/reference edits during async export
    // cannot replace the geometry whose bounds/scale were used above.
    const vectorSnapshot = structuredClone(dxfUnderlays);
    const tagSnapshot = resolvedElementTags(drawing);
    return recordActivity({ kind: 'export', title: 'activityTray.job.export', panel: 'drawing',
      subject: `section-${sectionPlane.axis}-${sectionPlane.position} · PDF` }, async () => {
      try {
        const { jsPDF } = await import('jspdf');
        const { widthMm, heightMm } = layout.page;
        const doc = new jsPDF({
          unit: 'mm',
          format: [widthMm, heightMm],
          orientation: widthMm >= heightMm ? 'landscape' : 'portrait',
        });

        const raster = await rasterizeReferenceLayer(referenceSnapshot, widthMm, heightMm, mapPoint);
        if (raster) doc.addImage(raster, 'PNG', 0, 0, widthMm, heightMm);
        drawDxfUnderlaysPdf(doc, vectorSnapshot, mapPoint, 1000 / effectiveScale);

        doc.setLineCap('round');

        drawCutPolygonsPdf(doc, cutPolygons);
        doc.setDrawColor(0, 0, 0);

        // Entities whose cut polygons are all `fillable` (see its doc). Loop
        // reconstruction (`PolygonBuilder.buildLoops`) can fail for short,
        // degenerate, or ambiguous cross-sections and drop an entity's
        // `cutPolygons` entirely while `drawing.lines` still carries valid
        // `category: 'cut'` edges for that same entity (same source
        // `cutSegments`, but polygon-building is a separate, fallible
        // reconstruction, not a lockstep derivation — see #2119 review). Skip
        // cut-category lines ONLY for entities that a polygon outline
        // already covers; otherwise they are the sole remaining record of
        // that cut and must still be drawn, or the geometry silently
        // vanishes from the PDF.
        // Per entity: one damaged polygon keeps all of that entity's cut lines.
        const entityKey = ({ polygon: p }: PdfCutPolygon) => makeEntityKey(p.modelIndex, p.entityId);
        const damaged = new Set(cutPolygons.filter((p) => !p.fillable).map(entityKey));
        const entitiesWithCutPolygon = new Set(cutPolygons.map(entityKey).filter((key) => !damaged.has(key)));

        // Drawing lines (projection/hidden/silhouette/crease/boundary).
        for (const line of drawing.lines) {
          if (
            isPolygonCutLine(line) &&
            entitiesWithCutPolygon.has(makeEntityKey(line.modelIndex, line.entityId))
          ) {
            continue;
          }
          if (!displayOptions.showHiddenLines && line.visibility === 'hidden') continue;

          const { start, end } = line.line;
          const p0 = mapPoint(start.x, start.y);
          const p1 = mapPoint(end.x, end.y);
          if (!isPagePoint(p0) || !isPagePoint(p1)) continue; // checked on the page, see isPagePoint

          // Shared with the to-scale 3D-view PDF (#2042) so the two writers
          // cannot drift into two different line hierarchies.
          const { lineWidthMm, dash } = pdfLineStyleFor(line.category, line.visibility);
          doc.setLineWidth(lineWidthMm);
          doc.setLineDashPattern(dash, 0);
          doc.line(p0.x, p0.y, p1.x, p1.y);
        }
        doc.setLineDashPattern([], 0);
        drawElementTagsPdf(doc, tagSnapshot, mapPoint);
        drawDimensionsPdf(doc, dimensionSnapshot, mapPoint);
        // v1 has no title block, so this filename is the SOLE record of the
        // sheet's scale — round-tripping through Math.round() here would
        // file a 1:99.5 export as "…-1-100", silently misreporting it (same
        // defect class as PR #2131's title-block scale label). Reuse that
        // formatting (round to 2dp, strip trailing zeros) instead of
        // re-deriving it.
        const stem = `section-${sectionPlane.axis}-${sectionPlane.position}-1-${formatScaleFactorLabel(effectiveScale)}`;
        const artifact = { blob: doc.output('blob'), filename: `${stem}.pdf`, warnings: [...warnings] };
        trackExportCompleted({ format: 'pdf', surface: 'drawing_panel' });
        posthog.capture('drawing_exported', {
          format: 'pdf',
          axis: sectionPlane.axis,
          scale_factor: effectiveScale,
        });
        deliver?.(artifact);
        return artifact;
      } finally { referenceSnapshot.release(); }
    });
  };

  const handleExportPDF = (scaleFactor?: number) => {
    void createPdfArtifact(scaleFactor, artifact => downloadFile(artifact.blob, artifact.filename, 'application/pdf'))
      .catch((error: unknown) => {
        if (error instanceof NoNativeDrawingError) return;
        if (error instanceof InvalidPdfScaleError) { toast.error(error.message ? t('section2d.export.invalidScaleDetail', { error: error.message }) : t('section2d.export.invalidScale')); return; }
        toast.error(error instanceof Error ? t('section2d.export.pdfFailed', { error: error.message }) : t('section2d.export.pdfFailedGeneric'));
      });
  };

  // Print handler
  const handlePrint = () => {
    // Use sheet export if enabled, otherwise raw drawing export
    const result = tryDrawingSvg(() => (sheetEnabled && activeSheet) ? generateSheetSVG() : generateExportSVG());
    if (!result) return;

    // Create a new window for printing
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      toast.error(t('section2d.export.allowPopups'));
      return;
    }

    const rawTitle = (sheetEnabled && activeSheet)
      ? `${activeSheet.name} - ${sectionPlane.axis} at ${sectionPlane.position}%`
      : `Section Drawing - ${sectionPlane.axis} at ${sectionPlane.position}%`;
    // The sheet name is user-controlled and interpolated into the <title> of a
    // same-origin window. Without escaping, a sheet named `</title><script>…`
    // would break out of the title and execute script. Escape it (the SVG body
    // is already escaped via escapeXml; the title was the one unescaped sink).
    const title = rawTitle
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Write print-friendly HTML with the SVG
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${title}</title>
          <style>
            @media print {
              @page { margin: ${(sheetEnabled && activeSheet) ? '0' : '1cm'}; }
              body { margin: 0; }
            }
            body {
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              padding: ${(sheetEnabled && activeSheet) ? '0' : '20px'};
              box-sizing: border-box;
            }
            svg {
              max-width: 100%;
              max-height: 100vh;
              width: auto;
              height: auto;
            }
          </style>
        </head>
        <body>
          ${result.svg}
          <script>
            window.onload = function() {
              window.print();
              window.onafterprint = function() { window.close(); };
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
    for (const message of result.warnings) services.warn?.(message);
    noticeOtherCutDimensionsLeftOut(t);
  };

  return {
    createSvgArtifact, createDxfArtifact, createPdfArtifact,
    getExportDimensionGraphics,
    formatDistance,
    handleExportSVG,
    handleExportDXF,
    handleExportPDF,
    handlePrint,
  };
}

function useDrawingExport(params: UseDrawingExportParams): UseDrawingExportResult {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models); const anchor = useViewerStore(s => s.anchorModelIdOverride);
  const georef = useViewerStore(s => s.georefMutations); const revision = useViewerStore(s => s.mutationVersion);
  const dimensionGraphicsAt = useExportDimensionGraphics(params.measure2DResults);
  return useMemo(() => createDrawingExport(params, { t, dimensionGraphicsAt, warn: message => toast.info(message) }), [
    t, dimensionGraphicsAt, models, anchor, georef, revision, params.drawing, params.displayOptions, params.sectionPlane,
    params.activePresetId, params.entityColorMap, params.overridesEnabled, params.overrideEngine, params.measure2DResults,
    params.polygonArea2DResults, params.textAnnotations2D, params.cloudAnnotations2D, params.sheetEnabled, params.activeSheet,
    params.dxfUnderlays, params.ifcDataStore, params.coordinateInfo, params.scanSection, params.isPinned, params.cachedSheetTransformRef,
  ]);
}
export { useDrawingExport };
export default useDrawingExport;
