/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a georeferenced raster sits, read from the formats the terrain drape
 * accepts (#5942, mapping spec §15.1): a world file, GeoTIFF tags, and the
 * WKT a `.prj` / `.aux.xml` carries.
 *
 * Everything here is normalised to ONE convention, {@link RasterAffine}, whose
 * pixel coordinates address pixel CORNERS. The formats disagree on that, and
 * the disagreement is half a pixel (§15.3): a world file names the centre of
 * the upper-left pixel, a GeoTIFF tie point its corner under the default
 * `RasterPixelIsArea` and its centre under `RasterPixelIsPoint`.
 */

import { extractWktSpatialMetadata } from '@ifc-lite/pointcloud';

/**
 * Pixel → map, at pixel-CORNER coordinates:
 * `x = a·col + b·row + c`, `y = d·col + e·row + f`, where `(col, row) = (0, 0)`
 * is the top-left corner of the top-left pixel and rows run down the image.
 * `x` is easting and `y` northing in the raster's own CRS — the authored order
 * of every world file and geotransform, never reordered.
 */
export interface RasterAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export type RasterPlacementKind = 'world file' | 'GeoTIFF' | 'tiles';

/** A raster's size, georeferencing and declared CRS, before any reprojection. */
export interface GeoRasterPlacement {
  width: number;
  height: number;
  affine: RasterAffine;
  /** `EPSG:<code>`, or `null` when the source declares none it can prove. */
  crs: string | null;
  /** Where the CRS came from, for provenance and refusal messages. */
  crsSource: string;
  placement: RasterPlacementKind;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function invertible(affine: RasterAffine): boolean {
  const det = affine.a * affine.e - affine.b * affine.d;
  return Number.isFinite(det) && Math.abs(det) > 0;
}

/**
 * Parse an ESRI world file: six lines `A D B E C F`, where `C`/`F` locate the
 * CENTRE of the upper-left pixel. Returned at corner coordinates.
 */
export function parseWorldFile(text: string): Parsed<RasterAffine> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 6) {
    return { ok: false, reason: `The world file has ${lines.length} value line(s); a world file has exactly six.` };
  }
  const values = lines.slice(0, 6).map(Number);
  if (!finite(values)) return { ok: false, reason: 'The world file holds a value that is not a number.' };
  const [a, d, b, e, cx, cy] = values;
  const affine: RasterAffine = { a, b, d, e, c: cx - (a + b) / 2, f: cy - (d + e) / 2 };
  if (!invertible(affine)) return { ok: false, reason: 'The world file maps the image onto a line or a point.' };
  return { ok: true, value: affine };
}

/** The GeoTIFF tags a placement is read from, as `geotiff` exposes them. */
export interface GeoTiffPlacementTags {
  ModelTiepoint?: readonly number[];
  ModelPixelScale?: readonly number[];
  ModelTransformation?: readonly number[];
  /** `GTRasterTypeGeoKey`: 1 = PixelIsArea (default), 2 = PixelIsPoint. */
  rasterType?: number;
}

/** GeoTIFF geotransform at corner coordinates, honouring the raster type. */
export function geoTiffAffine(tags: GeoTiffPlacementTags): Parsed<RasterAffine> {
  if (tags.rasterType !== undefined && tags.rasterType !== 1 && tags.rasterType !== 2) {
    return { ok: false, reason: `The GeoTIFF declares raster type ${tags.rasterType}, which is neither PixelIsArea nor PixelIsPoint.` };
  }
  // Under PixelIsPoint, raster (0, 0) is the centre of the upper-left pixel:
  // the corner coordinate of raster (i, j) is (i + ½, j + ½).
  const shift = tags.rasterType === 2 ? 0.5 : 0;
  const transformation = tags.ModelTransformation;
  if (transformation && transformation.length >= 16) {
    const [m0, m1, , m3, m4, m5, , m7] = transformation;
    if (!finite([m0, m1, m3, m4, m5, m7])) return { ok: false, reason: 'The GeoTIFF ModelTransformation holds a non-finite value.' };
    const affine: RasterAffine = {
      a: m0, b: m1, d: m4, e: m5,
      c: m3 - (m0 + m1) * shift, f: m7 - (m4 + m5) * shift,
    };
    return invertible(affine) ? { ok: true, value: affine } : { ok: false, reason: 'The GeoTIFF ModelTransformation is degenerate.' };
  }
  const tie = tags.ModelTiepoint;
  const scale = tags.ModelPixelScale;
  if (!tie || tie.length < 6 || !scale || scale.length < 2) {
    return { ok: false, reason: 'The GeoTIFF carries no geotransform (neither ModelTransformation nor a tie point with a pixel scale).' };
  }
  if (tie.length > 6) {
    // Several tie points without a transformation describe a warp through
    // ground control points; an affine taken from the first would be a guess.
    return { ok: false, reason: `The GeoTIFF is placed by ${tie.length / 6} ground control points, not a geotransform.` };
  }
  const [i, j, , x, y] = tie;
  const [sx, sy] = scale;
  if (!finite([i, j, x, y, sx, sy]) || sx <= 0 || sy <= 0) {
    return { ok: false, reason: 'The GeoTIFF tie point or pixel scale is not a finite, positive geotransform.' };
  }
  // Rows run down the image while northing runs up: the y scale enters negated.
  return { ok: true, value: { a: sx, b: 0, d: 0, e: -sy, c: x - (i + shift) * sx, f: y + (j + shift) * sy } };
}

/** GeoTIFF GeoKeys the CRS is read from (`geotiff`'s `getGeoKeys()`). */
export interface GeoTiffCrsKeys {
  GTModelTypeGeoKey?: number;
  ProjectedCSTypeGeoKey?: number;
  GeographicTypeGeoKey?: number;
}

/**
 * The GeoTIFF's CRS as an EPSG code. `32767` is GeoTIFF's "user-defined": the
 * CRS is spelled out parameter by parameter and has no code, which the drape
 * refuses rather than matches (§15.2 item 2).
 */
export function geoTiffCrs(keys: GeoTiffCrsKeys): string | null {
  const code = (value: number | undefined): string | null => (
    value !== undefined && Number.isInteger(value) && value > 0 && value !== 32767 ? `EPSG:${value}` : null
  );
  // A projected raster whose projection is user-defined still names its
  // geographic BASE code; falling back to it would read metres as degrees.
  if (keys.GTModelTypeGeoKey === 2) return code(keys.GeographicTypeGeoKey);
  if (keys.GTModelTypeGeoKey === undefined || keys.GTModelTypeGeoKey === 1) return code(keys.ProjectedCSTypeGeoKey);
  return null;
}

/** The horizontal EPSG code a WKT (`.prj`) declares through an authority, or null. */
export function crsFromWkt(wkt: string): string | null {
  const id = extractWktSpatialMetadata(wkt.trim()).horizontalId;
  return id && /^EPSG:\d+$/i.test(id) ? id.toUpperCase() : null;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The `<SRS>` WKT of a GDAL `.aux.xml` sidecar, entity-decoded. */
export function wktFromAuxXml(xml: string): string | null {
  const match = /<SRS\b[^>]*>([\s\S]*?)<\/SRS>/i.exec(xml);
  if (!match) return null;
  return match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]).trim() || null;
}
