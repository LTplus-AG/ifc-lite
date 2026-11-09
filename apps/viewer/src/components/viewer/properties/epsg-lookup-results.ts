/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { lookupEpsgByCode, type EpsgIndexEntry } from '@ifc-lite/data';

export interface EpsgResult {
  code: string;
  name: string;
  area: string;
  unit: string;
  kind?: string;
  datum?: string;
  projection?: string;
}

const RECENT_EPSG_STORAGE_KEY = 'ifc-lite:recent-epsg-codes';
const MAX_RECENT_CODES = 6;
export const MAX_STARTER_RESULTS = 8;

const GLOBAL_DEFAULT_CODES = [
  '4326',
  '3857',
  '32632',
  '32633',
  '27700',
  '2154',
  '28992',
  '2263',
];

const REGIONAL_CODES: Record<string, string[]> = {
  AU: ['7855', '28355'],
  AT: ['31255', '31256', '31257'],
  BE: ['31370'],
  CH: ['2056', '21781'],
  DE: ['25832', '25833', '5555'],
  FR: ['2154'],
  GB: ['27700'],
  HK: ['2326'],
  IT: ['6706'],
  JP: ['3092', '3093', '3094', '3095'],
  NL: ['28992', '7415'],
  NZ: ['2193'],
  SE: ['3006'],
  SG: ['3414'],
  US: ['2263', '2227', '26917', '6339'],
};

const TIMEZONE_REGION_CODES: Array<{ prefix: string; region: string }> = [
  { prefix: 'Europe/Zurich', region: 'CH' },
  { prefix: 'Europe/Berlin', region: 'DE' },
  { prefix: 'Europe/Vienna', region: 'AT' },
  { prefix: 'Europe/London', region: 'GB' },
  { prefix: 'Europe/Paris', region: 'FR' },
  { prefix: 'Europe/Amsterdam', region: 'NL' },
  { prefix: 'Europe/Brussels', region: 'BE' },
  { prefix: 'Europe/Rome', region: 'IT' },
  { prefix: 'Europe/Stockholm', region: 'SE' },
  { prefix: 'America/New_York', region: 'US' },
  { prefix: 'America/Los_Angeles', region: 'US' },
  { prefix: 'America/Chicago', region: 'US' },
  { prefix: 'America/Denver', region: 'US' },
  { prefix: 'Asia/Tokyo', region: 'JP' },
  { prefix: 'Asia/Hong_Kong', region: 'HK' },
  { prefix: 'Asia/Singapore', region: 'SG' },
  { prefix: 'Australia/', region: 'AU' },
  { prefix: 'Pacific/Auckland', region: 'NZ' },
];

export function toDialogResult(entry: EpsgIndexEntry): EpsgResult {
  return {
    code: entry.code,
    name: entry.name,
    area: entry.area,
    unit: entry.unit,
    kind: entry.kind,
    datum: entry.datum || undefined,
    projection: entry.projection || undefined,
  };
}

// ── Bundled offline fallback (common BIM/GIS codes) ────────────────────

export const COMMON_CRS: EpsgResult[] = [
  { code: '4326', name: 'WGS 84', area: 'World', unit: 'degree', kind: 'Geographic', datum: 'WGS84' },
  { code: '3857', name: 'WGS 84 / Pseudo-Mercator', area: 'World', unit: 'metre', kind: 'Projected', datum: 'WGS84' },
  { code: '4258', name: 'ETRS89', area: 'Europe', unit: 'degree', kind: 'Geographic', datum: 'ETRS89' },
  { code: '25832', name: 'ETRS89 / UTM zone 32N', area: 'Europe 6°-12°E', unit: 'metre', kind: 'Projected', datum: 'ETRS89' },
  { code: '25833', name: 'ETRS89 / UTM zone 33N', area: 'Europe 12°-18°E', unit: 'metre', kind: 'Projected', datum: 'ETRS89' },
  { code: '27700', name: 'OSGB 1936 / British National Grid', area: 'United Kingdom', unit: 'metre', kind: 'Projected', datum: 'OSGB 1936' },
  { code: '2154', name: 'RGF93 v1 / Lambert-93', area: 'France', unit: 'metre', kind: 'Projected', datum: 'RGF93 v1' },
  { code: '28992', name: 'Amersfoort / RD New', area: 'Netherlands', unit: 'metre', kind: 'Projected', datum: 'Amersfoort' },
  { code: '2263', name: 'NAD83 / New York Long Island (ftUS)', area: 'USA - New York - SPCS - Long Island', unit: 'US survey foot', kind: 'Projected', datum: 'NAD83' },
  { code: '26917', name: 'NAD83 / UTM zone 17N', area: 'North America - 84°W to 78°W', unit: 'metre', kind: 'Projected', datum: 'NAD83' },
  { code: '32632', name: 'WGS 84 / UTM zone 32N', area: 'World 6°-12°E', unit: 'metre', kind: 'Projected', datum: 'WGS84' },
  { code: '32633', name: 'WGS 84 / UTM zone 33N', area: 'World 12°-18°E', unit: 'metre', kind: 'Projected', datum: 'WGS84' },
];

function readRecentCodes(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_EPSG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string').slice(0, MAX_RECENT_CODES);
  } catch {
    return [];
  }
}

export function writeRecentCode(code: string): void {
  if (typeof window === 'undefined') return;
  try {
    const deduped = [code, ...readRecentCodes().filter(existing => existing !== code)].slice(0, MAX_RECENT_CODES);
    window.localStorage.setItem(RECENT_EPSG_STORAGE_KEY, JSON.stringify(deduped));
  } catch {
    // Ignore storage failures.
  }
}

function getRegionHints(): string[] {
  if (typeof window === 'undefined') return [];

  const timeZoneHints: string[] = [];
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const languageHints = new Set<string>();

  for (const language of languages) {
    const parts = language.replace('_', '-').split('-');
    const region = parts[1]?.toUpperCase();
    if (region && region in REGIONAL_CODES) languageHints.add(region);
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const candidate of TIMEZONE_REGION_CODES) {
    if (timeZone.startsWith(candidate.prefix)) {
      timeZoneHints.push(candidate.region);
    }
  }

  const orderedTimeZoneHints = Array.from(new Set(timeZoneHints));
  if (orderedTimeZoneHints.length > 0) {
    return orderedTimeZoneHints;
  }

  return Array.from(languageHints);
}

export async function getStarterResults(): Promise<EpsgResult[]> {
  const recentCodes = readRecentCodes();
  const regionHints = getRegionHints();
  const candidateCodes = [
    ...recentCodes,
    ...regionHints.flatMap(region => REGIONAL_CODES[region] ?? []),
    ...GLOBAL_DEFAULT_CODES,
  ];

  const seen = new Set<string>();
  const dedupedCodes: string[] = [];

  for (const code of candidateCodes) {
    if (seen.has(code)) continue;
    seen.add(code);
    dedupedCodes.push(code);
    if (dedupedCodes.length >= MAX_STARTER_RESULTS) break;
  }

  const entries = await Promise.all(dedupedCodes.map(code => lookupEpsgByCode(code)));
  const results = entries
    .filter((entry): entry is EpsgIndexEntry => Boolean(entry))
    .map(entry => toDialogResult(entry));

  if (results.length > 0) {
    return results;
  }

  return COMMON_CRS.slice(0, MAX_STARTER_RESULTS);
}
