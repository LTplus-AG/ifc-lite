/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { referenceAffineTriangles } from '@/lib/appearance/references/affine-triangles';
import type { DrawingReferenceImage } from '@/lib/appearance/references/drawing';

/** Two clipped affine triangles preserve all four registered corners, including
 * a non-rectangular imported quad, without replacing the engineering frame by
 * an axis-aligned image box. Coordinates here are CSS screen pixels. */
export function drawReferenceImages(ctx: CanvasRenderingContext2D, images: readonly DrawingReferenceImage[],
  toScreen: (x: number, y: number) => { x: number; y: number }): void {
  for (const { image, corners, opacity } of images) {
    if (image.width <= 0 || image.height <= 0) continue;
    const p = corners.map(corner => toScreen(corner.x, corner.y));
    for (const triangle of referenceAffineTriangles(p, image.width, image.height)) {
      const [a,b,c] = triangle.vertices;
      ctx.save();
      try {
        ctx.globalAlpha = opacity;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.clip();
        ctx.transform(...triangle.matrix);
        ctx.drawImage(image, 0, 0);
      } finally { ctx.restore(); }
    }
  }
}
