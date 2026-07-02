/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { posthog } from '@/lib/analytics';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import {
  GraphicOverrideEngine,
  renderFrame,
  renderTitleBlock,
  calculateDrawingTransform,
  type Drawing2D,
  type DrawingSheet,
  type ElementData,
  type TitleBlockExtras,
} from '@ifc-lite/drawing-2d';
import { getFillColorForType } from '@/components/viewer/Drawing2DCanvas';
import { formatDistance } from '@/components/viewer/tools/formatDistance';
import { formatArea, computePolygonCentroid } from '@/components/viewer/tools/computePolygonArea';
import { generateCloudSVGPath } from '@/components/viewer/tools/cloudPathGenerator';
import type { PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D } from '@/store/slices/drawing2DSlice';

interface UseDrawingExportParams {
  drawing: Drawing2D | null;
  displayOptions: { showHiddenLines: boolean; scale: number };
  sectionPlane: { axis: 'down' | 'front' | 'side'; position: number; flipped: boolean };
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
}

interface UseDrawingExportResult {
  formatDistance: (distance: number) => string;
  handleExportSVG: () => void;
  handlePrint: () => void;
}

function useDrawingExport({
  drawing,
  displayOptions,
  sectionPlane,
  activePresetId,
  entityColorMap,
  overridesEnabled,
  overrideEngine,
  measure2DResults,
  polygonArea2DResults,
  textAnnotations2D,
  cloudAnnotations2D,
  sheetEnabled,
  activeSheet,
}: UseDrawingExportParams): UseDrawingExportResult {

  // Generate SVG that matches the canvas rendering exactly
  const generateExportSVG = useCallback((): string | null => {
    if (!drawing) return null;

    const { bounds } = drawing;
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;

    // Add padding around the drawing
    const padding = Math.max(width, height) * 0.1;
    const viewMinX = bounds.min.x - padding;
    const viewMinY = bounds.min.y - padding;
    const viewWidth = width + padding * 2;
    const viewHeight = height + padding * 2;

    // SVG dimensions in mm (assuming model is in meters, scale 1:100)
    const scale = displayOptions.scale || 100;
    const svgWidthMm = (viewWidth * 1000) / scale;
    const svgHeightMm = (viewHeight * 1000) / scale;

    // Convert mm on paper to model units (meters)
    // At 1:100 scale, 1mm on paper = 0.1m in model space
    // Formula: modelUnits = paperMm * scale / 1000
    const mmToModel = (mm: number) => mm * scale / 1000;

    // Helper to escape XML
    const escapeXml = (str: string): string => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };

    // Axis-specific flipping (matching canvas rendering)
    // - 'down' (plan view): DON'T flip Y so north (Z+) is up
    // - 'front' and 'side': flip Y so height (Y+) is up
    // - 'side': also flip X to look from conventional direction
    const currentAxis = sectionPlane.axis;
    const flipY = currentAxis !== 'down';
    const flipX = currentAxis === 'side';

    // Helper to get polygon path with axis-specific coordinate transformation
    const polygonToPath = (polygon: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }): string => {
      const transformPt = (x: number, y: number) => ({
        x: flipX ? -x : x,
        y: flipY ? -y : y,
      });

      let path = '';
      if (polygon.outer.length > 0) {
        const first = transformPt(polygon.outer[0].x, polygon.outer[0].y);
        path += `M ${first.x.toFixed(4)} ${first.y.toFixed(4)}`;
        for (let i = 1; i < polygon.outer.length; i++) {
          const pt = transformPt(polygon.outer[i].x, polygon.outer[i].y);
          path += ` L ${pt.x.toFixed(4)} ${pt.y.toFixed(4)}`;
        }
        path += ' Z';
      }
      for (const hole of polygon.holes) {
        if (hole.length > 0) {
          const holeFirst = transformPt(hole[0].x, hole[0].y);
          path += ` M ${holeFirst.x.toFixed(4)} ${holeFirst.y.toFixed(4)}`;
          for (let i = 1; i < hole.length; i++) {
            const pt = transformPt(hole[i].x, hole[i].y);
            path += ` L ${pt.x.toFixed(4)} ${pt.y.toFixed(4)}`;
          }
          path += ' Z';
        }
      }
      return path;
    };

    // Calculate viewBox with axis-specific flipping
    const viewBoxMinX = flipX ? -viewMinX - viewWidth : viewMinX;
    const viewBoxMinY = flipY ? -viewMinY - viewHeight : viewMinY;

    // Start building SVG
    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${svgWidthMm.toFixed(2)}mm"
     height="${svgHeightMm.toFixed(2)}mm"
     viewBox="${viewBoxMinX.toFixed(4)} ${viewBoxMinY.toFixed(4)} ${viewWidth.toFixed(4)} ${viewHeight.toFixed(4)}">
  <rect x="${viewBoxMinX.toFixed(4)}" y="${viewBoxMinY.toFixed(4)}" width="${viewWidth.toFixed(4)}" height="${viewHeight.toFixed(4)}" fill="#FFFFFF"/>
`;

    // 1. FILL CUT POLYGONS (with color from IFC materials or override engine)
    svg += '  <g id="polygon-fills">\n';
    for (const polygon of drawing.cutPolygons) {
      let fillColor = getFillColorForType(polygon.ifcType);
      let opacity = 1;

      // Use actual IFC material colors from the mesh data
      if (activePresetId === 'preset-3d-colors') {
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

      const pathData = polygonToPath(polygon.polygon);
      svg += `    <path d="${pathData}" fill="${fillColor}" fill-opacity="${opacity.toFixed(2)}" fill-rule="evenodd" data-entity-id="${polygon.entityId}" data-ifc-type="${escapeXml(polygon.ifcType)}"/>\n`;
    }
    svg += '  </g>\n';

    // 2. STROKE CUT POLYGON OUTLINES (with color from override engine)
    svg += '  <g id="polygon-outlines">\n';
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

      const pathData = polygonToPath(polygon.polygon);
      // Convert line weight (mm on paper) to model units
      const svgLineWeight = mmToModel(lineWeight);
      svg += `    <path d="${pathData}" fill="none" stroke="${strokeColor}" stroke-width="${svgLineWeight.toFixed(4)}" data-entity-id="${polygon.entityId}"/>\n`;
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
      // Skip 'cut' lines - they're triangulation edges, already handled by polygons
      if (line.category === 'cut') continue;

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
      const dashAttr = dashArray ? ` stroke-dasharray="${dashArray.split(' ').map(d => mmToModel(parseFloat(d)).toFixed(4)).join(' ')}"` : '';

      // Transform line endpoints with axis-specific flipping
      const startT = { x: flipX ? -start.x : start.x, y: flipY ? -start.y : start.y };
      const endT = { x: flipX ? -end.x : end.x, y: flipY ? -end.y : end.y };
      svg += `    <line x1="${startT.x.toFixed(4)}" y1="${startT.y.toFixed(4)}" x2="${endT.x.toFixed(4)}" y2="${endT.y.toFixed(4)}" stroke="${strokeColor}" stroke-width="${svgLineWidth.toFixed(4)}"${dashAttr}/>\n`;
    }
    svg += '  </g>\n';

    // 4. DRAW COMPLETED MEASUREMENTS
    if (measure2DResults.length > 0) {
      svg += '  <g id="measurements">\n';
      for (const result of measure2DResults) {
        const { start, end, distance } = result;
        // Transform measurement points with axis-specific flipping
        const startT = { x: flipX ? -start.x : start.x, y: flipY ? -start.y : start.y };
        const endT = { x: flipX ? -end.x : end.x, y: flipY ? -end.y : end.y };
        const midX = (startT.x + endT.x) / 2;
        const midY = (startT.y + endT.y) / 2;
        const labelText = formatDistance(distance);

        // Measurement styling (all in mm on paper, converted to model units)
        const measureColor = '#2196F3';
        const measureLineWidth = mmToModel(0.4);  // 0.4mm line on paper
        const endpointRadius = mmToModel(1.5);    // 1.5mm radius on paper

        // Draw line
        svg += `    <line x1="${startT.x.toFixed(4)}" y1="${startT.y.toFixed(4)}" x2="${endT.x.toFixed(4)}" y2="${endT.y.toFixed(4)}" stroke="${measureColor}" stroke-width="${measureLineWidth.toFixed(4)}"/>\n`;

        // Draw endpoints
        svg += `    <circle cx="${startT.x.toFixed(4)}" cy="${startT.y.toFixed(4)}" r="${endpointRadius.toFixed(4)}" fill="${measureColor}"/>\n`;
        svg += `    <circle cx="${endT.x.toFixed(4)}" cy="${endT.y.toFixed(4)}" r="${endpointRadius.toFixed(4)}" fill="${measureColor}"/>\n`;

        // Draw label background and text
        // Use 3mm text height on paper for readable labels
        const fontSize = mmToModel(3);
        const labelWidth = labelText.length * fontSize * 0.6;  // Approximate text width
        const labelHeight = fontSize * 1.4;
        const labelStroke = mmToModel(0.2);

        svg += `    <rect x="${(midX - labelWidth / 2).toFixed(4)}" y="${(midY - labelHeight / 2).toFixed(4)}" width="${labelWidth.toFixed(4)}" height="${labelHeight.toFixed(4)}" fill="rgba(255,255,255,0.95)" stroke="${measureColor}" stroke-width="${labelStroke.toFixed(4)}"/>\n`;
        svg += `    <text x="${midX.toFixed(4)}" y="${midY.toFixed(4)}" font-family="Arial, sans-serif" font-size="${fontSize.toFixed(4)}" fill="#000000" text-anchor="middle" dominant-baseline="middle" font-weight="500">${escapeXml(labelText)}</text>\n`;
      }
      svg += '  </g>\n';
    }

    // 5. DRAW POLYGON AREA MEASUREMENTS
    if (polygonArea2DResults.length > 0) {
      svg += '  <g id="polygon-area-measurements">\n';
      for (const result of polygonArea2DResults) {
        if (result.points.length < 3) continue;
        const pointsStr = result.points.map(p => {
          const pt = { x: flipX ? -p.x : p.x, y: flipY ? -p.y : p.y };
          return `${pt.x.toFixed(4)},${pt.y.toFixed(4)}`;
        }).join(' ');

        const measureColor = '#2196F3';
        const lineWidth = mmToModel(0.3);

        svg += `    <polygon points="${pointsStr}" fill="rgba(33,150,243,0.1)" stroke="${measureColor}" stroke-width="${lineWidth.toFixed(4)}" stroke-dasharray="${mmToModel(1).toFixed(4)} ${mmToModel(0.5).toFixed(4)}"/>\n`;

        // Label at centroid
        const centroid = computePolygonCentroid(result.points);
        const ct = { x: flipX ? -centroid.x : centroid.x, y: flipY ? -centroid.y : centroid.y };
        const areaText = formatArea(result.area);
        const fontSize = mmToModel(3);

        svg += `    <text x="${ct.x.toFixed(4)}" y="${ct.y.toFixed(4)}" font-family="Arial, sans-serif" font-size="${fontSize.toFixed(4)}" fill="#000000" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escapeXml(areaText)}</text>\n`;
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

        svg += `    <rect x="${pt.x.toFixed(4)}" y="${pt.y.toFixed(4)}" width="${approxWidth.toFixed(4)}" height="${height.toFixed(4)}" fill="${annotation.backgroundColor}" stroke="${annotation.borderColor}" stroke-width="${mmToModel(0.15).toFixed(4)}"/>\n`;
        for (let i = 0; i < lines.length; i++) {
          svg += `    <text x="${(pt.x + padding).toFixed(4)}" y="${(pt.y + padding + fontSize * 0.8 + i * lineHeight).toFixed(4)}" font-family="Arial, sans-serif" font-size="${fontSize.toFixed(4)}" fill="${annotation.color}">${escapeXml(lines[i])}</text>\n`;
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

        svg += `    <path d="${pathData}" fill="rgba(229,57,53,0.05)" stroke="${cloud.color}" stroke-width="${lineWidth.toFixed(4)}"/>\n`;

        if (cloud.label) {
          const cx = transformX((cloud.points[0].x + cloud.points[1].x) / 2);
          const cy = transformY((cloud.points[0].y + cloud.points[1].y) / 2);
          const fontSize = mmToModel(3);
          svg += `    <text x="${cx.toFixed(4)}" y="${cy.toFixed(4)}" font-family="Arial, sans-serif" font-size="${fontSize.toFixed(4)}" fill="${cloud.color}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${escapeXml(cloud.label)}</text>\n`;
        }
      }
      svg += '  </g>\n';
    }

    svg += '</svg>';
    return svg;
  }, [drawing, displayOptions, activePresetId, entityColorMap, overridesEnabled, overrideEngine, measure2DResults, polygonArea2DResults, textAnnotations2D, cloudAnnotations2D, sectionPlane.axis]);

  // Generate SVG with drawing sheet (frame, title block, scale bar)
  // This generates coordinates directly in paper mm space (like the canvas rendering)
  const generateSheetSVG = useCallback((): string | null => {
    if (!drawing || !activeSheet) return null;

    const { bounds } = drawing;

    // Sheet dimensions in mm
    const paperWidth = activeSheet.paper.widthMm;
    const paperHeight = activeSheet.paper.heightMm;
    const viewport = activeSheet.viewportBounds;

    // Calculate transform to fit drawing into viewport
    const drawingTransform = calculateDrawingTransform(
      { minX: bounds.min.x, minY: bounds.min.y, maxX: bounds.max.x, maxY: bounds.max.y },
      viewport,
      activeSheet.scale
    );

    const { translateX, translateY, scaleFactor } = drawingTransform;

    // Axis-specific flipping (matching canvas rendering)
    // - 'down' (plan view): DON'T flip Y so north (Z+) is up
    // - 'front' and 'side': flip Y so height (Y+) is up
    // - 'side': also flip X to look from conventional direction
    const currentAxis = sectionPlane.axis;
    const flipY = currentAxis !== 'down';
    const flipX = currentAxis === 'side';

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
      <rect x="${viewport.x.toFixed(2)}" y="${viewport.y.toFixed(2)}" width="${viewport.width.toFixed(2)}" height="${viewport.height.toFixed(2)}"/>
    </clipPath>
  </defs>

`;

    // Drawing content FIRST (so frame/title block render on top)
    svg += `  <g id="drawing-content" clip-path="url(#viewport-clip)">
`;

    // Helper to escape XML
    const escapeXml = (str: string): string => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };

    // Helper to get polygon path in paper coordinates
    const polygonToPath = (polygon: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }): string => {
      let path = '';
      if (polygon.outer.length > 0) {
        const first = modelToPaper(polygon.outer[0].x, polygon.outer[0].y);
        path += `M ${first.x.toFixed(4)} ${first.y.toFixed(4)}`;
        for (let i = 1; i < polygon.outer.length; i++) {
          const pt = modelToPaper(polygon.outer[i].x, polygon.outer[i].y);
          path += ` L ${pt.x.toFixed(4)} ${pt.y.toFixed(4)}`;
        }
        path += ' Z';
      }
      for (const hole of polygon.holes) {
        if (hole.length > 0) {
          const holeFirst = modelToPaper(hole[0].x, hole[0].y);
          path += ` M ${holeFirst.x.toFixed(4)} ${holeFirst.y.toFixed(4)}`;
          for (let i = 1; i < hole.length; i++) {
            const pt = modelToPaper(hole[i].x, hole[i].y);
            path += ` L ${pt.x.toFixed(4)} ${pt.y.toFixed(4)}`;
          }
          path += ' Z';
        }
      }
      return path;
    };

    // Render polygon fills
    svg += '    <g id="polygon-fills">\n';
    for (const polygon of drawing.cutPolygons) {
      let fillColor = getFillColorForType(polygon.ifcType);
      let opacity = 1;

      if (activePresetId === 'preset-3d-colors') {
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

      const pathData = polygonToPath(polygon.polygon);
      if (pathData) {
        svg += `      <path d="${pathData}" fill="${fillColor}" fill-opacity="${opacity.toFixed(2)}" fill-rule="evenodd" data-entity-id="${polygon.entityId}" data-ifc-type="${escapeXml(polygon.ifcType)}"/>\n`;
      }
    }
    svg += '    </g>\n';

    // Render polygon outlines
    svg += '    <g id="polygon-outlines">\n';
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

      const pathData = polygonToPath(polygon.polygon);
      if (pathData) {
        // lineWeight is in mm on paper
        const svgLineWeight = lineWeight * 0.3; // Scale down for better appearance
        svg += `      <path d="${pathData}" fill="none" stroke="${strokeColor}" stroke-width="${svgLineWeight.toFixed(4)}" data-entity-id="${polygon.entityId}"/>\n`;
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
      if (line.category === 'cut') continue;
      if (!displayOptions.showHiddenLines && line.visibility === 'hidden') continue;

      const { start, end } = line.line;
      if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(end.x) || !isFinite(end.y)) continue;
      if (start.x < lineMinX || start.x > lineMaxX || start.y < lineMinY || start.y > lineMaxY ||
        end.x < lineMinX || end.x > lineMaxX || end.y < lineMinY || end.y > lineMaxY) continue;

      let strokeColor = '#000000';
      let lineWidth = 0.25;
      let dashArray = '';

      switch (line.category) {
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
      svg += `      <line x1="${paperStart.x.toFixed(4)}" y1="${paperStart.y.toFixed(4)}" x2="${paperEnd.x.toFixed(4)}" y2="${paperEnd.y.toFixed(4)}" stroke="${strokeColor}" stroke-width="${svgLineWidth.toFixed(4)}"${dashAttr}/>\n`;
    }
    svg += '    </g>\n';

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
    const titleBlockResult = renderTitleBlock(
      activeSheet.titleBlock,
      frameResult.innerBounds,
      activeSheet.revisions,
      titleBlockExtras
    );
    svg += titleBlockResult.svgElements;
    svg += '\n';

    svg += '</svg>';
    return svg;
  }, [drawing, activeSheet, displayOptions, activePresetId, entityColorMap, overridesEnabled, overrideEngine]);

  // Export SVG
  const handleExportSVG = useCallback(() => {
    // Use sheet export if enabled, otherwise raw drawing export
    const svg = (sheetEnabled && activeSheet) ? generateSheetSVG() : generateExportSVG();
    if (!svg) return;
    const stem = (sheetEnabled && activeSheet)
      ? `${sanitizeFilename(activeSheet.name, { fallback: 'sheet' })}-${sectionPlane.axis}-${sectionPlane.position}`
      : `section-${sectionPlane.axis}-${sectionPlane.position}`;
    downloadFile(svg, `${stem}.svg`, 'image/svg+xml');
    posthog.capture('drawing_exported', { format: 'svg', axis: sectionPlane.axis, sheet_enabled: sheetEnabled });
  }, [generateExportSVG, generateSheetSVG, sheetEnabled, activeSheet, sectionPlane]);

  // Print handler
  const handlePrint = useCallback(() => {
    // Use sheet export if enabled, otherwise raw drawing export
    const svg = (sheetEnabled && activeSheet) ? generateSheetSVG() : generateExportSVG();
    if (!svg) return;

    // Create a new window for printing
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      alert('Please allow popups to print');
      return;
    }

    const title = (sheetEnabled && activeSheet)
      ? `${activeSheet.name} - ${sectionPlane.axis} at ${sectionPlane.position}%`
      : `Section Drawing - ${sectionPlane.axis} at ${sectionPlane.position}%`;

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
          ${svg}
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
  }, [generateExportSVG, generateSheetSVG, sheetEnabled, activeSheet, sectionPlane]);

  return {
    formatDistance,
    handleExportSVG,
    handlePrint,
  };
}

export { useDrawingExport };
export default useDrawingExport;
