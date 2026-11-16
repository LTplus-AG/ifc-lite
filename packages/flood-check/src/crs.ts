/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifying a model's CRS and vertical datum well enough to compare them
 * with a data source's, and nothing more: no reprojection. A CRS that cannot
 * be pinned to an EPSG code is "unrecognised", and the check refuses.
 */

import type { ProjectedCRS } from '@ifc-lite/parser';

/** Names that unambiguously denote one EPSG CRS without saying "EPSG". */
const NAMED_CRS: ReadonlyArray<[RegExp, number]> = [
  [/^\s*(CH1903\+\s*\/\s*)?LV95\s*$/i, 2056],
  [/^\s*CH1903\+\s*\/\s*LV95\b/i, 2056],
];

/** `EPSG:2056` for `"EPSG:2056"`, `"epsg 2056"`, `"urn:ogc:def:crs:EPSG::2056"`; null otherwise. */
export function normalizeCrs(value: string | undefined | null): string | null {
  if (!value) return null;
  // The OGC URI form: http(s)://www.opengis.net/def/crs/EPSG/0/2056.
  const uri = /^\s*https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/[^/]+\/(\d{4,6})\s*$/i.exec(value);
  if (uri) return `EPSG:${Number(uri[1])}`;
  const m = /EPSG\s*:{0,2}\s*(\d{4,6})\b/i.exec(value);
  if (m) return `EPSG:${Number(m[1])}`;
  for (const [pattern, code] of NAMED_CRS) if (pattern.test(value)) return `EPSG:${code}`;
  return null;
}

export function sameCrs(a: string, b: string): boolean {
  const na = normalizeCrs(a);
  return na !== null && na === normalizeCrs(b);
}

/** The EPSG code a WKT's top-level ID/AUTHORITY names (the last one in the string). */
function epsgFromWkt(wkt: string): string | null {
  const ids = [...wkt.matchAll(/(?:ID|AUTHORITY)\s*\[\s*"EPSG"\s*,\s*"?(\d{4,6})"?\s*\]/gi)];
  if (ids.length === 0) return null;
  return `EPSG:${Number(ids[ids.length - 1][1])}`;
}

/**
 * The EPSG identifier of a model's projected CRS, from its Name, its WKT, or
 * its Description; null when none of them names one unambiguously.
 */
export function projectedCrsIdentifier(crs: ProjectedCRS): string | null {
  return (
    normalizeCrs(crs.name) ??
    (crs.wellKnownText ? epsgFromWkt(crs.wellKnownText) : null) ??
    normalizeCrs(crs.description)
  );
}

/**
 * The two EPSG codes when the CRS's Name and its WKT's top-level identifier
 * name different ones (a model saying EPSG:2056 whose WKT says EPSG:21781):
 * which one the coordinates are in cannot be told. Null when they agree or
 * either is missing.
 */
export function projectedCrsConflict(crs: ProjectedCRS): { name: string; wkt: string } | null {
  const name = normalizeCrs(crs.name);
  const wkt = crs.wellKnownText ? epsgFromWkt(crs.wellKnownText) : null;
  return name && wkt && name !== wkt ? { name, wkt } : null;
}

/** Spellings of one vertical CRS, keyed by its EPSG identifier. */
const VERTICAL_ALIASES: ReadonlyArray<readonly [string, ...string[]]> = [
  ['EPSG:5728', 'LN02', 'LANDESNIVELLEMENT1902', 'SWISSLN02', 'LN02HEIGHT'],
  ['EPSG:5729', 'LHN95', 'LANDESHOEHENNETZ1995', 'LANDESHÖHENNETZ1995', 'SWISSLHN95', 'LHN95HEIGHT'],
  ['EPSG:5709', 'NAP', 'NAPHEIGHT', 'NORMAALAMSTERDAMSPEIL'],
  ['EPSG:7837', 'DHHN2016', 'DHHN2016HEIGHT'],
  ['EPSG:5621', 'EVRF2007', 'EVRF2007HEIGHT'],
];

function squash(value: string): string {
  return value.toUpperCase().replace(/[\s_\-./()]+/g, '');
}

/**
 * The EPSG identifier of a vertical CRS named by `value`: an EPSG code in any
 * common spelling (`EPSG:5728`, `urn:ogc:def:crs:EPSG::5728`) or a known name
 * of one (`LN02`, `Landesnivellement 1902`, `NAP`). Null when it names none.
 */
export function verticalCrsIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const epsg = /EPSG\s*:{0,2}\s*(\d{4,6})/i.exec(value);
  if (epsg) return `EPSG:${Number(epsg[1])}`;
  const key = squash(value);
  for (const [code, ...names] of VERTICAL_ALIASES) if (names.includes(key)) return code;
  return null;
}
