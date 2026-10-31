/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fill and stroke of one cut polygon, shared by every `useDrawingExport.ts`
 * writer (raw SVG, sheet SVG, scaled PDF) so the PDF cannot fall back to
 * black outlines while the SVG export shows the coloured section. Same rules
 * as the light-paper canvas in Drawing2DCanvas.
 */

import type { DrawingPolygon, ElementData, GraphicOverrideEngine } from '@ifc-lite/drawing-2d';
import { rgbaToHex } from '@ifc-lite/lens';
import { getFillColorForType } from './ifc-fill-colors';

export interface CutPolygonStyle {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  /** Paper millimetres. */
  lineWeight: number;
}

export interface CutPolygonStyleContext {
  /** The 3D colours preset: fill with IFC material colours (as Drawing2DCanvas). */
  useIfcMaterials: boolean;
  entityColorMap: Map<number, [number, number, number, number]>;
  overridesEnabled: boolean;
  overrideEngine: GraphicOverrideEngine;
  getElementProperties: (entityId: number) => ElementData['properties'];
}

export function resolveCutPolygonStyle(
  polygon: Pick<DrawingPolygon, 'entityId' | 'ifcType' | 'color'>,
  ctx: CutPolygonStyleContext,
): CutPolygonStyle {
  const override = ctx.overridesEnabled
    ? ctx.overrideEngine.applyOverrides({
      expressId: polygon.entityId,
      ifcType: polygon.ifcType,
      properties: ctx.getElementProperties(polygon.entityId),
    }).style
    : null;
  const stroke = {
    strokeColor: override?.strokeColor ?? '#000000',
    lineWeight: override && Number.isFinite(override.lineWeight) ? override.lineWeight : 0.5,
  };

  // IFC material colours win for fills, per layer first, as on screen
  // (Drawing2DCanvas): a layered wall paints each layer in its own colour.
  const material = ctx.useIfcMaterials ? (polygon.color ?? ctx.entityColorMap.get(polygon.entityId)) : undefined;
  if (material) return { fillColor: rgbaToHex(material), fillOpacity: material[3], ...stroke };
  if (override && !ctx.useIfcMaterials) return { fillColor: override.fillColor, fillOpacity: override.opacity, ...stroke };
  return { fillColor: getFillColorForType(polygon.ifcType), fillOpacity: 1, ...stroke };
}

/** Style every cut polygon once, alongside the writer's own geometry for it. */
export function styleCutPolygons<P extends Pick<DrawingPolygon, 'entityId' | 'ifcType' | 'color'>, G>(
  polygons: readonly P[],
  ctx: CutPolygonStyleContext,
  geometry: (polygon: P) => G,
): { polygon: P; style: CutPolygonStyle; geometry: G }[] {
  return polygons.map((polygon) => ({ polygon, style: resolveCutPolygonStyle(polygon, ctx), geometry: geometry(polygon) }));
}
