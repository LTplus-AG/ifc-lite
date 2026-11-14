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
import { dxfTextLineOffset } from './dxf/text-layout.js';
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
  /**
   * Extra polyline layers drawn on top of the drawing, each on its own DXF
   * layer (e.g. the viewer's traced scan outline, #6871). Points are in
   * drawing space and go through `coordinateTransform` like everything else.
   */
  polylineLayers?: DXFPolylineLayer[];
  /**
   * Extra single-line TEXT layers drawn on top of everything else (e.g. the
   * viewer's dimension values). Positions are in drawing space and go
   * through `coordinateTransform`; see {@link DXFText} for the angle.
   */
  textLayers?: DXFTextLayer[];
  /** Shared dimension graphics in drawing metres; invalid graphics are omitted. */
  dimensions?: readonly {
    lines: readonly (readonly [Point2D, Point2D])[];
    ticks: readonly (readonly [Point2D, Point2D])[];
    text: { at: Point2D; angle: number; heightM: number; value: string };
  }[];
}

/** Shared by every dimension writer and omission preflight. */
export function isDxfDimensionExportable(dimension: NonNullable<DXFExportOptions['dimensions']>[number]): boolean {
  const baseline = dimension.lines[0];
  if (!baseline) return false;
  const length = Math.hypot(baseline[1].x - baseline[0].x, baseline[1].y - baseline[0].y);
  return Number.isFinite(length) && length > 0
    && Number.isFinite(dimension.text.heightM) && dimension.text.heightM > 0
    && Number.isFinite(dimension.text.angle)
    && [dimension.text.at, ...dimension.lines.flat(), ...dimension.ticks.flat()]
      .every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** One single-line TEXT entity of a {@link DXFTextLayer}. */
export interface DXFText {
  /** Alignment point, in drawing space. */
  position: Point2D;
  text: string;
  /** Text height in output units (metres). */
  height: number;
  /**
   * Baseline direction in drawing space (default +x). The written angle is
   * measured after `coordinateTransform`, so text keeps its direction
   * through a flip or rotation of the output frame.
   */
  direction?: Point2D;
  /** Turn the text half a turn when it would otherwise read upside down in the output frame (y up). Default false. */
  keepUpright?: boolean;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top';
}

/** One named layer of TEXT entities to embed. */
export interface DXFTextLayer {
  /** DXF layer name (R12: letters, digits, `-`, `_`, `$`). */
  name: string;
  /** CSS colour mapped to the nearest ACI colour by the writer. */
  color: string;
  texts: readonly DXFText[];
}

/** One named layer of polylines to embed. */
export interface DXFPolylineLayer {
  /** DXF layer name (R12: letters, digits, `-`, `_`, `$`). */
  name: string;
  /** CSS colour mapped to the nearest ACI colour by the writer. */
  color: string;
  polylines: readonly (readonly Point2D[])[];
  /** Close every polyline back to its first point. Default true. */
  closed?: boolean;
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
      polylineLayers = [],
      textLayers = [],
      dimensions = [],
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

    for (const extra of polylineLayers) {
      const layer = writer.layer(extra.name, extra.color);
      for (const polyline of extra.polylines) {
        writer.addPolyline(polyline.map(map), layer, extra.closed ?? true);
      }
    }

    for (const extra of textLayers) {
      const layer = writer.layer(extra.name, extra.color);
      for (const text of extra.texts) {
        writeText(writer, text, layer, map);
      }
    }

    for (const dimension of dimensions) {
      if (!isDxfDimensionExportable(dimension)) continue;
      const layer = writer.layer('IFC-DIMENSIONS', '#000000');
      for (const [a, b] of [...dimension.lines, ...dimension.ticks]) writer.addLine(map(a), map(b), layer);
      const text = dimension.text;
      writeText(writer, {
        position: text.at, text: text.value, height: text.heightM,
        direction: { x: Math.cos(text.angle), y: Math.sin(text.angle) },
        keepUpright: true, hAlign: 'center', vAlign: 'middle',
      }, layer, map);
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
    // north) — the same convention DXF itself uses, so unlike SVG (+Y
    // down), the FINAL output needs no sign flip relative to world space.
    // But `applyDxfPlacement` itself is defined in DRAWING space (+Y down —
    // see `DxfPlacement`'s docs: "Offset in metres (drawing space)",
    // "counter-clockwise as seen on a plan view"): every other consumer
    // (`svg-exporter.ts`'s underlay mapping, `dxfUnderlayMath.ts`'s
    // `worldToDrawing`) negates Y, applies the placement, and — for
    // consumers that stay in world space — negates Y back. Calling
    // `applyDxfPlacement` directly on a world-space (+Y up) point skips
    // that round trip, so a non-zero `offsetY` lands with the opposite
    // sign and a non-zero `rotationDeg` spins the opposite direction from
    // what the same `placement` produces everywhere else (2D canvas, 3D
    // overlay, SVG export) — a silently mirrored underlay in the DXF.
    const mapPoint = (p: Point2D): Point2D => {
      const drawingSpace = applyDxfPlacement({ x: p.x, y: -p.y }, placement);
      return map({ x: drawingSpace.x, y: -drawingSpace.y });
    };
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
        // Placement scales the geometry through mapPoint; the glyph height
        // must follow or labels detach from their linework (same rule as
        // SVGExporter's underlay text).
        const height = text.height * placement.scale;
        const lines = text.text.split('\n');
        const dirLength = Math.hypot(text.dirX, text.dirY) || 1;
        // Aligned/fit text: re-emit as Fit (72=5) with its second point so the CAD
        // reader (which measures real glyphs) spans the two points exactly.
        const fitTo = lines.length === 1 && text.align === 'left' && text.valign === 'baseline'
          && text.fitWidth !== undefined && Number.isFinite(text.fitWidth) && text.fitWidth > 0
          ? mapPoint({ x: text.position.x + (text.dirX / dirLength) * text.fitWidth,
            y: text.position.y + (text.dirY / dirLength) * text.fitWidth }) : undefined;
        for (let i = 0; i < lines.length; i++) {
          // Stack subsequent lines by offsetting in LOCAL space, then map:
          // the stacking direction must rotate with the text when
          // placement.rotationDeg is non-zero or coordinateTransform itself
          // rotates (georeferenced rotated grid) — exactly like
          // SVGExporter's rotate() wrapper around its tspan stack. An
          // output-space `anchor.y - offset` would shift lines straight
          // down regardless of the text's actual direction (PR #1871
          // review). "Down" across the baseline is the text direction turned
          // clockwise (local Y up), and the block offset honours the
          // vertical attachment like every other renderer.
          const offset = dxfTextLineOffset(i, lines.length, text.valign, text.height, text.lineSpacingFactor);
          const lineAnchor = offset === 0
            ? anchor
            : mapPoint({ x: text.position.x + (text.dirY / dirLength) * offset,
              y: text.position.y - (text.dirX / dirLength) * offset });
          writer.addText(
            lineAnchor,
            lines[i],
            height,
            layer,
            { rotationDeg: angle, hAlign: text.align, vAlign: text.valign, colorOverride: text.color,
              widthScale: text.widthScale, fitTo },
          );
        }
      }
    }
  }
}

function writeText(writer: DxfWriter, text: DXFText, layer: ReturnType<DxfWriter['layer']>, map: (p: Point2D) => Point2D): void {
  writer.addText(map(text.position), text.text, text.height, layer, {
    rotationDeg: outputTextAngle(text, map), hAlign: text.hAlign, vAlign: text.vAlign,
  });
}

/** The TEXT rotation in degrees for `text` once its baseline has gone through `map`. */
function outputTextAngle(text: DXFText, map: (p: Point2D) => Point2D): number {
  const { position: p, direction: d = { x: 1, y: 0 } } = text;
  const anchor = map(p);
  const tip = map({ x: p.x + d.x, y: p.y + d.y });
  let dx = tip.x - anchor.x;
  let dy = tip.y - anchor.y;
  // Upright in a y-up frame: reading rightwards, or bottom to top when vertical.
  if (text.keepUpright && (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0))) {
    dx = -dx;
    dy = -dy;
  }
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // atan2 of a vanishing vector is 0; keep -0 out of the file.
  return deg + 0;
}

/** Export a `Drawing2D` to an ASCII DXF string. */
export function exportToDXF(drawing: Drawing2D, options?: DXFExportOptions): string {
  return new DXFExporter().export(drawing, options);
}
