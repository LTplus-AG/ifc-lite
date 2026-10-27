/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Projection definitions from an `IfcWellKnownText` CRS definition (IFC4X3).
 *
 * The WKT itself is read by proj4's own parser (`wkt-parser`, patched in
 * patches/wkt-parser@1.5.6.patch for WKT1-style parameter names inside WKT2)
 * — this module only selects the horizontal CRS of a compound one, prefers a
 * registered EPSG identifier when the WKT names one, and registers the parsed
 * definition with proj4 under a content-addressed name. Every proj4 call in
 * the viewer then takes that name exactly like a proj4 string.
 */

import proj4 from 'proj4';
import parseWkt from 'wkt-parser';
import {
  extractWktBoundingBox,
  extractWktHorizontalCrs,
  extractWktSpatialMetadata,
  type WktBoundingBox,
} from '@ifc-lite/pointcloud';

/** Prefix of the proj4 definition names registered for WKT CRSs. */
const WKT_DEFINITION_PREFIX = 'IFC-WKT:';
/** Suffix of the same definition with its projected unit overridden to metres. */
const METRES_SUFFIX = '#m';

/** proj4 datum types (proj4/lib/constants/values.js). */
const PJD_NODATUM = 5;
const WGS84_SEMI_MAJOR = 6378137;

interface ParsedWktDefinition {
  projName?: string;
  a?: number;
  datum_params?: unknown;
  nadgrids?: unknown;
  to_meter?: number;
  units?: string;
  [key: string]: unknown;
}

export type WktProjection =
  /** `towgs84`: a datum shift the WKT states itself, to replace the EPSG default. */
  | { kind: 'epsg'; code: string; towgs84?: string }
  | { kind: 'definition'; definition: string };

const resolved = new Map<string, WktProjection | null>();
const registered = new Map<string, { parsed: ParsedWktDefinition; extent?: WktBoundingBox }>();
const warnedExtents = new Set<string>();

/** FNV-1a; a cache key, not a security boundary. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function isWktDefinition(definition: string): boolean {
  return definition.startsWith(WKT_DEFINITION_PREFIX);
}

/** The parsed definition behind a registered name (either unit variant). */
export function registeredWktDefinition(definition: string): ParsedWktDefinition | undefined {
  return registration(definition)?.parsed;
}

function registration(definition: string) {
  return registered.get(definition.endsWith(METRES_SUFFIX) ? definition.slice(0, -METRES_SUFFIX.length) : definition);
}

/** The registered name of the same CRS with metre coordinates. */
export function wktDefinitionInMetres(definition: string): string {
  return definition.endsWith(METRES_SUFFIX) ? definition : `${definition}${METRES_SUFFIX}`;
}

/**
 * Resolve a CRS WKT (WKT1 or WKT2, single or compound) to a projection.
 *
 * Returns `{ kind: 'epsg' }` when the horizontal CRS carries an EPSG
 * identifier, so the registered definition (with its precision grids and
 * datum handling) wins over re-deriving it. A TOWGS84 the WKT states is
 * returned with it: it is the author's datum shift and replaces the registry
 * default. Otherwise registers the parsed WKT with proj4 (a BOUNDCRS keeps
 * its ABRIDGEDTRANSFORMATION there). The registry projection is preferred
 * because proj4's WKT1 reader mishandles some methods (Mercator_2SP reads
 * standard_parallel_1 as the latitude of origin). `null` when it cannot be read.
 */
export function resolveWktProjection(wkt: string): WktProjection | null {
  const text = wkt.trim();
  if (resolved.has(text)) return resolved.get(text) ?? null;
  const result = resolveUncached(text);
  resolved.set(text, result);
  return result;
}

function resolveUncached(wkt: string): WktProjection | null {
  const horizontal = extractWktHorizontalCrs(wkt);
  if (!horizontal) {
    console.warn('[reproject] IfcWellKnownText has no horizontal CRS (PROJCRS/GEOGCRS); it cannot place the model.');
    return null;
  }
  const epsg = extractWktSpatialMetadata(horizontal).horizontalId?.match(/^EPSG:(\d+)$/)?.[1];
  if (epsg) {
    // The projection comes from the registry; a TOWGS84 the WKT states is the
    // author's datum shift and replaces the registry default.
    const towgs84 = /\bTOWGS84\s*\[([^\]]*)\]/i.exec(horizontal)?.[1]
      ?.split(',').map((value) => Number(value.trim()));
    return towgs84 && (towgs84.length === 3 || towgs84.length === 7) && towgs84.every(Number.isFinite)
      ? { kind: 'epsg', code: epsg, towgs84: towgs84.join(',') }
      : { kind: 'epsg', code: epsg };
  }

  let parsed: ParsedWktDefinition;
  try {
    parsed = parseWkt(horizontal) as ParsedWktDefinition;
  } catch (error) {
    console.warn('[reproject] IfcWellKnownText could not be parsed; it cannot place the model.', error);
    return null;
  }
  // Keyed by the whole WKT: its extent (below) belongs to the registration.
  const name = `${WKT_DEFINITION_PREFIX}${hash(wkt)}`;
  try {
    proj4.defs(name, parsed as never);
    proj4.defs(`${name}${METRES_SUFFIX}`, (parsed.projName === 'longlat'
      ? parsed
      : { ...parsed, units: 'm', to_meter: 1 }) as never);
    // proj4 resolves the projection lazily; make an unsupported method fail here.
    proj4(name, 'WGS84');
  } catch (error) {
    console.warn('[reproject] IfcWellKnownText uses a projection proj4 does not support; it cannot place the model.', error);
    return null;
  }
  registered.set(name, { parsed, extent: extractWktBoundingBox(wkt) });

  const datum = (proj4.Proj(name) as { datum?: { datum_type?: number }; a?: number }).datum;
  if (datum?.datum_type === PJD_NODATUM && Math.abs((parsed.a ?? WGS84_SEMI_MAJOR) - WGS84_SEMI_MAJOR) > 1) {
    console.warn(
      '[reproject] IfcWellKnownText declares a non-WGS84 datum without a datum shift (TOWGS84/BOUNDCRS) '
      + 'that proj4 knows; positions may be off by tens to hundreds of metres.',
    );
  }
  return { kind: 'definition', definition: name };
}

/**
 * A registry definition chosen for a WKT that names an EPSG code, wrapped so
 * the WKT's declared extent still guards it: registered under an alias that
 * carries the extent, else returned unchanged when the WKT declares none.
 */
export function withWktExtent(wkt: string, definition: string): string {
  const extent = extractWktBoundingBox(wkt.trim());
  if (!extent) return definition;
  const name = `${WKT_DEFINITION_PREFIX}${hash(`${wkt.trim()}\n${definition}`)}`;
  if (!registered.has(name)) {
    const geographic = /\+proj=longlat\b/.test(definition);
    proj4.defs(name, definition);
    proj4.defs(`${name}${METRES_SUFFIX}`, geographic
      ? definition
      : `${definition.replace(/(?:^|\s)\+(?:units|to_meter)=\S+/g, '').trim()} +units=m`);
    registered.set(name, { parsed: proj4.defs(name) as unknown as ParsedWktDefinition, extent });
  }
  return name;
}

/**
 * Whether a WGS84 position lies within the declared extent of validity
 * (WKT2 `USAGE/BBOX`) of the WKT behind `definition`, widened by
 * `marginDegrees`. `true` for any other definition or a WKT without an extent.
 * This is the guard against a definition that parsed but means something else
 * than its author wrote: such a model lands far outside its own area of use.
 */
export function isWithinWktDefinitionExtent(definition: string, lon: number, lat: number, marginDegrees = 0.5): boolean {
  if (!isWktDefinition(definition)) return true;
  const box = registration(definition)?.extent;
  if (!box) return true;
  const withinLat = lat >= box.south - marginDegrees && lat <= box.north + marginDegrees;
  // An extent crossing the antimeridian has west > east.
  const withinLon = box.west <= box.east
    ? lon >= box.west - marginDegrees && lon <= box.east + marginDegrees
    : lon >= box.west - marginDegrees || lon <= box.east + marginDegrees;
  if (withinLat && withinLon) return true;
  const key = wktDefinitionInMetres(definition);
  if (!warnedExtents.has(key)) {
    warnedExtents.add(key);
    console.warn(
      `[reproject] IfcWellKnownText places the model at ${lat.toFixed(5)}, ${lon.toFixed(5)}, outside the `
      + `extent its WKT declares (BBOX ${box.south}, ${box.west}, ${box.north}, ${box.east}); refusing the position.`,
    );
  }
  return false;
}
