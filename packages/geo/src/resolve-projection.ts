/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CRS resolution: from the CRS metadata an IFC file (or any other source)
 * carries to a proj4 definition.
 *
 * proj4 definitions are resolved from:
 *   1. The bundled EPSG index (@ifc-lite/data) — covers all 7000+ codes
 *   2. Programmatically constructed (UTM zones, well-known codes)
 *   3. The host's EPSG definition loader as last resort (`configureCrsLoaders`)
 */

import { lookupEpsgByCode } from '@ifc-lite/data';
import { crsLoaders } from './loaders.js';
import { PRECISION_GRIDS, resolvePrecisionDef } from './precision-grids.js';
import { isGeographicProj4, projectedDefinitionInMetres, utmProj4String } from './proj4-utils.js';
import {
  approximateProjectionCodes,
  projDefCache,
  refusedProjectionCodes,
  sanitizeProj4,
} from './sanitize-proj4.js';
import { wellKnownCrsCode } from './well-known-crs.js';
import { resolveWktProjection, withWktExtent } from './wkt-projection.js';

/**
 * The CRS metadata resolution reads. Structurally a subset of the parser's
 * `ProjectedCRS` (`IfcProjectedCRS` / `IfcGeographicCRS`), so one of those
 * passes as is; nothing here depends on IFC.
 */
export interface CrsDescriptor {
  /** `EPSG:<code>`, a well-known alias (`LV95`, `RD New`, ...) or free text. */
  name?: string;
  description?: string;
  mapProjection?: string;
  /** UTM zone, e.g. `32N`. */
  mapZone?: string;
  /** Map unit to metres (`IfcProjectedCRS.MapUnit`); absent reads as metres. */
  mapUnitScale?: number;
  /** WKT1 or WKT2 definition; authoritative over `name` when present. */
  wellKnownText?: string;
}

/**
 * Extract EPSG numeric code from a CRS name like "EPSG:32632" or "EPSG 2056".
 */
function extractEpsgCode(crs: CrsDescriptor): string | null {
  const match = crs.name?.match(/EPSG[:\s]*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * The EPSG code a CRS resolves through, when it names one: the identifier in
 * its WKT, an `EPSG:<code>` name, or a well-known alias. `null` for a CRS
 * defined by its WKT alone or by UTM metadata.
 */
export function declaredEpsgCode(crs: CrsDescriptor): string | null {
  const wkt = crs.wellKnownText ? resolveWktProjection(crs.wellKnownText) : null;
  if (wkt) return wkt.kind === 'epsg' ? wkt.code : null;
  return extractEpsgCode(crs) ?? wellKnownCrsCode(crs.name ?? '') ?? null;
}

/** Skip blank or invalid zone metadata before trying the next source. */
function utmDefinitionFromMetadata(crs: CrsDescriptor): string | null {
  const candidates = [crs.mapZone, ...[crs.name, crs.description, crs.mapProjection]
    .map(value => value?.match(/UTM\s+zone\s+(\d{1,2}[NS])/i)?.[1])];
  for (const zone of candidates) {
    const definition = zone ? utmProj4String(zone) : null;
    if (definition) return definition;
  }
  return null;
}

/**
 * Resolve a proj4 definition for the given CRS metadata.
 *
 * An `IfcWellKnownText` definition is authoritative over the name (which may
 * then be a placeholder such as "WKT"): an EPSG identifier it names resolves
 * through the order below, otherwise the WKT itself is the definition. A WKT
 * that cannot be read falls back to the name.
 *
 * Resolution order:
 *   1. Cache hit
 *   2. Precision grid (NTv2/GeoTIFF) for codes where +towgs84 is too coarse
 *      (RD/NL, OSGB/UK, BD72/BE) — loaded once through the host's grid
 *      loader, gives sub-decimeter accuracy. Falls through to (3) when no
 *      loader is installed or the load fails.
 *   3. Bundled EPSG index (7000+ codes with proj4 strings)
 *   4. UTM zone heuristic (from CRS metadata — mapZone, name, description, mapProjection)
 *   5. The host's EPSG definition loader (epsg.io when the host installs
 *      `epsgIoDefinitionLoader`; skipped when none is installed)
 */
export async function resolveProjection(crs: CrsDescriptor): Promise<string | null> {
  if (crs.wellKnownText) {
    const wkt = resolveWktProjection(crs.wellKnownText);
    if (wkt?.kind === 'definition') return wkt.definition;
    const named: CrsDescriptor = { ...crs, wellKnownText: undefined };
    const definition = await resolveProjection(wkt?.kind === 'epsg' ? { ...named, name: `EPSG:${wkt.code}` } : named);
    if (!definition || wkt?.kind !== 'epsg') return definition;
    // The WKT's own datum shift and declared extent still apply to the registry projection.
    return withWktExtent(crs.wellKnownText, wkt.towgs84
      ? `${definition.replace(/\s\+(?:towgs84|nadgrids)=\S+/g, '')} +towgs84=${wkt.towgs84}`
      : definition);
  }
  const explicitCode = extractEpsgCode(crs);
  const aliasCode = explicitCode ? undefined : wellKnownCrsCode(crs.name ?? '');
  // A datum-only geographic label may accompany an explicit UTM zone. Keep
  // that metadata interpretation local; caching it under EPSG:4326 would
  // corrupt subsequent geographic resolutions and make results load-order dependent.
  if (aliasCode && ['4326', '4269', '4267', '4258'].includes(aliasCode)) {
    const utm = utmDefinitionFromMetadata(crs);
    if (utm) {
      // Retain the declared datum rather than changing NAD27/NAD83/ETRS89
      // coordinates into WGS84 UTM. Cache only the native geographic CRS.
      const geographic = await resolveProjection({ name: `EPSG:${aliasCode}` });
      if (!geographic || !isGeographicProj4(geographic)) return null;
      const zoneParameters = utm.match(/\+zone=\d+(?: \+south)?/)?.[0];
      if (!zoneParameters) return null;
      return projectedDefinitionInMetres(geographic.replace(/\+proj=longlat\b/, `+proj=utm ${zoneParameters}`));
    }
  }
  const code = explicitCode ?? aliasCode ?? null;

  // 1. Check cache
  // A cached approximate/refused fallback is not terminal for a CRS with a
  // precision grid: a later online attempt may populate the grid cache. Exact
  // cached definitions remain fast and deterministic.
  if (code && projDefCache.has(code)
    && (!PRECISION_GRIDS[code] || (!approximateProjectionCodes.has(code) && !refusedProjectionCodes.has(code)))) {
    return projDefCache.get(code) ?? null;
  }

  // 2. Precision grid (NTv2/GeoTIFF). For Bessel-based national grids
  // (RD/NL, BD72/BE, OSGB/UK), the +towgs84 approximation that the bundled
  // entries carry is off by 80-200 m. proj4js can consume PROJ's GeoTIFF
  // datum-shift grids — load and register, then use a +nadgrids-based
  // proj4 string for sub-decimeter accuracy.
  if (code && PRECISION_GRIDS[code]) {
    try {
      const precisionDef = await resolvePrecisionDef(code);
      if (precisionDef) {
        approximateProjectionCodes.delete(code);
        refusedProjectionCodes.delete(code);
        projDefCache.set(code, precisionDef);
        return precisionDef;
      }
      // A listed precision grid is a required operation for placement. Its
      // bundled Helmert may still be useful for a map preview, but is never an
      // exact cached result and `resolveProjectionId` must refuse it by default.
      approximateProjectionCodes.add(code);
    } catch (error) {
      approximateProjectionCodes.add(code);
      console.warn(`[reproject] precision grid resolution failed for EPSG:${code}, falling back`, error);
    }
  }

  // 3. Bundled EPSG index (primary source — all 7000+ codes)
  if (code) {
    try {
      const entry = await lookupEpsgByCode(code);
      if (entry?.proj4) {
        const sanitized = sanitizeProj4(entry.proj4, code, entry.datum);
        projDefCache.set(code, sanitized);
        return sanitized;
      }
    } catch {
      // EPSG index not loaded yet, continue to fallbacks
    }
  }

  // 4. UTM zone heuristic — check mapZone, name, description, AND mapProjection
  const utm = utmDefinitionFromMetadata(crs);
  if (utm) {
    if (code) projDefCache.set(code, utm);
    return utm;
  }

  // 5. Last resort — the host's EPSG definition loader (epsg.io in the viewer)
  if (code) {
    const raw = await crsLoaders().epsgDefinition?.(code) ?? null;
    // We don't have a bundled EpsgIndexEntry here (otherwise we'd have hit
    // step 2), so fall back to parsing the datum name out of the proj4
    // string itself when possible. `+datum=` is rare in modern proj4 output;
    // the typical hint is `+ellps=` which we already accept as a weak signal
    // inside DATUM_TOWGS84 keys above.
    // Only positive-cache a successful result, so a transient network
    // failure (offline/CDN hiccup/timeout) can be retried later instead of
    // permanently poisoning this EPSG code for the rest of the session.
    const fetched = raw ? sanitizeProj4(raw, code, null) : null;
    if (fetched) projDefCache.set(code, fetched);
    return fetched;
  }

  return null;
}

/**
 * Resolve an adapter-supplied canonical CRS identifier.  Federation uses this
 * entry point rather than reconstructing an IFC-shaped `ProjectedCRS`: only
 * an explicit `EPSG:<code>` identifier is accepted here, so a display label
 * can never turn into a placement decision by accident.
 */
export interface ResolveProjectionIdOptions {
  /** Permit a documented browser approximation when its exact datum grid is unavailable. */
  allowApproximate?: boolean;
}

export type ProjectionOperation =
  | { kind: 'exact'; definition: string; provenance: 'cached-grid' | 'bundled' | 'network' }
  | { kind: 'approximate'; definition: string; provenance: 'helmert-fallback' }
  | { kind: 'refused'; reason: 'required-grid-unavailable' | 'approximation-not-authorized' | 'unresolvable' };

/**
 * Resolve a placement operation with its accuracy provenance.  Unlike map
 * display, federation has no safe implicit approximation: callers must opt in
 * to the documented Helmert fallback, and a grid with no fallback is refused.
 */
export async function resolveProjectionOperation(
  id: string,
  options: ResolveProjectionIdOptions = {},
): Promise<ProjectionOperation> {
  if (!/^EPSG:\d+$/i.test(id.trim())) return { kind: 'refused', reason: 'unresolvable' };
  const canonical = id.trim().toUpperCase();
  const code = canonical.slice('EPSG:'.length);
  const definition = await resolveProjection({ name: canonical });
  if (!definition) return { kind: 'refused', reason: 'unresolvable' };
  if (refusedProjectionCodes.has(code)) return { kind: 'refused', reason: 'required-grid-unavailable' };
  if (approximateProjectionCodes.has(code)) {
    return options.allowApproximate
      ? { kind: 'approximate', definition, provenance: 'helmert-fallback' }
      : { kind: 'refused', reason: 'approximation-not-authorized' };
  }
  return {
    kind: 'exact',
    definition,
    provenance: definition.includes('+nadgrids=') ? 'cached-grid' : 'bundled',
  };
}

export async function resolveProjectionId(
  id: string,
  options: ResolveProjectionIdOptions = {},
): Promise<string | null> {
  const operation = await resolveProjectionOperation(id, options);
  return operation.kind === 'refused' ? null : operation.definition;
}
