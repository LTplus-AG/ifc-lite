/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Place search for the Location panel, via OpenStreetMap's Nominatim.
 *
 * Split out of LocationMap.tsx, which was past the ~400-line rule. It swallows
 * every failure by design — a geocoder that is down, rate-limiting, or offline
 * must leave the panel usable rather than surface an error over a map the user
 * can still pan — and that "always resolves, never throws" contract is the
 * part worth testing, since a thrown promise here would take the panel with it.
 */

/** One Nominatim hit, normalised to numbers. */
export interface GeocodeResult {
  lat: number;
  lon: number;
  display_name: string;
}

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';

/** Geocode a query string. Resolves to [] on any failure — never rejects. */
export async function geocodeSearch(query: string): Promise<GeocodeResult[]> {
  if (!query.trim()) return [];
  try {
    const q = encodeURIComponent(query.trim());
    const resp = await fetch(
      `${NOMINATIM_SEARCH}?format=json&limit=5&q=${q}`,
      { headers: { 'Accept-Language': 'en' } },
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map((r: { lat: string; lon: string; display_name: string }) => ({
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      display_name: r.display_name,
    }));
  } catch {
    return [];
  }
}
