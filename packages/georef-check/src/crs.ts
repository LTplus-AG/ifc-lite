/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What can be known about a declared CRS without a catalogue: its EPSG code
 * when the file writes one, the UTM zone of the UTM codes, and the plausible
 * coordinate extent of the few CRS families whose extent follows from their
 * definition (UTM zones, the Swiss LV03/LV95 grids).
 */

import type { CrsCatalog, CrsFact } from './types.js';

/** An EPSG code and how it was found. */
export interface ResolvedCrs {
  code: number;
  via: 'name' | 'wellKnownText' | 'catalogName';
}

const EPSG_IN_NAME = /\bEPSG\s*[:\s]\s*:?\s*(\d{4,6})\b/i;
const EPSG_URN = /urn:ogc:def:crs:EPSG:[^:]*:(\d{4,6})\b/i;
const EPSG_URL = /opengis\.net\/def\/crs\/EPSG\/[^/]*\/(\d{4,6})\b/i;
const BARE_CODE = /^\s*(\d{4,6})\s*$/;
// WKT1 AUTHORITY["EPSG","2056"] / WKT2 ID["EPSG",2056]. The CRS's own
// identifier is the LAST one: nested datum/unit identifiers come before it.
const WKT_AUTHORITY = /(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d{4,6})"?/gi;

/** The EPSG code a CRS label names, if it names one (`EPSG:2056`, `urn:ogc:def:crs:EPSG::2056`, `2056`). */
export function epsgCodeFromLabel(label: string | undefined): number | undefined {
  if (!label) return undefined;
  const match = EPSG_URN.exec(label) ?? EPSG_URL.exec(label) ?? EPSG_IN_NAME.exec(label) ?? BARE_CODE.exec(label);
  return match ? Number(match[1]) : undefined;
}

/** The CRS's own EPSG identifier in a WKT1/WKT2 definition. */
export function epsgCodeFromWkt(wkt: string | undefined): number | undefined {
  if (!wkt) return undefined;
  let last: string | undefined;
  for (const match of wkt.matchAll(WKT_AUTHORITY)) last = match[1];
  return last === undefined ? undefined : Number(last);
}

/** Resolve a declared CRS to an EPSG code: its Name, then its WKT, then the catalogue's name lookup. */
export function resolveCrs(crs: CrsFact | undefined, catalog?: CrsCatalog): ResolvedCrs | undefined {
  if (!crs) return undefined;
  const fromName = epsgCodeFromLabel(crs.name);
  if (fromName !== undefined) return { code: fromName, via: 'name' };
  const fromWkt = epsgCodeFromWkt(crs.wellKnownText);
  if (fromWkt !== undefined) return { code: fromWkt, via: 'wellKnownText' };
  const name = crs.name.trim();
  const fromCatalog = name && catalog?.resolveName ? catalog.resolveName(name) : undefined;
  if (fromCatalog !== undefined) return { code: fromCatalog, via: 'catalogName' };
  return undefined;
}

export interface UtmZone {
  zone: number;
  south: boolean;
  /**
   * True for the "zE-N" variants (EPSG:4647, 5649, 5650) whose false easting
   * carries the zone number (32 500 000 instead of 500 000).
   */
  zonePrefixed: boolean;
}

/**
 * The UTM zone of a UTM EPSG code. Only code ranges whose every member is a
 * plain UTM zone are listed, so a national grid that merely uses a UTM-like
 * projection over a wider extent (SWEREF 99 TM, EPSG:3006) is NOT a zone here.
 */
export function utmZoneOfEpsg(code: number): UtmZone | undefined {
  const plain = (zone: number, south = false): UtmZone => ({ zone, south, zonePrefixed: false });
  if (code >= 32601 && code <= 32660) return plain(code - 32600); // WGS 84 / UTM zone nN
  if (code >= 32701 && code <= 32760) return plain(code - 32700, true); // WGS 84 / UTM zone nS
  if (code >= 25828 && code <= 25838) return plain(code - 25800); // ETRS89 / UTM zone 28N..38N
  if (code >= 3040 && code <= 3049) return plain(code - 3012); // ETRS89 / UTM zone 28N..37N (N-E)
  if (code >= 26901 && code <= 26923) return plain(code - 26900); // NAD83 / UTM zone 1N..23N
  if (code === 4647) return { zone: 32, south: false, zonePrefixed: true }; // ETRS89 / UTM zone 32N (zE-N)
  if (code === 5649) return { zone: 31, south: false, zonePrefixed: true };
  if (code === 5650) return { zone: 33, south: false, zonePrefixed: true };
  return undefined;
}

/** The zE-N code for a plain ETRS89 UTM zone, when EPSG defines one. */
export function zonePrefixedCodeFor(zone: UtmZone): number | undefined {
  if (zone.south || zone.zonePrefixed) return undefined;
  return ({ 31: 5649, 32: 4647, 33: 5650 } as Record<number, number>)[zone.zone];
}

/** The plain ETRS89 UTM code for a zE-N code. */
export function plainCodeFor(zone: UtmZone): number | undefined {
  return zone.zonePrefixed ? 25800 + zone.zone : undefined;
}

/** A rectangle in projected metres. */
export interface ProjectedExtent {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
  /** Where the numbers come from, for the evidence. */
  basis: string;
}

/**
 * LV95 (EPSG:2056) and LV03 (EPSG:21781): Switzerland and Liechtenstein span
 * E 2 485 000-2 834 000 / N 1 075 000-1 296 000 in LV95; LV03 is the same
 * rectangle less 2 000 000 / 1 000 000. 5 km of margin on every side.
 */
export const LV95_EXTENT: ProjectedExtent = { minE: 2_480_000, maxE: 2_840_000, minN: 1_070_000, maxN: 1_300_000, basis: 'LV95 national extent (+5 km)' };
export const LV03_EXTENT: ProjectedExtent = { minE: 480_000, maxE: 840_000, minN: 70_000, maxN: 300_000, basis: 'LV03 national extent (+5 km)' };

/**
 * A UTM zone's eastings stay within 166 000-834 000 m at the equator and
 * narrow toward the poles; 100 000-900 000 leaves room for the customary use
 * of a zone up to about one degree past its edge. Northings: 0-9 400 000 in the
 * north (84°N), 1 000 000-10 000 000 in the south (80°S).
 */
export function utmExtent(zone: UtmZone): ProjectedExtent {
  const offset = zone.zonePrefixed ? zone.zone * 1_000_000 : 0;
  return {
    minE: 100_000 + offset,
    maxE: 900_000 + offset,
    minN: zone.south ? 1_000_000 : 0,
    maxN: zone.south ? 10_000_000 : 9_400_000,
    basis: `UTM zone ${zone.zone}${zone.south ? 'S' : 'N'} extent`,
  };
}

/** The built-in extent of a CRS, when its definition fixes one. */
export function builtInExtent(code: number): ProjectedExtent | undefined {
  if (code === 2056) return LV95_EXTENT;
  if (code === 21781) return LV03_EXTENT;
  const zone = utmZoneOfEpsg(code);
  return zone ? utmExtent(zone) : undefined;
}

export function insideExtent(extent: ProjectedExtent, e: number, n: number): boolean {
  return e >= extent.minE && e <= extent.maxE && n >= extent.minN && n <= extent.maxN;
}
