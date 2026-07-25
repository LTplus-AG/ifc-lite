/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF Exporter - Export 2D drawings to ASCII DXF (issue #1861)
 *
 * Mirrors `svg-exporter.ts`'s input contract (a `Drawing2D` plus reference
 * underlays) so the two exporters read the same generated-drawing model and
 * cannot drift: same polylines/edges, same hatch-boundary polygons, same
 * per-style layer/colour derivation.
 *
 * Unlike SVG, DXF has no "paper" concept — coordinates are written verbatim
 * in the drawing's own unit (metres) with no scale/padding transform. A
 * `Drawing2D` generated without a render-frame shift (the package-level
 * contract; see `svg-exporter.ts`'s underlay caveat) therefore round-trips
 * through this exporter unchanged. Callers that need real-world or
 * map-projected output (the viewer's georeferenced plan-section export)
 * supply `coordinateTransform`, applied to every point — drawing and
 * underlay alike — right before it reaches the writer.
 *
 * Output targets DXF R12 (AC1009) — see `dxf/writer.ts`'s module docs for
 * why (handles/subclass markers are mandatory from R13 on; R12 needs
 * neither and is the universal interop baseline). There is accordingly no
 * `$INSUNITS` header variable; the unit (always metres) is stated in a
 * `999` comment at the top of the file instead, optionally naming the
 * `IfcProjectedCRS` via `metadataComment`.
 */

import type { Drawing2D, DrawingLine, DrawingPolygon, LineCategory, Point2D } from './types.js';
import { getLineStyle, getHatchPattern } from './styles.js';
import { applyDxfPlacement } from './dxf/convert.js';
import { DEFAULT_DXF_PLACEMENT, type DxfPlacement, type DxfUnderlay } from './dxf/types.js';
import { DxfWriter, type DxfLinetype } from './dxf/writer.js';

export interface DXFExportOptions {
  /** Include lines whose `visibility === 'hidden'` (default true, matching SVG). */
  showHiddenLines?: boolean;
  /** Include cut-polygon boundaries (hatch regions, represented as closed POLYLINE boundaries — see module docs). Default true. */
  showHatching?: boolean;
  /** DXF reference underlays composited alongside the drawing (issue #1782 parity). */
  underlays?: DXFUnderlayOptions[];
  /**
   * Applied to every emitted point (drawing geometry and underlays alike)
   * as the very last step before it reaches the writer. Identity by
   * default. The viewer uses this to re-derive true world/map coordinates
   * for a plan-view export — see `apps/viewer/src/hooks/dxfExportGeoref.ts`.
   */
  coordinateTransform?: (p: Point2D) => Point2D;
  /**
   * `999` comment written at the top of the file (R12 has no `$INSUNITS`
   * to state the unit instead — see `dxf/writer.ts`). Defaults to a
   * generic "units: metres" note; pass one naming the `IfcProjectedCRS`
   * for a georeferenced export.
   */
  metadataComment?: string;
}

/** One DXF reference underlay to embed (mirrors `SVGUnderlayOptions`). */
export interface DXFUnderlayOptions {
  underlay: DxfUnderlay;
  /** Placement in drawing space; identity when omitted. */
  placement?: DxfPlacement;
  /** Per-layer visibility override; falls back to the DXF layer's own state. */
  layerVisibility?: Record<string, boolean>;
}

const CATEGORY_LAYER: Record<LineCategory, string> = {
  cut: 'IFC-CUT',
  projection: 'IFC-PROJECTION',
  hidden: 'IFC-HIDDEN',
  silhouette: 'IFC-SILHOUETTE',
  crease: 'IFC-CREASE',
  boundary: 'IFC-BOUNDARY',
  annotation: 'IFC-ANNOTATION',
};
const FILL_LAYER = 'IFC-FILL';

/** Builds a DXF document from a `Drawing2D`, mirroring `SVGExporter`. */
export class DXFExporter {
  export(drawing: Drawing2D, options: DXFExportOptions = {}): string {
    const {
      showHiddenLines = true,
      showHatching = true,
      underlays = [],
      coordinateTransform = (p: Point2D) => p,
      metadataComment,
    } = options;

    const writer = new DxfWriter({ headerComment: metadataComment });
    const map = (p: Point2D): Point2D => coordinateTransform(p);

    // Layer per line category, DASHED linetype for the hidden layer only —
    // matches how SVGExporter groups its <g> layers. Lines whose
    // `visibility` is 'hidden' are routed onto the hidden layer regardless
    // of category — see writeLine.
    const categoryLayers = new Map<LineCategory, string>();
    for (const [category, name] of Object.entries(CATEGORY_LAYER) as [LineCategory, string][]) {
      const linetype: DxfLinetype = category === 'hidden' ? 'DASHED' : 'CONTINUOUS';
      categoryLayers.set(category, writer.layer(name, getLineStyle(category).color, linetype));
    }
    const fillLayer = writer.layer(FILL_LAYER, '#666666');

    // Hatching first (bottom-most, like SVGExporter's hatching layer).
    if (showHatching) {
      for (const polygon of drawing.cutPolygons) {
        this.writePolygonBoundary(writer, polygon, fillLayer, map);
      }
    }

    // Underlays beneath the drawing lines (SVGExporter renders them first too).
    for (const underlayOptions of underlays) {
      this.writeUnderlay(writer, underlayOptions, map);
    }

    for (const line of drawing.lines) {
      if (!showHiddenLines && line.visibility === 'hidden') continue;
      this.writeLine(writer, line, categoryLayers, map);
    }

    return writer.toString();
  }

  private writeLine(
    writer: DxfWriter,
    line: DrawingLine,
    categoryLayers: Map<LineCategory, string>,
    map: (p: Point2D) => Point2D,
  ): void {
    // Visibility wins over category (PR #1871 review, P2): hidden-line
    // removal / construction projection can mark e.g. a `projection` line
    // `visibility: 'hidden'`. Mapping by category alone would land it on the
    // CONTINUOUS `IFC-PROJECTION` layer and occluded/overhead edges would
    // read as solid in CAD. Mirror `exportToSVG`'s hidden-lines grouping
    // (and the viewer canvas's dashed override): every `visibility ===
    // 'hidden'` line joins the DASHED `IFC-HIDDEN` layer with the hidden
    // line style. No new layer/LTYPE names — `IFC-HIDDEN` and `DASHED` are
    // already declared in TABLES, so the output stays R12-legal.
    const styleCategory: LineCategory = line.visibility === 'hidden' ? 'hidden' : line.category;
    const layer = categoryLayers.get(styleCategory);
    if (!layer) return;
    const style = getLineStyle(styleCategory, line.ifcType);
    const start = map(line.line.start);
    const end = map(line.line.end);
    writer.addLine(start, end, layer, style.color);
  }

  private writePolygonBoundary(
    writer: DxfWriter,
    polygon: DrawingPolygon,
    layer: string,
    map: (p: Point2D) => Point2D,
  ): void {
    const pattern = getHatchPattern(polygon.ifcType);
    if (pattern.type === 'none') return;
    const outer = polygon.polygon.outer.map(map);
    writer.addPolyline(outer, layer, true, pattern.strokeColor);
    for (const hole of polygon.polygon.holes) {
      writer.addPolyline(hole.map(map), layer, true, pattern.strokeColor);
    }
  }

  private writeUnderlay(
    writer: DxfWriter,
    options: DXFUnderlayOptions,
    map: (p: Point2D) => Point2D,
  ): void {
    const { underlay, placement = DEFAULT_DXF_PLACEMENT, layerVisibility = {} } = options;
    // Underlay points are already in world plan coordinates (metres, +Y
    // north) — the same convention DXF itself uses, so (unlike SVG, which
    // is +Y down) no sign flip is needed before the placement transform.
    const mapPoint = (p: Point2D): Point2D => map(applyDxfPlacement(p, placement));
    const underlayPrefix = `DXF_${underlay.name}`;

    for (const dxfLayer of underlay.layers) {
      const visible = layerVisibility[dxfLayer.name] ?? dxfLayer.visible;
      if (!visible) continue;
      const layer = writer.layer(`${underlayPrefix}_${dxfLayer.name}`, dxfLayer.color);

      for (const fill of dxfLayer.fills) {
        const outer = fill.polygon.outer.map(mapPoint);
        writer.addPolyline(outer, layer, true, fill.color);
        for (const hole of fill.polygon.holes) {
          writer.addPolyline(hole.map(mapPoint), layer, true, fill.color);
        }
      }

      for (const path of dxfLayer.paths) {
        if (path.points.length < 2) continue;
        writer.addPolyline(path.points.map(mapPoint), layer, path.closed, path.color);
      }

      for (const text of dxfLayer.texts) {
        if (!text.text.trim()) continue;
        const anchor = mapPoint(text.position);
        const tip = mapPoint({ x: text.position.x + text.dirX, y: text.position.y + text.dirY });
        const angle = (Math.atan2(tip.y - anchor.y, tip.x - anchor.x) * 180) / Math.PI;
        const lines = text.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          writer.addText(
            { x: anchor.x, y: anchor.y - i * text.height * 1.3 },
            lines[i],
            text.height,
            layer,
            { rotationDeg: angle, hAlign: text.align, vAlign: text.valign, colorOverride: text.color },
          );
        }
      }
    }
  }
}

/** Export a `Drawing2D` to an ASCII DXF string. */
export function exportToDXF(drawing: Drawing2D, options?: DXFExportOptions): string {
  return new DXFExporter().export(drawing, options);
}
