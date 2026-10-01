/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DXF_TEXT_LINE_HEIGHT_FACTOR } from '@/lib/drawing/dxf-text-layout';
import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay';
import type { DXFUnderlayOptions } from '@ifc-lite/drawing-2d';
import type { jsPDF } from 'jspdf';

/** Map a DXF vertical justification onto an SVG dominant-baseline. */
function dxfValignToBaseline(valign: 'baseline' | 'bottom' | 'middle' | 'top'): string {
  switch (valign) {
    case 'bottom': return 'text-after-edge';
    case 'middle': return 'central';
    case 'top': return 'text-before-edge';
    default: return 'alphabetic';
  }
}

/** The package facade accepts metre geometry. Placement has already run once. */
export function mappedDxfUnderlayOptions(data: readonly DxfUnderlayRenderData[],
  axis: 'down' | 'front' | 'side' = 'down'): DXFUnderlayOptions[] {
  // Canvas/SVG stack glyphs along the positive local screen Y. Reversing
  // only one drawing axis reverses that perpendicular in drawing space.
  const stackDirection = axis === 'front' ? -1 : 1;
  return data.filter(u => u.opacity > 0).map(u => ({ underlay: {
    name: u.id, unitScale: 1, skipped: {}, warnings: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } },
    layers: [{ name: 'REFERENCE', color: '#666666', visible: true,
      paths: u.lines.map(line => ({ ...line, points: line.points.map(p => ({ ...p })) })),
      fills: u.fills.filter(f => f.loops.length > 0).map(fill => ({
        polygon: { outer: fill.loops[0].map(p => ({ ...p })), holes: fill.loops.slice(1).map(r => r.map(p => ({ ...p }))) },
        color: fill.color, pattern: fill.pattern,
      })),
      texts: u.texts.flatMap(text => {
        const directionLength = Math.hypot(text.dirX, text.dirY);
        if (!Number.isFinite(directionLength) || directionLength === 0) return [];
        // Mapping a unit baseline tip carries placement/georeference scale.
        // Height already carries that scale, so line spacing uses a unit vector.
        const dirX = text.dirX / directionLength, dirY = text.dirY / directionLength;
        return text.text.split('\n').map((line, i) => ({
          position: { x: text.x - stackDirection * dirY * i * text.height * DXF_TEXT_LINE_HEIGHT_FACTOR,
            y: text.y + stackDirection * dirX * i * text.height * DXF_TEXT_LINE_HEIGHT_FACTOR },
          text: line, height: text.height, dirX, dirY,
          color: text.color, align: text.align, valign: text.valign,
        }));
      }),
    }],
  } }));
}

/** Vector reference strokes/fills/text precede the PDF's IFC cut geometry. */
export function drawDxfUnderlaysPdf(doc: jsPDF, underlays: readonly DxfUnderlayRenderData[],
  mapPoint: (x: number, y: number) => { x: number; y: number }, metresToMm: number): void {
  for (const data of underlays) {
    if (data.opacity <= 0) continue;
    doc.saveGraphicsState();
    try {
      doc.setGState(doc.GState({ opacity: data.opacity, 'stroke-opacity': data.opacity }));
      for (const fill of data.fills) {
        doc.setGState(doc.GState({ opacity: data.opacity * (fill.pattern ? 0.25 : 1), 'stroke-opacity': data.opacity }));
        doc.setFillColor(fill.color);
        const path: Array<{ op: string; c: number[] }> = [];
        for (const ring of fill.loops) {
          ring.forEach((p, index) => {
            const q = mapPoint(p.x, p.y); path.push({ op: index === 0 ? 'm' : 'l', c: [q.x, q.y] });
          });
          if (ring.length) path.push({ op: 'h', c: [] });
        }
        if (path.length) { doc.path(path); doc.fillEvenOdd(); }
      }
      doc.setGState(doc.GState({ opacity: data.opacity, 'stroke-opacity': data.opacity }));
      for (const line of data.lines) {
        if (line.points.length < 2) continue;
        doc.setDrawColor(line.color); doc.setLineWidth(line.widthMm ?? 0.18);
        doc.setLineDashPattern(line.dashed ? [1.08, 0.72] : [], 0);
        const points = line.points.map(p => mapPoint(p.x, p.y));
        doc.lines(points.slice(1).map((p, i) => [p.x - points[i].x, p.y - points[i].y]),
          points[0].x, points[0].y, [1, 1], 'S', line.closed);
      }
      for (const text of data.texts) {
        if (!Number.isFinite(text.height) || text.height <= 0 || !text.text.trim()) continue;
        const anchor = mapPoint(text.x, text.y), tip = mapPoint(text.x + text.dirX, text.y + text.dirY);
        const angle = -Math.atan2(tip.y - anchor.y, tip.x - anchor.x) * 180 / Math.PI;
        doc.setTextColor(text.color); doc.setFontSize(text.height * metresToMm * 72 / 25.4);
        doc.text(text.text, anchor.x, anchor.y, { angle, align: text.align, lineHeightFactor: DXF_TEXT_LINE_HEIGHT_FACTOR,
          baseline: text.valign === 'middle' ? 'middle' : text.valign === 'top' ? 'top' : text.valign === 'bottom' ? 'bottom' : 'alphabetic' });
      }
    } finally { doc.restoreGraphicsState(); }
  }
}

/**
 * Render DXF reference underlays as an SVG group (issue #1782). Geometry
 * arrives pre-mapped to drawing space (render-frame shift, flipped-section
 * mirror, and user placement applied by useDxfUnderlaysForDrawing); `mapPoint` converts a drawing-space point into the
 * export's coordinate system (axis mapping for the direct export, paper mm for
 * the sheet export). `strokeWidthForMm` and `fontScale` are in export units.
 */
export function buildDxfUnderlaySvg(
  underlays: readonly DxfUnderlayRenderData[],
  mapPoint: (x: number, y: number) => { x: number; y: number },
  strokeWidthForMm: (mm: number) => number,
  fontScale: number,
  escapeXml: (s: string) => string,
): string {
  const visibleUnderlays = underlays.filter((u) => u.opacity > 0);
  if (visibleUnderlays.length === 0) return '';

  let svg = '  <g id="dxf-underlays">\n';
  for (const data of visibleUnderlays) {
    svg += `    <g data-dxf-underlay="${escapeXml(data.id)}" opacity="${data.opacity.toFixed(2)}">\n`;

    for (const fill of data.fills) {
      let d = '';
      for (const ring of fill.loops) {
        if (ring.length < 3) continue;
        const first = mapPoint(ring[0].x, ring[0].y);
        d += `${d ? ' ' : ''}M ${first.x.toFixed(4)} ${first.y.toFixed(4)}`;
        for (let i = 1; i < ring.length; i++) {
          const p = mapPoint(ring[i].x, ring[i].y);
          d += ` L ${p.x.toFixed(4)} ${p.y.toFixed(4)}`;
        }
        d += ' Z';
      }
      if (!d) continue;
      svg += `      <path d="${d}" fill="${fill.color}" fill-opacity="${fill.pattern ? 0.25 : 1}" fill-rule="evenodd" stroke="none"/>\n`;
    }

    for (const line of data.lines) {
      if (line.points.length < 2) continue;
      const pts = line.points.map((p) => mapPoint(p.x, p.y));
      const pointsAttr = pts.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(' ');
      const tag = line.closed ? 'polygon' : 'polyline';
      const strokeWidth = strokeWidthForMm(line.widthMm ?? 0.18);
      const dash = line.dashed ? ` stroke-dasharray="${(strokeWidth * 6).toFixed(4)} ${(strokeWidth * 4).toFixed(4)}"` : '';
      svg += `      <${tag} points="${pointsAttr}" fill="none" stroke="${line.color}" stroke-width="${strokeWidth.toFixed(4)}" stroke-linecap="round"${dash}/>\n`;
    }

    for (const text of data.texts) {
      const anchor = mapPoint(text.x, text.y);
      const tip = mapPoint(text.x + text.dirX, text.y + text.dirY);
      const angle = (Math.atan2(tip.y - anchor.y, tip.x - anchor.x) * 180) / Math.PI;
      const fontSize = text.height * fontScale;
      if (fontSize <= 0) continue;
      const anchorAttr = text.align === 'center' ? 'middle' : text.align === 'right' ? 'end' : 'start';
      // Multiline MTEXT stacks with tspans, matching the canvas layout.
      const content = text.text
        .split('\n')
        .map((line, i) => `<tspan x="${anchor.x.toFixed(4)}" dy="${i === 0 ? 0 : (fontSize * DXF_TEXT_LINE_HEIGHT_FACTOR).toFixed(4)}">${escapeXml(line)}</tspan>`)
        .join('');
      svg += `      <text x="${anchor.x.toFixed(4)}" y="${anchor.y.toFixed(4)}" font-family="Arial, sans-serif" font-size="${fontSize.toFixed(4)}" fill="${text.color}" text-anchor="${anchorAttr}" dominant-baseline="${dxfValignToBaseline(text.valign)}" transform="rotate(${angle.toFixed(2)} ${anchor.x.toFixed(4)} ${anchor.y.toFixed(4)})">${content}</text>\n`;
    }

    svg += '    </g>\n';
  }
  svg += '  </g>\n';
  return svg;
}
