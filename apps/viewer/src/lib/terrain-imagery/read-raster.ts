/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read a {@link GeoRasterBundle} into a placement and its image bytes (#5942).
 *
 * Refusals follow mapping spec §15.2 item 2 exactly: no world file, no
 * geotransform, or no CRS that names an EPSG code is a refusal with the reason
 * — the raster is never placed by its pixel bounds.
 */

import {
  crsFromWkt, geoTiffAffine, geoTiffCrs, parseWorldFile, wktFromAuxXml,
  type GeoRasterPlacement, type Parsed,
} from './georaster.js';
import type { GeoRasterBundle } from './raster-bundle.js';

/** Above this the decode alone needs gigabytes (§15.2 item 8). */
export const MAX_DRAPE_MEGAPIXELS = 64;

export type GeoRasterMime = 'image/png' | 'image/jpeg' | 'image/tiff';

export interface LoadedGeoRaster {
  name: string;
  placement: GeoRasterPlacement;
  /** The image bytes exactly as supplied — hashed for provenance, shipped by the export. */
  bytes: Uint8Array;
  mime: GeoRasterMime;
}

/** Pixel size of a PNG or JPEG from its header, without decoding it. */
export function webImageSize(bytes: Uint8Array): { width: number; height: number; mime: 'image/png' | 'image/jpeg' } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20), mime: 'image/png' };
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2);
    // SOF0..SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7), mime: 'image/jpeg' };
    }
    offset += 2 + length;
  }
  return null;
}

function budget(width: number, height: number): string | null {
  return width * height > MAX_DRAPE_MEGAPIXELS * 1_000_000
    ? `The image is ${width} × ${height} px (${((width * height) / 1e6).toFixed(0)} MP); the drape decodes at most `
      + `${MAX_DRAPE_MEGAPIXELS} MP. Downsample it first.`
    : null;
}

/** The first CRS sidecar that names an EPSG code, else the first one consulted. */
async function crsOfSidecar(bundle: GeoRasterBundle): Promise<{ crs: string | null; source: string }> {
  for (const file of bundle.crsFiles) {
    const text = await file.text();
    const wkt = /\.aux\.xml$/i.test(file.name) ? wktFromAuxXml(text) : text;
    const crs = wkt ? crsFromWkt(wkt) : null;
    if (crs) return { crs, source: file.name };
  }
  return { crs: null, source: bundle.crsFiles[0]?.name ?? 'none' };
}

async function readWebImage(bundle: GeoRasterBundle, bytes: Uint8Array): Promise<Parsed<LoadedGeoRaster>> {
  const size = webImageSize(bytes);
  if (!size) return { ok: false, reason: `${bundle.name} is not a PNG or JPEG image.` };
  if (!bundle.worldFile) {
    return {
      ok: false,
      reason: `${bundle.name} has no world file beside it (${bundle.name.replace(/\.[^.]+$/, '')}.pgw / .jgw / .wld), `
        + 'so there is nothing to place it by. A texture for a glTF must be selected together with its .gltf.',
    };
  }
  const affine = parseWorldFile(await bundle.worldFile.text());
  if (!affine.ok) return { ok: false, reason: `${bundle.worldFile.name}: ${affine.reason}` };
  const over = budget(size.width, size.height);
  if (over) return { ok: false, reason: over };
  const { crs, source } = await crsOfSidecar(bundle);
  return {
    ok: true,
    value: {
      name: bundle.name,
      bytes,
      mime: size.mime,
      placement: { width: size.width, height: size.height, affine: affine.value, crs, crsSource: source, placement: 'world file' },
    },
  };
}

async function readGeoTiff(bundle: GeoRasterBundle, bytes: Uint8Array): Promise<Parsed<LoadedGeoRaster>> {
  const { fromArrayBuffer } = await import('geotiff');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let tiff;
  try {
    tiff = await fromArrayBuffer(buffer);
  } catch (error) {
    return { ok: false, reason: `${bundle.name} is not a readable TIFF: ${error instanceof Error ? error.message : String(error)}` };
  }
  const image = await tiff.getImage(0);
  const directory = image.fileDirectory;
  const tag = async (name: 'ModelTiepoint' | 'ModelPixelScale' | 'ModelTransformation'): Promise<number[] | undefined> => (
    directory.hasTag(name) ? Array.from(await directory.loadValue(name) as ArrayLike<number>) : undefined
  );
  for (const name of ['GeoKeyDirectory', 'GeoDoubleParams', 'GeoAsciiParams'] as const) {
    if (directory.hasTag(name)) await directory.loadValue(name);
  }
  const keys = image.getGeoKeys() ?? {};
  const [ModelTiepoint, ModelPixelScale, ModelTransformation] = await Promise.all([
    tag('ModelTiepoint'), tag('ModelPixelScale'), tag('ModelTransformation'),
  ]);
  // A world file beside a GeoTIFF is how GDAL writes one without GeoTIFF
  // tags; the tags win when both exist, as in GDAL.
  const tagged = geoTiffAffine({ ModelTiepoint, ModelPixelScale, ModelTransformation, rasterType: keys.GTRasterTypeGeoKey });
  const affine = tagged.ok || !bundle.worldFile ? tagged : parseWorldFile(await bundle.worldFile.text());
  if (!affine.ok) return { ok: false, reason: `${bundle.name}: ${affine.reason}` };
  const width = image.getWidth();
  const height = image.getHeight();
  const over = budget(width, height);
  if (over) return { ok: false, reason: over };
  const keyed = geoTiffCrs(keys);
  const sidecar = keyed ? null : await crsOfSidecar(bundle);
  return {
    ok: true,
    value: {
      name: bundle.name,
      bytes,
      mime: 'image/tiff',
      placement: {
        width, height, affine: affine.value,
        crs: keyed ?? sidecar?.crs ?? null,
        crsSource: keyed ? 'GeoTIFF GeoKeys' : sidecar?.source ?? 'none',
        placement: tagged.ok ? 'GeoTIFF' : 'world file',
      },
    },
  };
}

/** Read and place a raster bundle. The CRS may still be `null`; the drape refuses that. */
export async function readGeoRasterBundle(bundle: GeoRasterBundle): Promise<Parsed<LoadedGeoRaster>> {
  const bytes = new Uint8Array(await bundle.image.arrayBuffer());
  return bundle.isGeoTiff ? readGeoTiff(bundle, bytes) : readWebImage(bundle, bytes);
}
