/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fill and stroke of one cut polygon, shared by every `useDrawingExport.ts`
 * writer (raw SVG, sheet SVG, scaled PDF) so the PDF cannot fall back to
 * black outlines while the SVG export shows the coloured section.
 */

import type { DrawingPolygon, ElementData, GraphicOverrideEngine } from '@ifc-lite/drawing-2d';
import { getFillColorForType } from '@/components/viewer/Drawing2DCanvas';

export interface CutPolygonStyle {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  /** Paper millimetres. */
  lineWeight: number;
}

export interface CutPolygonStyleContext {
  activePresetId: string | null;
  entityColorMap: Map<number, [number, number, number, number]>;
  overridesEnabled: boolean;
  overrideEngine: GraphicOverrideEngine;
  getElementProperties: (entityId: number) => ElementData['properties'];
}

const toHex = (channel: number) => Math.round(channel * 255).toString(16).padStart(2, '0');

export function resolveCutPolygonStyle(
  polygon: Pick<DrawingPolygon, 'entityId' | 'ifcType' | 'color'>,
  ctx: CutPolygonStyleContext,
): CutPolygonStyle {
  const style: CutPolygonStyle = {
    fillColor: getFillColorForType(polygon.ifcType),
    fillOpacity: 1,
    strokeColor: '#000000',
    lineWeight: 0.5,
  };

  if (ctx.overridesEnabled) {
    const elementData: ElementData = {
      expressId: polygon.entityId,
      ifcType: polygon.ifcType,
      properties: ctx.getElementProperties(polygon.entityId),
    };
    const result = ctx.overrideEngine.applyOverrides(elementData).style;
    style.strokeColor = result.strokeColor;
    style.lineWeight = result.lineWeight;
    if (ctx.activePresetId !== 'preset-3d-colors') {
      style.fillColor = result.fillColor;
      style.fillOpacity = result.opacity;
    }
  }

  // IFC material colours win for fills, per layer first, as on screen
  // (Drawing2DCanvas): a layered wall paints each layer in its own colour.
  if (ctx.activePresetId === 'preset-3d-colors') {
    const materialColor = polygon.color ?? ctx.entityColorMap.get(polygon.entityId);
    if (materialColor) {
      style.fillColor = `#${toHex(materialColor[0])}${toHex(materialColor[1])}${toHex(materialColor[2])}`;
      style.fillOpacity = materialColor[3];
    }
  }

  return style;
}

/**
 * Split a colour into what jsPDF accepts (`#RRGGBB`) and an alpha
 * factor. Overrides allow `#RRGGBBAA`, which jsPDF's colour parser rejects;
 * anything that is not hex (e.g. a named colour) passes through unchanged.
 */
export function pdfColor(color: string): { hex: string; alpha: number } {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  if (short) return { hex: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`, alpha: 1 };
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (long) return { hex: `#${long[1]}`, alpha: long[2] ? parseInt(long[2], 16) / 255 : 1 };
  return { hex: color, alpha: 1 };
}
