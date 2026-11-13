/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DXFUnderlayOptions, Drawing2D } from '@ifc-lite/drawing-2d';
import type { jsPDF } from 'jspdf';
import type { Point2D, TextAnnotation2D } from '@/store/slices/drawing2DSlice';
import { resolvedElementTags } from './element-tags';

export const escapeTagXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

/** Existing DXF underlay text writer applies the same world/map transform as the cut. */
export function elementTagsDxf(drawing: Drawing2D, height: number): DXFUnderlayOptions {
  return { underlay: { name: 'Element tags', bounds: drawing.bounds, unitScale: 1, skipped: {}, warnings: [],
    layers: [{ name: 'IFC-TAGS', color: '#000000', visible: true, paths: [], fills: [],
      texts: resolvedElementTags(drawing).map(tag => ({ position: tag.position, text: tag.text, height,
        dirX: 1, dirY: 0, align: 'left', valign: 'baseline' })) }] } };
}

export function drawElementTagsPdf(doc: jsPDF, tags: readonly TextAnnotation2D[], map: (x: number, y: number) => Point2D): void {
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  for (const tag of tags) {
    const point = map(tag.position.x, tag.position.y);
    // Built-in PDF fonts support Latin-1 (including m²) but do not have ≈.
    doc.text(tag.text.replace(/≈/g, '~'), point.x, point.y);
  }
}
