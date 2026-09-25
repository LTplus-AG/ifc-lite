/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GPU texture a terrain drape samples (#5942, mapping spec §15.4).
 *
 * The decoded image is framed by a ONE-PIXEL BORDER in the terrain's flat
 * colour and sampled clamp-to-edge. A fragment whose UV falls off the image
 * then samples that border, so the uncovered terrain keeps its flat colour and
 * the change happens exactly at the image edge — not at the nearest vertex,
 * which is where a per-vertex fallback would put it. The draped mesh's colour
 * becomes white so the textured shader (`texture(uv) × baseColor`) passes the
 * image through untinted.
 *
 * The image is downsampled to the WebGPU texture floor when larger; the
 * ground sample distance the viewer reports is the displayed one.
 */

import type { LoadedGeoRaster } from './read-raster.js';

/** WebGPU's guaranteed `maxTextureDimension2D`; the border takes two texels. */
export const DRAPE_TEXTURE_MAX_DIMENSION = 8192;

export interface DrapeTexture {
  bitmap: ImageBitmap;
  /** Displayed image size in texels, excluding the border. */
  imageWidth: number;
  imageHeight: number;
}

/**
 * Map IFC-convention drape UVs (bottom-left origin, 0–1 over the image) into
 * the bordered GPU texture (top-left origin, the image inset by one texel).
 */
export function borderedGpuUvs(uvs: Float64Array, imageWidth: number, imageHeight: number): Float32Array {
  const out = new Float32Array(uvs.length);
  const width = imageWidth + 2;
  const height = imageHeight + 2;
  for (let i = 0; i < uvs.length; i += 2) {
    out[i] = (1 + uvs[i] * imageWidth) / width;
    out[i + 1] = (1 + (1 - uvs[i + 1]) * imageHeight) / height;
  }
  return out;
}

function fitted(width: number, height: number): [number, number] {
  const limit = DRAPE_TEXTURE_MAX_DIMENSION - 2;
  const scale = Math.min(1, limit / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function decodeTiff(raster: LoadedGeoRaster, width: number, height: number): Promise<ImageBitmap> {
  const { fromArrayBuffer } = await import('geotiff');
  const bytes = raster.bytes;
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const image = await tiff.getImage(0);
  if (image.getBitsPerSample(0) !== 8) {
    throw new Error(`${raster.name} has ${image.getBitsPerSample(0)}-bit samples; the drape reads 8-bit imagery. Convert it to 8-bit RGB first.`);
  }
  const rgb = await image.readRGB({ interleave: true, enableAlpha: true, width, height });
  const channels = rgb.length / (width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = rgb[pixel * channels];
    rgba[pixel * 4 + 1] = rgb[pixel * channels + 1];
    rgba[pixel * 4 + 2] = rgb[pixel * channels + 2];
    rgba[pixel * 4 + 3] = channels === 4 ? rgb[pixel * 4 + 3] : 255;
  }
  return createImageBitmap(new ImageData(rgba, width, height));
}

/** Frame an already-decoded image in the flat terrain colour (§15.4). */
export function borderedTexture(
  source: CanvasImageSource, width: number, height: number, border: readonly [number, number, number],
): DrapeTexture {
  const canvas = new OffscreenCanvas(width + 2, height + 2);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot compose the drape texture (no 2D canvas).');
  const [r, g, b] = border.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255));
  context.fillStyle = `rgb(${r}, ${g}, ${b})`;
  context.fillRect(0, 0, width + 2, height + 2);
  context.drawImage(source, 1, 1, width, height);
  return { bitmap: canvas.transferToImageBitmap(), imageWidth: width, imageHeight: height };
}

/** Decode, downsample to the texture limit, and frame in the flat terrain colour. */
export async function decodeDrapeTexture(
  raster: LoadedGeoRaster,
  border: readonly [number, number, number],
): Promise<DrapeTexture> {
  const [width, height] = fitted(raster.placement.width, raster.placement.height);
  const source = raster.mime === 'image/tiff'
    ? await decodeTiff(raster, width, height)
    : await createImageBitmap(new Blob([raster.bytes.slice()], { type: raster.mime }), {
      resizeWidth: width, resizeHeight: height, resizeQuality: 'high',
    });
  try {
    return borderedTexture(source, width, height, border);
  } finally {
    source.close();
  }
}
