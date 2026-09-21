/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function isGeographicProj4(definition: string): boolean {
  return /\+proj=longlat\b/.test(definition);
}

export function utmProj4String(zone: string): string | null {
  const match = zone.match(/^(\d{1,2})([NS])$/i);
  if (!match) return null;
  const zoneNumber = parseInt(match[1], 10);
  if (zoneNumber < 1 || zoneNumber > 60) return null;
  return `+proj=utm +zone=${zoneNumber}${match[2].toUpperCase() === 'N' ? '' : ' +south'} +datum=WGS84 +units=m +no_defs`;
}
