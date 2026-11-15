/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Area of use, native unit and compound components for the bundled EPSG index.
 *
 * The data lives in a separate lazily loaded module
 * (`generated/epsg-extents.generated.ts`, produced by
 * `scripts/generate-epsg-extents.ts`) so the search index stays the size it
 * was and callers that never ask for extents never download them.
 */

import { loadEpsgIndex, loadEpsgIndexByCode } from './epsg-index.js';
import type { EpsgIndexEntry } from './epsg-types.js';

/**
 * EPSG area-of-use bounding box in WGS84 degrees. When `west > east` the box
 * crosses the antimeridian (e.g. Fiji, UTM zone 1): it covers longitudes
 * `west..180` and `-180..east`. `crossesAntimeridian` states that explicitly.
 */
export interface EpsgAreaOfUse {
  west: number;
  south: number;
  east: number;
  north: number;
  crossesAntimeridian: boolean;
}

/** An EPSG axis unit. */
export interface EpsgUnit {
  /** EPSG unit name, e.g. `metre`, `US survey foot`, `degree`, `(bin)`. */
  name: string;
  /**
   * Metres per unit for length units; `undefined` for angular units and for
   * units with no metre factor (the `(bin)` unit of four Derived/Engineering CRSs).
   */
  metres: number | undefined;
}

/**
 * Native units of a CRS. `horizontal` is the unit of the first axis of a
 * horizontal CRS (a compound CRS reports its horizontal component's) and is
 * absent for vertical-only CRSs. `vertical` is the unit of a vertical CRS, or
 * of a compound CRS's vertical component.
 */
export interface EpsgUnits {
  horizontal?: EpsgUnit;
  vertical?: EpsgUnit;
}

export interface EpsgCompoundComponents {
  /** EPSG code of the horizontal component. */
  horizontal: string;
  /** EPSG code of the vertical component. */
  vertical: string;
}

/** Coarse CRS kind, as used by georeference checks. */
export type EpsgCrsKind = 'projected' | 'geographic' | 'compound' | 'vertical' | 'other';

interface ExtentsData {
  units: Array<[string, number | null]>;
  boxes: Array<[number, number, number, number]>;
  rows: Record<string, [number, number[], (number | null)?, (number | null)?]>;
}

let extentsPromise: Promise<ExtentsData> | null = null;

async function loadExtentsData(): Promise<ExtentsData> {
  if (!extentsPromise) {
    extentsPromise = import('./generated/epsg-extents.generated.js')
      .then(module => JSON.parse(module.EPSG_EXTENTS_JSON) as ExtentsData)
      .catch(error => {
        extentsPromise = null;
        throw error;
      });
  }
  return extentsPromise;
}

/** Date (YYYY-MM-DD) the extents were fetched from the EPSG registry. */
export async function loadEpsgExtentsFetchedDate(): Promise<string> {
  return (await import('./generated/epsg-extents.generated.js')).EPSG_EXTENTS_FETCHED;
}

/**
 * EPSG Dataset version of the extents (for example `13.106`). It can differ
 * from `loadEpsgIndexDatasetVersion()`: the extents were generated from a newer
 * registry than the main index (see the package README).
 */
export async function loadEpsgExtentsDatasetVersion(): Promise<string> {
  return (await import('./generated/epsg-extents.generated.js')).EPSG_EXTENTS_DATASET_VERSION;
}

function toAreaOfUse([west, south, east, north]: [number, number, number, number]): EpsgAreaOfUse {
  return { west, south, east, north, crossesAntimeridian: west > east };
}

function codeKey(code: string | number): string {
  return String(code).trim();
}

/** Row of a code; only own keys count, so `toString`/`constructor` are unknown codes rather than inherited functions. */
function rowOf(data: ExtentsData, key: string): ExtentsData['rows'][string] | undefined {
  return Object.prototype.hasOwnProperty.call(data.rows, key) ? data.rows[key] : undefined;
}

/**
 * Whether a WGS84 longitude/latitude lies in an area of use, widened by
 * `marginDegrees` on every side. Antimeridian-aware: longitudes are compared
 * modulo 360, so `-179` is inside a box `170..-170`, and a margin never
 * wraps past a pole.
 *
 * Non-finite input and `|latitude| > 90` are outside (a margin cannot admit
 * them). A negative or non-finite margin throws a `RangeError`.
 */
export function isLonLatInAreaOfUse(
  area: Pick<EpsgAreaOfUse, 'west' | 'south' | 'east' | 'north'>,
  longitude: number,
  latitude: number,
  marginDegrees = 0,
): boolean {
  if (!Number.isFinite(marginDegrees) || marginDegrees < 0) {
    throw new RangeError(`marginDegrees must be a finite number >= 0, got ${marginDegrees}`);
  }
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return false;
  const margin = marginDegrees;
  if (latitude < area.south - margin || latitude > area.north + margin) return false;
  const lo = area.west - margin;
  // A crossing box runs west..east+360; compare the longitude in each 360° copy
  // so no arithmetic touches values that are already exact in the data.
  const hi = (area.east >= area.west ? area.east : area.east + 360) + margin;
  if (hi - lo >= 360) return true;
  // `%` is exact in floating point, so a longitude within one revolution is compared untouched
  // (box edges stay exact) and one beyond it is first reduced to the equivalent in (-360, 360).
  const lon = Math.abs(longitude) >= 360 ? longitude % 360 : longitude;
  // lon is in (-360, 360) and the box lies in (-360, 540) (a margin of 180 or more returned above),
  // so the equivalent copy can be at most two revolutions up: -355 lands in 170..370 only as 365.
  return [lon, lon + 360, lon - 360, lon + 720].some(l => l >= lo && l <= hi);
}

/** Primary area of use (the first current usage in the registry) of an EPSG code. */
export async function getEpsgAreaOfUse(code: string | number): Promise<EpsgAreaOfUse | undefined> {
  return (await getEpsgAreasOfUse(code))?.[0];
}

/** Every distinct current area-of-use box of an EPSG code (usages with identical boxes are stored once); most CRSs have one. */
export async function getEpsgAreasOfUse(code: string | number): Promise<EpsgAreaOfUse[] | undefined> {
  const data = await loadExtentsData();
  const row = rowOf(data, codeKey(code));
  if (!row || row[1].length === 0) return undefined;
  return row[1].map(index => toAreaOfUse(data.boxes[index]));
}

/**
 * Native units of an EPSG code, with the horizontal and vertical unit kept
 * apart (a vertical CRS has no horizontal unit; a compound CRS reports its
 * horizontal component's and its vertical component's).
 */
export async function getEpsgUnits(code: string | number): Promise<EpsgUnits | undefined> {
  const [data, byCode] = await Promise.all([loadExtentsData(), loadEpsgIndexByCode()]);
  return unitsOf(data, byCode, codeKey(code));
}

function unitAt(data: ExtentsData, index: number | undefined): EpsgUnit | undefined {
  if (index === undefined || index < 0) return undefined;
  const [name, metres] = data.units[index];
  return { name, metres: metres ?? undefined };
}

function unitsOf(
  data: ExtentsData,
  byCode: ReadonlyMap<string, EpsgIndexEntry>,
  key: string,
): EpsgUnits | undefined {
  const row = rowOf(data, key);
  if (!row) return undefined;
  const result: EpsgUnits = {};
  if (byCode.get(key)?.kind === 'Vertical') {
    // The only axis of a vertical CRS is its height axis.
    const vertical = unitAt(data, row[0]);
    if (vertical) result.vertical = vertical;
  } else {
    const horizontal = unitAt(data, row[0]);
    if (horizontal) result.horizontal = horizontal;
    const verticalRow = row[3] != null ? data.rows[String(row[3])] : undefined;
    const vertical = unitAt(data, verticalRow?.[0]);
    if (vertical) result.vertical = vertical;
  }
  return result.horizontal || result.vertical ? result : undefined;
}

/** Horizontal and vertical component codes of a compound CRS. */
export async function getEpsgCompoundComponents(
  code: string | number,
): Promise<EpsgCompoundComponents | undefined> {
  const data = await loadExtentsData();
  const row = rowOf(data, codeKey(code));
  const horizontal = row?.[2];
  const vertical = row?.[3];
  if (horizontal == null || vertical == null) return undefined;
  return { horizontal: String(horizontal), vertical: String(vertical) };
}

/**
 * Whether a WGS84 lon/lat lies in the area of use of an EPSG code (any of its
 * current usages), widened by `marginDegrees`. `undefined` when the code has no
 * known area of use, so callers can skip the check instead of guessing. A negative
 * or non-finite margin throws a `RangeError` even for an unknown code.
 */
export async function isLonLatInEpsgAreaOfUse(
  code: string | number,
  longitude: number,
  latitude: number,
  marginDegrees = 0,
): Promise<boolean | undefined> {
  // Validate the margin first: an invalid margin must not read as "unknown CRS".
  if (!Number.isFinite(marginDegrees) || marginDegrees < 0) {
    throw new RangeError(`marginDegrees must be a finite number >= 0, got ${marginDegrees}`);
  }
  const areas = await getEpsgAreasOfUse(code);
  if (!areas) return undefined;
  return areas.some(area => isLonLatInAreaOfUse(area, longitude, latitude, marginDegrees));
}

/**
 * Area of use as the catalogue publishes it. `west > east` when the box crosses
 * the antimeridian, and `crossesAntimeridian` says so. **Do not test membership
 * with `lon >= west && lon <= east`**: that is wrong for every box with
 * `crossesAntimeridian: true`. Call `contains` instead.
 */
export interface EpsgCatalogAreaOfUse {
  west: number;
  south: number;
  east: number;
  north: number;
  /** `true` when `west > east`: the box covers `west..180` and `-180..east`. */
  crossesAntimeridian: boolean;
  /**
   * Whether a WGS84 lon/lat lies in this box widened by `marginDegrees` (default 0),
   * wrap-aware. Same rules as `isLonLatInAreaOfUse`: non-finite input and
   * `|lat| > 90` are outside, a negative margin throws a `RangeError`.
   */
  contains(longitude: number, latitude: number, marginDegrees?: number): boolean;
}

/** One CRS as `EpsgCrsCatalog.lookup` returns it. */
export interface EpsgCatalogEntry {
  /** Always a number. */
  code: number;
  /** The EPSG name of the CRS, from the index. */
  name?: string;
  kind?: EpsgCrsKind;
  /**
   * Bounding hull of every current usage of the CRS (for a single-usage CRS,
   * that usage's box). It can be wider than the union of the boxes; use
   * `isLonLatInEpsgAreaOfUse` for the exact union.
   */
  areaOfUse?: EpsgCatalogAreaOfUse;
  /**
   * Metres per unit of the CRS's own horizontal axes. Absent for angular CRSs,
   * for vertical-only CRSs, and for the `(bin)` unit (no metre factor).
   */
  unitScale?: number;
  /** Metres per unit of the vertical axis, for vertical and compound CRSs where EPSG gives a length unit. */
  verticalUnitScale?: number;
}

/**
 * Structurally a `CrsCatalog` as georeference checks consume it
 * (`lookup(code) -> { code, kind?, areaOfUse?, unitScale? }`, `resolveName?`),
 * declared here so this package needs no dependency on the checker.
 */
export interface EpsgCrsCatalog {
  /** `undefined` for an unknown code and for anything that is not a number. */
  lookup(code: number): EpsgCatalogEntry | undefined;
  /**
   * `"CH1903+ / LV95"` -> `2056`; also `EPSG:2056`, `EPSG::2056`, `EPSG 2056`,
   * `urn:ogc:def:crs:EPSG::2056` and bare codes. `undefined` if unknown or
   * ambiguous. Single-word aliases (`Israel`, `Madrid`, `LV95`) are not resolved.
   */
  resolveName(name: string): number | undefined;
}

const KIND_MAP: Record<string, EpsgCrsKind> = {
  Projected: 'projected',
  Geographic: 'geographic',
  Compound: 'compound',
  Vertical: 'vertical',
};

function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `EPSG:2056`, `EPSG::2056`, `EPSG 2056`, `urn:ogc:def:crs:EPSG::2056`,
 * `urn:ogc:def:crs:EPSG:9.9.1:2056` and a bare `2056`.
 */
const CODE_FORM = /^(?:urn:ogc:def:crs:)?epsg(?:\s*:\s*[0-9.]*\s*:\s*|\s*:\s*|\s+)(\d+)$|^(\d+)$/i;

/** Bounding hull of every box. Throws if one crosses the antimeridian (the data has no such CRS today). */
function hullOf(boxes: Array<[number, number, number, number]>, code: string): [number, number, number, number] {
  if (boxes.length === 1) return boxes[0];
  if (boxes.some(([west, , east]) => west > east)) {
    throw new Error(`EPSG:${code}: several usages and one crosses the antimeridian; no single hull is defined`);
  }
  return [
    Math.min(...boxes.map(b => b[0])),
    Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])),
    Math.max(...boxes.map(b => b[3])),
  ];
}

function catalogArea([west, south, east, north]: [number, number, number, number]): EpsgCatalogAreaOfUse {
  const area = { west, south, east, north };
  return {
    ...area,
    crossesAntimeridian: west > east,
    contains: (longitude, latitude, marginDegrees = 0) =>
      isLonLatInAreaOfUse(area, longitude, latitude, marginDegrees),
  };
}

/**
 * Load the index and extents and return a synchronous catalog over them.
 * Lookup order for names mirrors how the index treats them: an exact
 * (case- and whitespace-insensitive) CRS name beats an alias, a current entry
 * beats a deprecated one, and two equally good candidates resolve to nothing.
 * An alias of one word is never used: it is too likely to name a place or a
 * datum rather than one CRS, and a wrong resolution is worse than none.
 */
export async function createEpsgCrsCatalog(): Promise<EpsgCrsCatalog> {
  const [entries, byCode, data] = await Promise.all([
    loadEpsgIndex(),
    loadEpsgIndexByCode(),
    loadExtentsData(),
  ]);

  // rank: 0 current name, 1 current alias, 2 deprecated name, 3 deprecated alias
  const names = new Map<string, { rank: number; codes: Set<string> }>();
  const addName = (key: string, entry: EpsgIndexEntry, alias: boolean): void => {
    if (!key) return;
    const rank = (entry.deprecated ? 2 : 0) + (alias ? 1 : 0);
    const slot = names.get(key);
    if (!slot || rank < slot.rank) names.set(key, { rank, codes: new Set([entry.code]) });
    else if (rank === slot.rank) slot.codes.add(entry.code);
  };
  for (const entry of entries) {
    addName(normalizeName(entry.name), entry, false);
    for (const alias of entry.aliases) {
      if (/\s/.test(alias.trim())) addName(normalizeName(alias), entry, true);
    }
  }

  return {
    lookup(code) {
      if (typeof code !== 'number' || !Number.isInteger(code)) return undefined;
      const key = String(code);
      const entry = byCode.get(key);
      if (!entry) return undefined;
      const row = data.rows[key];
      const result: EpsgCatalogEntry = { code, name: entry.name, kind: KIND_MAP[entry.kind] ?? 'other' };
      if (row && row[1].length > 0) {
        result.areaOfUse = catalogArea(hullOf(row[1].map(index => data.boxes[index]), key));
      }
      const units = unitsOf(data, byCode, key);
      if (units?.horizontal?.metres !== undefined) result.unitScale = units.horizontal.metres;
      if (units?.vertical?.metres !== undefined) result.verticalUnitScale = units.vertical.metres;
      return result;
    },
    resolveName(name) {
      const text = name.trim();
      const form = CODE_FORM.exec(text);
      if (form) {
        const digits = form[1] ?? form[2];
        return byCode.has(digits) ? Number(digits) : undefined;
      }
      const slot = names.get(normalizeName(text));
      if (!slot || slot.codes.size !== 1) return undefined;
      return Number([...slot.codes][0]);
    },
  };
}
