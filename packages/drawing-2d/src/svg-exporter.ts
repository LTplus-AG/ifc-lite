/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG Exporter - Export 2D drawings to SVG format
 *
 * Generates architectural-quality SVG output with:
 * - Proper line weights and styles
 * - Hatch patterns
 * - Layer organization
 * - Scale and paper size handling
 */

import type {
  Drawing2D,
  DrawingLine,
  DrawingPolygon,
  Point2D,
  Bounds2D,
  LineCategory,
} from './types.js';
import type { HatchLine } from './hatch-generator.js';
import { HatchGenerator } from './hatch-generator.js';
import {
  getLineStyle,
  getHatchPattern,
  PAPER_SIZES,
  COMMON_SCALES,
  type PaperSize,
  type DrawingScale,
  type HatchPattern,
} from './styles.js';
import {
  computeTransform,
  scaleLabel,
  transformPoint,
  type Transform2D,
} from './svg-transform.js';
import { applyDxfPlacement } from './dxf/convert.js';
import { DEFAULT_DXF_PLACEMENT, type DxfPlacement, type DxfUnderlay } from './dxf/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SVGExportOptions {
  /** Paper size */
  paperSize?: PaperSize;
  /** Drawing scale (e.g., { name: '1:100', factor: 100 }) */
  scale?: DrawingScale;
  /** Padding around drawing in mm */
  padding?: number;
  /** Include hidden lines */
  showHiddenLines?: boolean;
  /** Include hatching */
  showHatching?: boolean;
  /** Include title block */
  showTitleBlock?: boolean;
  /** Drawing title */
  title?: string;
  /** Project name */
  projectName?: string;
  /** Background color (default: white) */
  backgroundColor?: string;
  /**
   * Declared but never read. `export()` does not destructure `units` and no
   * other code path consults it, so setting it has no effect on the emitted
   * SVG. The exporter emits no dimension annotations at all, and the sheet
   * itself is always sized in millimetres (`width="…mm"`), so there is no
   * substitute option to reach for. Slated for removal; see issue #2731.
   *
   * @deprecated Ignored by the exporter — see above.
   */
  units?: 'mm' | 'm';
  /** DXF reference underlays rendered beneath the drawing (issue #1782) */
  underlays?: SVGUnderlayOptions[];
}

/** One DXF reference underlay to composite under the drawing. */
export interface SVGUnderlayOptions {
  underlay: DxfUnderlay;
  /** Placement in drawing space; identity when omitted. */
  placement?: DxfPlacement;
  /** Per-layer visibility override; falls back to the DXF layer state. */
  layerVisibility?: Record<string, boolean>;
  /** Overall opacity (default 1). */
  opacity?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG EXPORTER CLASS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The one place a number becomes SVG text. `NaN`/`Infinity` stringify
 * verbatim through `toFixed`, which a conforming renderer must reject, so
 * every coordinate/size/rotation routes through here (mirrors the DXF
 * writer's single `fmt()`). Non-finite becomes `0`: the document stays
 * parseable and the degenerate geometry collapses at the visible origin.
 */
function svgNum(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

/** `drawing.config.scale` is any positive number, not just the ten
 *  {@link COMMON_SCALES} presets; a `.find()` miss (a custom scale) must
 *  build a synthetic `DrawingScale`, not fall to the same 1:50 as "absent". */
function resolveDrawingScale(configScale: number): DrawingScale {
  const common = COMMON_SCALES.find((s) => s.factor === configScale);
  if (common) return common;
  return Number.isFinite(configScale) && configScale > 0
    ? { name: `1:${configScale}`, factor: configScale, useCase: 'Custom scale' }
    : COMMON_SCALES[5];
}

export class SVGExporter {
  private hatchGenerator = new HatchGenerator();

  /**
   * Export a 2D drawing to SVG string
   */
  export(drawing: Drawing2D, options: SVGExportOptions = {}): string {
    const {
      paperSize = PAPER_SIZES.A3_LANDSCAPE,
      scale = resolveDrawingScale(drawing.config.scale),
      padding = 20,
      showHiddenLines = true,
      showHatching = true,
      showTitleBlock = false,
      title = 'Section',
      projectName = '',
      backgroundColor = '#FFFFFF',
      underlays = [],
    } = options;

    // Calculate transform from drawing coordinates to SVG coordinates
    const transform = computeTransform(drawing.bounds, paperSize, scale, padding);

    // Build SVG
    let svg = this.createHeader(paperSize, backgroundColor);
    svg += this.createDefs(drawing, scale.factor);

    // Layer: DXF reference underlays (bottom-most, issue #1782)
    for (const underlayOptions of underlays) {
      svg += this.createUnderlayLayer(underlayOptions, transform);
    }

    // Layer: Hatching (bottom)
    if (showHatching && drawing.cutPolygons.length > 0) {
      svg += this.createHatchingLayer(drawing.cutPolygons, transform, scale.factor);
    }

    // Layer: Hidden lines
    if (showHiddenLines) {
      const hiddenLines = drawing.lines.filter((l) => l.visibility === 'hidden');
      if (hiddenLines.length > 0) {
        svg += this.createLineLayer('hidden-lines', hiddenLines, transform, 'Hidden Lines');
      }
    }

    // Layer: Projection lines
    const projectionLines = drawing.lines.filter(
      (l) => l.category === 'projection' && l.visibility !== 'hidden'
    );
    if (projectionLines.length > 0) {
      svg += this.createLineLayer('projection-lines', projectionLines, transform, 'Projection');
    }

    // Layer: Silhouettes and creases
    const featureLines = drawing.lines.filter(
      (l) =>
        (l.category === 'silhouette' || l.category === 'crease' || l.category === 'boundary') &&
        l.visibility !== 'hidden'
    );
    if (featureLines.length > 0) {
      svg += this.createLineLayer('feature-lines', featureLines, transform, 'Feature Edges');
    }

    // Layer: Cut lines (top)
    const cutLines = drawing.lines.filter((l) => l.category === 'cut');
    if (cutLines.length > 0) {
      svg += this.createLineLayer('cut-lines', cutLines, transform, 'Cut Lines');
    }

    // Title block
    if (showTitleBlock) {
      svg += this.createTitleBlock(paperSize, title, projectName, scaleLabel(scale, transform));
    }

    svg += '</svg>';

    return svg;
  }

  /**
   * Export just the cut polygons with hatching (for section fills)
   */
  exportPolygons(polygons: DrawingPolygon[], bounds: Bounds2D, options: SVGExportOptions = {}): string {
    const {
      paperSize = PAPER_SIZES.A3_LANDSCAPE,
      scale = COMMON_SCALES[5],
      padding = 20,
      backgroundColor = '#FFFFFF',
    } = options;

    const transform = computeTransform(bounds, paperSize, scale, padding);

    let svg = this.createHeader(paperSize, backgroundColor);
    svg += this.createPolygonDefs(scale.factor);
    svg += this.createHatchingLayer(polygons, transform, scale.factor);
    svg += '</svg>';

    return svg;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private createHeader(paperSize: PaperSize, backgroundColor: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="${paperSize.width}mm"
     height="${paperSize.height}mm"
     viewBox="0 0 ${paperSize.width} ${paperSize.height}">
  <rect width="100%" height="100%" fill="${this.escapeXml(backgroundColor)}"/>
`;
  }

  private createDefs(drawing: Drawing2D, scaleFactor: number): string {
    let defs = '  <defs>\n';
    defs += this.createHatchPatternDefs(scaleFactor);
    defs += '  </defs>\n';
    return defs;
  }

  private createPolygonDefs(scaleFactor: number): string {
    let defs = '  <defs>\n';
    defs += this.createHatchPatternDefs(scaleFactor);
    defs += '  </defs>\n';
    return defs;
  }

  private createHatchPatternDefs(scaleFactor: number): string {
    const spacing = 3 * (scaleFactor / 100); // Adjust for scale
    let defs = '';

    // Diagonal hatch
    defs += `    <pattern id="hatch-diagonal" patternUnits="userSpaceOnUse"
                width="${spacing}" height="${spacing}" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${spacing}" stroke="#000" stroke-width="0.15"/>
    </pattern>\n`;

    // Cross-hatch
    defs += `    <pattern id="hatch-cross" patternUnits="userSpaceOnUse"
                width="${spacing}" height="${spacing}">
      <line x1="0" y1="0" x2="${spacing}" y2="${spacing}" stroke="#000" stroke-width="0.1"/>
      <line x1="${spacing}" y1="0" x2="0" y2="${spacing}" stroke="#000" stroke-width="0.1"/>
    </pattern>\n`;

    // Horizontal lines
    defs += `    <pattern id="hatch-horizontal" patternUnits="userSpaceOnUse"
                width="${spacing}" height="${spacing}">
      <line x1="0" y1="${spacing / 2}" x2="${spacing}" y2="${spacing / 2}" stroke="#000" stroke-width="0.1"/>
    </pattern>\n`;

    // Concrete dots
    defs += `    <pattern id="hatch-concrete" patternUnits="userSpaceOnUse"
                width="${spacing * 2}" height="${spacing * 2}">
      <circle cx="${spacing * 0.3}" cy="${spacing * 0.3}" r="0.3" fill="#666"/>
      <circle cx="${spacing * 1.3}" cy="${spacing * 1.3}" r="0.3" fill="#666"/>
      <circle cx="${spacing * 0.8}" cy="${spacing * 1.6}" r="0.2" fill="#888"/>
    </pattern>\n`;

    // Steel (dense diagonal)
    defs += `    <pattern id="hatch-steel" patternUnits="userSpaceOnUse"
                width="${spacing * 0.7}" height="${spacing * 0.7}" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${spacing * 0.7}" stroke="#333" stroke-width="0.2"/>
    </pattern>\n`;

    return defs;
  }

  private createLineLayer(
    id: string,
    lines: DrawingLine[],
    transform: Transform2D,
    label: string
  ): string {
    let layer = `  <g id="${id}" inkscape:label="${label}" inkscape:groupmode="layer">\n`;

    for (const line of lines) {
      layer += this.renderLine(line, transform);
    }

    layer += '  </g>\n';
    return layer;
  }

  private renderLine(line: DrawingLine, transform: Transform2D): string {
    const style = getLineStyle(line.category, line.ifcType);
    const p0 = transformPoint(line.line.start, transform);
    const p1 = transformPoint(line.line.end, transform);

    const dashArray =
      style.dashPattern.length > 0 ? ` stroke-dasharray="${style.dashPattern.join(' ')}"` : '';

    return `    <line x1="${svgNum(p0.x)}" y1="${svgNum(p0.y)}" x2="${svgNum(p1.x)}" y2="${svgNum(p1.y)}"
          stroke="${style.color}" stroke-width="${style.weight}"
          stroke-linecap="${style.lineCap}"${dashArray}
          data-entity-id="${line.entityId}" data-ifc-type="${this.escapeXml(line.ifcType)}"/>\n`;
  }

  private createHatchingLayer(
    polygons: DrawingPolygon[],
    transform: Transform2D,
    scaleFactor: number
  ): string {
    let layer = '  <g id="hatching" inkscape:label="Hatching" inkscape:groupmode="layer">\n';

    for (const polygon of polygons) {
      const pattern = getHatchPattern(polygon.ifcType);

      if (pattern.type === 'none') continue;

      // Render polygon with fill
      layer += this.renderPolygon(polygon, transform, pattern);

      // Generate and render hatch lines for non-solid fills
      if (pattern.type !== 'solid' && pattern.type !== 'glass') {
        const hatchResult = this.hatchGenerator.generateHatch(polygon, scaleFactor);
        for (const hatchLine of hatchResult.lines) {
          layer += this.renderHatchLine(hatchLine, transform, pattern);
        }
      }
    }

    layer += '  </g>\n';
    return layer;
  }

  private renderPolygon(
    polygon: DrawingPolygon,
    transform: Transform2D,
    pattern: HatchPattern
  ): string {
    const pathData = this.polygonToPath(polygon.polygon, transform);

    let fill: string;
    if (pattern.type === 'solid') {
      fill = pattern.fillColor || '#CCCCCC';
    } else if (pattern.type === 'glass') {
      fill = pattern.fillColor || 'rgba(200, 230, 255, 0.3)';
    } else if (pattern.type === 'none') {
      fill = 'none';
    } else {
      // Use pattern fill
      fill = `url(#hatch-${pattern.type})`;
    }

    return `    <path d="${pathData}" fill="${fill}"
          stroke="${pattern.strokeColor}" stroke-width="${pattern.lineWeight}"
          data-entity-id="${polygon.entityId}" data-ifc-type="${this.escapeXml(polygon.ifcType)}"/>\n`;
  }

  private polygonToPath(polygon: { outer: Point2D[]; holes: Point2D[][] }, transform: Transform2D): string {
    let path = '';

    // Outer boundary
    if (polygon.outer.length > 0) {
      const first = transformPoint(polygon.outer[0], transform);
      path += `M ${svgNum(first.x)} ${svgNum(first.y)}`;
      for (let i = 1; i < polygon.outer.length; i++) {
        const p = transformPoint(polygon.outer[i], transform);
        path += ` L ${svgNum(p.x)} ${svgNum(p.y)}`;
      }
      path += ' Z';
    }

    // Holes
    for (const hole of polygon.holes) {
      if (hole.length > 0) {
        const first = transformPoint(hole[0], transform);
        path += ` M ${svgNum(first.x)} ${svgNum(first.y)}`;
        for (let i = 1; i < hole.length; i++) {
          const p = transformPoint(hole[i], transform);
          path += ` L ${svgNum(p.x)} ${svgNum(p.y)}`;
        }
        path += ' Z';
      }
    }

    return path;
  }

  private renderHatchLine(
    hatchLine: HatchLine,
    transform: Transform2D,
    pattern: HatchPattern
  ): string {
    const p0 = transformPoint(hatchLine.line.start, transform);
    const p1 = transformPoint(hatchLine.line.end, transform);

    return `    <line x1="${svgNum(p0.x)}" y1="${svgNum(p0.y)}" x2="${svgNum(p1.x)}" y2="${svgNum(p1.y)}"
          stroke="${pattern.strokeColor}" stroke-width="${pattern.lineWeight}" stroke-linecap="butt"/>\n`;
  }

  private createTitleBlock(
    paperSize: PaperSize,
    title: string,
    projectName: string,
    // Not `scaleLabel`: that name now belongs to the imported function from
    // ./svg-transform.js, and shadowing it here would read as a call site.
    scaleText: string
  ): string {
    const blockWidth = 180;
    const blockHeight = 50;
    const x = paperSize.width - blockWidth - 10;
    const y = paperSize.height - blockHeight - 10;

    return `  <g id="title-block">
    <rect x="${x}" y="${y}" width="${blockWidth}" height="${blockHeight}"
          fill="white" stroke="black" stroke-width="0.5"/>
    <line x1="${x}" y1="${y + 20}" x2="${x + blockWidth}" y2="${y + 20}" stroke="black" stroke-width="0.3"/>
    <line x1="${x}" y1="${y + 35}" x2="${x + blockWidth}" y2="${y + 35}" stroke="black" stroke-width="0.3"/>
    <line x1="${x + 100}" y1="${y + 20}" x2="${x + 100}" y2="${y + blockHeight}" stroke="black" stroke-width="0.3"/>
    <text x="${x + 5}" y="${y + 14}" font-family="Arial" font-size="10" font-weight="bold">${this.escapeXml(title)}</text>
    <text x="${x + 5}" y="${y + 30}" font-family="Arial" font-size="8">${this.escapeXml(projectName)}</text>
    <text x="${x + 5}" y="${y + 45}" font-family="Arial" font-size="8">Scale: ${this.escapeXml(scaleText)}</text>
    <text x="${x + 105}" y="${y + 30}" font-family="Arial" font-size="7">Date:</text>
    <text x="${x + 105}" y="${y + 45}" font-family="Arial" font-size="7">${new Date().toLocaleDateString()}</text>
  </g>\n`;
  }

  /**
   * Render one DXF reference underlay as an SVG layer group (issue #1782).
   * Underlay geometry is in world plan coordinates (metres, +Y = north);
   * it maps to plan drawing space (`x, -y`), takes the user placement,
   * then goes through the shared drawing → paper transform. Note this
   * assumes the Drawing2D was generated without a render-frame origin
   * shift; shifted/georeferenced pipelines (like the viewer) must handle
   * the shift themselves before calling into SVG export.
   */
  private createUnderlayLayer(options: SVGUnderlayOptions, transform: Transform2D): string {
    const { underlay, placement = DEFAULT_DXF_PLACEMENT, layerVisibility = {}, opacity = 1 } = options;
    const mapPoint = (p: Point2D): Point2D =>
      transformPoint(applyDxfPlacement({ x: p.x, y: -p.y }, placement), transform);
    const groupId = `dxf-${underlay.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

    let layer = `  <g id="${this.escapeXml(groupId)}" inkscape:label="${this.escapeXml(underlay.name)}" inkscape:groupmode="layer" opacity="${opacity}">\n`;

    for (const dxfLayer of underlay.layers) {
      const visible = layerVisibility[dxfLayer.name] ?? dxfLayer.visible;
      if (!visible) continue;
      layer += `    <g data-dxf-layer="${this.escapeXml(dxfLayer.name)}">\n`;

      for (const fill of dxfLayer.fills) {
        let d = '';
        const rings = [fill.polygon.outer, ...fill.polygon.holes];
        for (const ring of rings) {
          if (ring.length === 0) continue;
          const first = mapPoint(ring[0]);
          d += `${d ? ' ' : ''}M ${svgNum(first.x)} ${svgNum(first.y)}`;
          for (let i = 1; i < ring.length; i++) {
            const p = mapPoint(ring[i]);
            d += ` L ${svgNum(p.x)} ${svgNum(p.y)}`;
          }
          d += ' Z';
        }
        const fillColor = fill.color ?? dxfLayer.color;
        const fillOpacity = fill.pattern ? 0.25 : 1;
        layer += `      <path d="${d}" fill="${fillColor}" fill-opacity="${fillOpacity}" fill-rule="evenodd" stroke="none"/>\n`;
      }

      for (const path of dxfLayer.paths) {
        if (path.points.length < 2) continue;
        const pts = path.points.map(mapPoint);
        const pointsAttr = pts.map((p) => `${svgNum(p.x)},${svgNum(p.y)}`).join(' ');
        const tag = path.closed ? 'polygon' : 'polyline';
        const strokeWidth = path.widthMm ?? 0.18;
        const dash = path.dashed ? ` stroke-dasharray="${svgNum(strokeWidth * 6)} ${svgNum(strokeWidth * 4)}"` : '';
        layer += `      <${tag} points="${pointsAttr}" fill="none" stroke="${path.color ?? dxfLayer.color}" stroke-width="${svgNum(strokeWidth)}" stroke-linecap="round"${dash}/>\n`;
      }

      for (const text of dxfLayer.texts) {
        if (!text.text.trim()) continue;
        const anchor = mapPoint(text.position);
        const tip = mapPoint({ x: text.position.x + text.dirX, y: text.position.y + text.dirY });
        const angle = (Math.atan2(tip.y - anchor.y, tip.x - anchor.x) * 180) / Math.PI;
        // Placement scales geometry through mapPoint; the font height must
        // follow or labels detach from their linework.
        const heightMm = text.height * placement.scale * transform.scale;
        const anchorAttr = text.align === 'center' ? 'middle' : text.align === 'right' ? 'end' : 'start';
        const baseline =
          text.valign === 'bottom' ? 'text-after-edge'
            : text.valign === 'middle' ? 'central'
              : text.valign === 'top' ? 'text-before-edge'
                : 'alphabetic';
        // Multiline MTEXT stacks with tspans, matching the canvas layout.
        const lines = text.text.split('\n');
        const content = lines
          .map((line, i) => `<tspan x="${svgNum(anchor.x)}" dy="${i === 0 ? 0 : svgNum(heightMm * 1.3)}">${this.escapeXml(line)}</tspan>`)
          .join('');
        layer += `      <text x="${svgNum(anchor.x)}" y="${svgNum(anchor.y)}" font-family="Arial, sans-serif" font-size="${svgNum(heightMm)}" fill="${text.color ?? dxfLayer.color}" text-anchor="${anchorAttr}" dominant-baseline="${baseline}" transform="rotate(${svgNum(angle, 2)} ${svgNum(anchor.x)} ${svgNum(anchor.y)})">${content}</text>\n`;
      }

      layer += '    </g>\n';
    }

    layer += '  </g>\n';
    return layer;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Export a Drawing2D to SVG string
 */
export function exportToSVG(drawing: Drawing2D, options?: SVGExportOptions): string {
  const exporter = new SVGExporter();
  return exporter.export(drawing, options);
}
