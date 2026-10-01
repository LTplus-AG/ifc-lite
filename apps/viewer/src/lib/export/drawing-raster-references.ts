/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { referenceAffineTriangles } from '@/lib/appearance/references/affine-triangles';
import { fitRasterPixels, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { ViewerState } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { referenceDrawingCorners, type DrawingReferenceImage } from '@/lib/appearance/references/drawing';
import { drawReferenceImages } from '@/components/viewer/drawing-reference-images';

interface RasterReference {
  id: string;
  assetId: string;
  width: number;
  height: number;
  href: string;
  corners: DrawingReferenceImage['corners'];
  opacity: number;
}
export interface DrawingReferenceSnapshot {
  references: readonly RasterReference[];
  decode(): Promise<readonly DrawingReferenceImage[]>;
  release(): void;
}
function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Capture exact committed bytes and placement before any asynchronous export. */
export function snapshotDrawingReferences(state: ViewerState, plane: SectionPlaneConfig): DrawingReferenceSnapshot {
  const owner = { kind: 'draft' as const, id: `reference-export:${crypto.randomUUID()}` };
  const references: RasterReference[] = [];
  try {
    for (const record of state.appearanceReferences.values()) {
      const corners = referenceDrawingCorners(record, state, plane);
      if (!corners) continue;
      const asset = appearanceAssets.get(record.assetId);
      if (!asset) throw new Error('A visible drawing reference needs its image relinked before export.');
      appearanceAssets.retain(record.assetId, owner);
      references.push({ id: record.id, assetId: asset.id, width: asset.width, height: asset.height,
        href: dataUrl(appearanceAssets.encoded(asset.id), asset.mimeType),
        corners: corners.map(p => ({ ...p })) as unknown as RasterReference['corners'], opacity: record.opacity });
    }
  } catch (error) { appearanceAssets.releaseOwner(owner); throw error; }
  return { references, release: () => appearanceAssets.releaseOwner(owner), decode: async () => {
    const images: DrawingReferenceImage[] = [];
    for (const r of references) images.push({ id: r.id, corners: r.corners, opacity: r.opacity,
      image: await appearanceAssets.decode(r.assetId, owner) });
    return images;
  } };
}

type MapPoint = (x: number, y: number) => { x: number; y: number };
/** #6615: mirror the canvas's two clipped affine triangles, including corner 4. */
export function buildRasterReferenceSvg(references: DrawingReferenceSnapshot['references'], mapPoint: MapPoint): string {
  if (!references.length) return '';
  let svg = '<g id="raster-references">';
  references.forEach((reference, index) => {
    const p = reference.corners.map(c => mapPoint(c.x, c.y));
    referenceAffineTriangles(p, reference.width, reference.height).forEach(({vertices,matrix}, triangleIndex) => {
      const clip = `reference-export-${index}-${triangleIndex}`;
      svg += `<defs><clipPath id="${clip}" clipPathUnits="userSpaceOnUse"><polygon points="${vertices.map(q => `${q.x},${q.y}`).join(' ')}"/></clipPath></defs>`;
      svg += `<g opacity="${reference.opacity}" clip-path="url(#${clip})"><image href="${reference.href}" width="${reference.width}" height="${reference.height}" transform="matrix(${matrix.join(' ')})"/></g>`;
    });
  });
  return svg + '</g>';
}

export function drawingReferenceSvg(state: ViewerState, plane: SectionPlaneConfig, mapPoint: MapPoint): string {
  const snapshot = snapshotDrawingReferences(state, plane);
  try { return buildRasterReferenceSvg(snapshot.references, mapPoint); }
  finally { snapshot.release(); }
}

/** Transparent bounded raster underlayer only; the PDF's cut strokes stay vector. */
export async function rasterizeReferenceLayer(snapshot: DrawingReferenceSnapshot, widthMm: number, heightMm: number,
  mapPoint: MapPoint): Promise<string | null> {
  if (!snapshot.references.length) return null;
  const fit = fitRasterPixels(widthMm, heightMm, 150, 16 * 1024 * 1024, 8192);
  const canvas = document.createElement('canvas');
  canvas.width = fit.widthPx; canvas.height = fit.heightPx;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable for drawing references.');
    const images = await snapshot.decode();
    drawReferenceImages(context, images, (x, y) => {
      const p = mapPoint(x, y);
      return { x: p.x * fit.widthPx / widthMm, y: p.y * fit.heightPx / heightMm };
    });
    const png = canvas.toDataURL('image/png');
    if (!png.startsWith('data:image/png')) throw new Error('The browser could not rasterize drawing references. Use SVG export.');
    return png;
  } finally { canvas.width = 0; canvas.height = 0; }
}
