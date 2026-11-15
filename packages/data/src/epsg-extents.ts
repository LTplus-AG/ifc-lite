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

/** The CRS's native horizontal axis unit. */
export interface EpsgUnit {
  /** EPSG unit name, e.g. `metre`, `US survey foot`, `degree`. */
  name: string;
  /** Metres per unit for length units; `undefined` for angular units. */
  metres: number | undefined;
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

function toAreaOfUse([west, south, east, north]: [number, number, number, number]): EpsgAreaOfUse {
  return { west, south, east, north, crossesAntimeridian: west > east };
}

function codeKey(code: string | number): string {
  return String(code).trim();
}

/**
 * Whether a WGS84 longitude/latitude lies in an area of use, widened by
 * `marginDegrees` on every side. Antimeridian-aware: longitudes are compared
 * modulo 360, so `-179` is inside a box `170..-170`, and a margin never
 * wraps past a pole.
 */
export function isLonLatInAreaOfUse(
  area: Pick<EpsgAreaOfUse, 'west' | 'south' | 'east' | 'north'>,
  longitude: number,
  latitude: number,
  marginDegrees = 0,
): boolean {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  const margin = Math.max(0, marginDegrees);
  if (latitude < area.south - margin || latitude > area.north + margin) return false;
  const lo = area.west - margin;
  // A crossing box runs west..east+360; compare the longitude in each 360° copy
  // so no arithmetic touches values that are already exact in the data.
  const hi = (area.east >= area.west ? area.east : area.east + 360) + margin;
  if (hi - lo >= 360) return true;
  return [longitude, longitude + 360, longitude - 360].some(lon => lon >= lo && lon <= hi);
}

/** Primary area of use (the first current usage in the registry) of an EPSG code. */
export async function getEpsgAreaOfUse(code: string | number): Promise<EpsgAreaOfUse | undefined> {
  return (await getEpsgAreasOfUse(code))?.[0];
}

/** Every current area of use of an EPSG code; most CRSs have one. */
export async function getEpsgAreasOfUse(code: string | number): Promise<EpsgAreaOfUse[] | undefined> {
  const data = await loadExtentsData();
  const row = data.rows[codeKey(code)];
  if (!row || row[1].length === 0) return undefined;
  return row[1].map(index => toAreaOfUse(data.boxes[index]));
}

/** Native horizontal unit of an EPSG code (a compound CRS reports its horizontal component's). */
export async function getEpsgUnit(code: string | number): Promise<EpsgUnit | undefined> {
  const data = await loadExtentsData();
  const row = data.rows[codeKey(code)];
  if (!row || row[0] < 0) return undefined;
  const [name, metres] = data.units[row[0]];
  return { name, metres: metres ?? undefined };
}

/** Horizontal and vertical component codes of a compound CRS. */
export async function getEpsgCompoundComponents(
  code: string | number,
): Promise<EpsgCompoundComponents | undefined> {
  const data = await loadExtentsData();
  const row = data.rows[codeKey(code)];
  const horizontal = row?.[2];
  const vertical = row?.[3];
  if (horizontal == null || vertical == null) return undefined;
  return { horizontal: String(horizontal), vertical: String(vertical) };
}

/**
 * Whether a WGS84 lon/lat lies in the area of use of an EPSG code (any of its
 * current usages), widened by `marginDegrees`. `undefined` when the code has no
 * known area of use, so callers can skip the check instead of guessing.
 */
export async function isLonLatInEpsgAreaOfUse(
  code: string | number,
  longitude: number,
  latitude: number,
  marginDegrees = 0,
): Promise<boolean | undefined> {
  const areas = await getEpsgAreasOfUse(code);
  if (!areas) return undefined;
  return areas.some(area => isLonLatInAreaOfUse(area, longitude, latitude, marginDegrees));
}

/**
 * Structurally a `CrsCatalog` as georeference checks consume it
 * (`lookup(code) -> { code, kind?, areaOfUse?, unitScale? }`, `resolveName?`),
 * declared here so this package needs no dependency on the checker.
 */
export interface EpsgCrsCatalog {
  lookup(code: number): {
    code: number;
    kind?: EpsgCrsKind;
    areaOfUse?: { west: number; south: number; east: number; north: number };
    /** Metres per unit of the CRS's own horizontal axes; absent for angular CRSs. */
    unitScale?: number;
  } | undefined;
  /** `"CH1903+ / LV95"` -> `2056`; also `EPSG:2056` and bare codes. `undefined` if unknown or ambiguous. */
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
 * Load the index and extents and return a synchronous catalog over them.
 * Lookup order for names mirrors how the index treats them: an exact
 * (case- and whitespace-insensitive) CRS name beats an alias, a current entry
 * beats a deprecated one, and two equally good candidates resolve to nothing.
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
    for (const alias of entry.aliases) addName(normalizeName(alias), entry, true);
  }

  return {
    lookup(code) {
      const key = String(code);
      const entry = byCode.get(key);
      if (!entry) return undefined;
      const row = data.rows[key];
      const result: ReturnType<EpsgCrsCatalog['lookup']> = { code, kind: KIND_MAP[entry.kind] ?? 'other' };
      const box = row?.[1][0] !== undefined ? data.boxes[row[1][0]] : undefined;
      if (box) result!.areaOfUse = { west: box[0], south: box[1], east: box[2], north: box[3] };
      const metres = row && row[0] >= 0 ? data.units[row[0]][1] : null;
      if (metres != null) result!.unitScale = metres;
      return result;
    },
    resolveName(name) {
      const text = name.trim();
      const prefixed = /^epsg\s*:\s*(\d+)$/i.exec(text) ?? /^(\d+)$/.exec(text);
      if (prefixed) return byCode.has(prefixed[1]) ? Number(prefixed[1]) : undefined;
      const slot = names.get(normalizeName(text));
      if (!slot || slot.codes.size !== 1) return undefined;
      return Number([...slot.codes][0]);
    },
  };
}
