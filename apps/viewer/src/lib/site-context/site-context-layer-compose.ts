/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composing the site-context terrain's map layers into one drape texture:
 * aerial imagery, the overland flow map, or the map over the imagery, and the
 * guard that refuses a hazard answer transparent over the whole site.
 */

import { borderedTexture, type DrapeTexture } from '@/lib/terrain-imagery/raster-texture';

/** True when any pixel of RGBA `data` is not fully transparent. */
export function anyVisiblePixel(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
}

/**
 * The hazard map answers transparent PNGs during an outage exactly as where nothing is mapped, so an answer that
 * is transparent over the WHOLE site is refused rather than draped: draped, it would read as "no runoff" while the
 * legend says the map is shown. Read at up to 1024 px a side (a downsampled pixel keeps a non-zero alpha).
 */
export function assertHazardShowsSomething(images: readonly ImageBitmap[]): void {
  for (const image of images) {
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
    const context = new OffscreenCanvas(w, h).getContext('2d');
    if (!context) throw new Error('This browser cannot read the overland flow map (no 2D canvas).');
    context.drawImage(image, 0, 0, w, h);
    if (anyVisiblePixel(context.getImageData(0, 0, w, h).data)) return;
  }
  throw new Error('the overland flow map came back empty over the whole site. That cannot be told from a service outage, so it is not draped; try again later.');
}

/**
 * One layer as given, or the hazard map over the imagery. `borderedTexture`
 * frames the result in the flat terrain colour, which also shows through
 * wherever the hazard map alone is transparent (no runoff modelled).
 */
export function composeLayers(width: number, height: number, flat: readonly [number, number, number], imagery: ImageBitmap | null, hazard: ImageBitmap | null): DrapeTexture {
  if (!imagery || !hazard) {
    const single = imagery ?? hazard;
    if (!single) throw new Error('No map layer arrived to drape.');
    return borderedTexture(single, width, height, flat);
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot compose the drape texture (no 2D canvas).');
  context.drawImage(imagery, 0, 0, width, height);
  // The publisher's legend colours, unaltered (no opacity): the viewport legend shows the same swatches.
  context.drawImage(hazard, 0, 0, width, height);
  return borderedTexture(canvas, width, height, flat);
}
