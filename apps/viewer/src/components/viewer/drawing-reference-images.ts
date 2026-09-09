/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DrawingReferenceImage } from '@/lib/appearance/references/drawing';

/** Two clipped affine triangles preserve all four registered corners, including
 * a non-rectangular imported quad, without replacing the engineering frame by
 * an axis-aligned image box. Coordinates here are CSS screen pixels. */
export function drawReferenceImages(ctx: CanvasRenderingContext2D, images: readonly DrawingReferenceImage[],
  toScreen: (x: number, y: number) => { x: number; y: number }): void {
  for (const { image, corners, opacity } of images) {
    if (image.width <= 0 || image.height <= 0) continue;
    const p = corners.map(corner => toScreen(corner.x, corner.y));
    for (const second of [false, true]) {
      const a = p[0], b = p[second ? 2 : 1], c = p[second ? 3 : 2];
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (!Number.isFinite(area) || Math.abs(area) < 1e-8) continue;
      const u = second ? { x: b.x - c.x, y: b.y - c.y } : { x: b.x - a.x, y: b.y - a.y };
      const v = second ? { x: c.x - a.x, y: c.y - a.y } : { x: c.x - b.x, y: c.y - b.y };
      ctx.save();
      try {
        ctx.globalAlpha = opacity;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.clip();
        ctx.transform(u.x / image.width, u.y / image.width, v.x / image.height, v.y / image.height, a.x, a.y);
        ctx.drawImage(image, 0, 0);
      } finally { ctx.restore(); }
    }
  }
}
