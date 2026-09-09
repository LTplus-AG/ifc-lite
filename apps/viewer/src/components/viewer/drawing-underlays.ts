/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay';

function dxfValignToBaseline(valign: 'baseline' | 'bottom' | 'middle' | 'top'): CanvasTextBaseline {
  switch (valign) {
    case 'bottom': return 'bottom';
    case 'middle': return 'middle';
    case 'top': return 'top';
    default: return 'alphabetic';
  }
}

/**
 * Render imported DXF underlays beneath the generated drawing, in screen
 * pixels. Geometry arrives pre-mapped to drawing space (render-frame
 * shift, flipped-section mirror, and user placement already applied by
 * useDxfUnderlaysForDrawing — plan sections only), so the caller supplies
 * the plain drawing→screen transform. Text is drawn in screen space (like
 * the IFC annotation overlay) so canvas scaling never mirrors glyphs.
 */
export function drawDxfUnderlaysScreenSpace(
  ctx: CanvasRenderingContext2D,
  underlays: readonly DxfUnderlayRenderData[] | undefined,
  modelToScreen: (x: number, y: number) => { x: number; y: number },
  mmLineToScreen: (mmWeight: number) => number,
  worldHeightToScreenPx: (worldHeight: number) => number,
): void {
  if (!underlays || underlays.length === 0) return;

  for (const data of underlays) {
    if (data.opacity <= 0) continue;
    ctx.save();
    ctx.globalAlpha = data.opacity;

    // Fills first so linework composites on top.
    for (const fill of data.fills) {
      ctx.fillStyle = fill.color;
      ctx.globalAlpha = data.opacity * (fill.pattern ? 0.25 : 1);
      ctx.beginPath();
      for (const ring of fill.loops) {
        if (ring.length < 3) continue;
        const first = modelToScreen(ring[0].x, ring[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < ring.length; i++) {
          const p = modelToScreen(ring[i].x, ring[i].y);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.globalAlpha = data.opacity;
    }

    for (const line of data.lines) {
      if (line.points.length < 2) continue;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = mmLineToScreen(line.widthMm ?? 0.18);
      ctx.setLineDash(line.dashed ? [5, 4] : []);
      ctx.beginPath();
      const first = modelToScreen(line.points[0].x, line.points[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < line.points.length; i++) {
        const p = modelToScreen(line.points[i].x, line.points[i].y);
        ctx.lineTo(p.x, p.y);
      }
      if (line.closed) ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const text of data.texts) {
      const fontPx = worldHeightToScreenPx(text.height);
      if (fontPx < 4) continue; // declutter when zoomed far out
      const anchor = modelToScreen(text.x, text.y);
      const tip = modelToScreen(text.x + text.dirX, text.y + text.dirY);
      const sx = tip.x - anchor.x;
      const sy = tip.y - anchor.y;
      const angle = Math.abs(sx) + Math.abs(sy) > 1e-6 ? Math.atan2(sy, sx) : 0;

      ctx.save();
      ctx.fillStyle = text.color;
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      ctx.textAlign = text.align;
      ctx.textBaseline = dxfValignToBaseline(text.valign);
      ctx.translate(anchor.x, anchor.y);
      ctx.rotate(angle);
      const lines = text.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 0, i * fontPx * 1.3);
      }
      ctx.restore();
    }

    ctx.restore();
  }
}

