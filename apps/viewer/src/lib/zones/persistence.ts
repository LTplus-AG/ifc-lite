/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Versioned JSON persistence for zone sets (issue #1810 v1). Zones live in
 * viewer state, not the IFC model, so this is the ONLY durability story for
 * them: export/import a small JSON file. Pure + DOM-free (no `downloadFile`/
 * `File` here) so it's testable under `node:test`; the store slice wires
 * this into the browser download/file-picker flow.
 */

import { ZONE_SET_FILE_VERSION, type Zone, type ZoneSet, type ZoneSetFile } from './types.js';

export type ParseZoneSetFileResult =
  | { ok: true; zoneSets: ZoneSet[] }
  | { ok: false; error: string };

function copyVec3(v: readonly [number, number, number]): [number, number, number] {
  return [v[0], v[1], v[2]];
}

/** Build the on-disk file shape from live zone sets. Pure — no clock/DOM
 *  side effect except reading `Date.now()` for the informational timestamp.
 *  The vector tuples are deep-copied too: a shallow spread would leave
 *  `center`/`size`/`color` aliased to live Zustand state, so a caller
 *  mutating the serialized result would mutate the store outside an action
 *  (PR #1869 review). */
export function serializeZoneSets(zoneSets: readonly ZoneSet[]): ZoneSetFile {
  return {
    version: ZONE_SET_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    zoneSets: zoneSets.map((zs) => ({
      ...zs,
      zones: zs.zones.map((z) => ({
        ...z,
        center: copyVec3(z.center),
        size: copyVec3(z.size),
        ...(z.color !== undefined ? { color: copyVec3(z.color) } : {}),
      })),
    })),
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

function isValidZone(v: unknown): v is Zone {
  if (!v || typeof v !== 'object') return false;
  const z = v as Record<string, unknown>;
  if (typeof z.id !== 'string' || z.id.length === 0) return false;
  if (typeof z.name !== 'string') return false;
  if (!isVec3(z.center)) return false;
  if (!isVec3(z.size)) return false;
  if (!isFiniteNumber(z.rotationY)) return false;
  if (z.size[0] < 0 || z.size[1] < 0 || z.size[2] < 0) return false;
  if (z.color !== undefined && !isVec3(z.color)) return false;
  return true;
}

function isValidZoneSet(v: unknown): v is ZoneSet {
  if (!v || typeof v !== 'object') return false;
  const zs = v as Record<string, unknown>;
  return (
    typeof zs.id === 'string' && zs.id.length > 0 &&
    typeof zs.name === 'string' &&
    Array.isArray(zs.zones) && zs.zones.every(isValidZone) &&
    typeof zs.visible === 'boolean' &&
    isFiniteNumber(zs.createdAt) &&
    isFiniteNumber(zs.updatedAt)
  );
}

/**
 * Parse a previously-exported zone-set file. Rejects anything that isn't
 * the recognised versioned shape rather than guessing — a corrupted or
 * hand-edited file should fail loudly, not silently drop zones.
 */
export function parseZoneSetFile(json: unknown): ParseZoneSetFileResult {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Not a zone-set file (expected a JSON object).' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.version !== ZONE_SET_FILE_VERSION) {
    return {
      ok: false,
      error: `Unsupported zone-set file version ${String(obj.version)} (expected ${ZONE_SET_FILE_VERSION}).`,
    };
  }
  if (!Array.isArray(obj.zoneSets) || !obj.zoneSets.every(isValidZoneSet)) {
    return { ok: false, error: 'Malformed zone-set file: `zoneSets` is missing or invalid.' };
  }
  const zoneSets = obj.zoneSets as ZoneSet[];
  // Ids must be unique (set ids globally, zone ids within their set): the
  // store actions (`removeZoneSet`/`renameZoneSet`/`updateZone`/`removeZone`)
  // address by id, so importing duplicates would make a single edit silently
  // affect multiple entries (PR #1869 review).
  const setIds = new Set<string>();
  for (const zs of zoneSets) {
    if (setIds.has(zs.id)) {
      return { ok: false, error: `Malformed zone-set file: duplicate zone-set id "${zs.id}".` };
    }
    setIds.add(zs.id);
    const zoneIds = new Set<string>();
    for (const zone of zs.zones) {
      if (zoneIds.has(zone.id)) {
        return { ok: false, error: `Malformed zone-set file: duplicate zone id "${zone.id}" in set "${zs.name}".` };
      }
      zoneIds.add(zone.id);
    }
  }
  return { ok: true, zoneSets };
}
