/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Datum-shift fallbacks for definitions whose canonical datum operation is a
 * grid file proj4js cannot read. Each result says which fallback it took, so
 * the caller holds that verdict together with the definition.
 */

import { reportCrsDiagnostic } from './diagnostics.js';
import type { ResolvedDefinition } from './engine-state.js';

// Diagnostics are reported once per code or datum per process.
const approxDatumWarningCache = new Set<string>();
// Track datums where the bundled proj4 lacked any datum-shift parameters and we
// couldn't supply a fallback — surfaced via diagnostics, warned once per datum.
const unknownDatumWarningCache = new Set<string>();

/**
 * Datum-keyed +towgs84 approximations for CRSs whose canonical definition
 * relies on browser-unavailable grid files (NTv2, NADCON, etc.). Each entry
 * is the published Bursa-Wolf 7-parameter set for that specific datum, in
 * the Position Vector convention proj4 expects, with rotations in arc-seconds.
 *
 * Keys are lowercased datum names as they appear in EpsgIndexEntry.datum. A
 * lookup miss is intentional — it forces sanitizeProj4 to emit a diagnostic
 * rather than silently substitute parameters for the wrong region (an earlier
 * version of this table was keyed by ellipsoid alone, which caused every
 * Bessel-1841 CRS — RD/NL, Hermannskogel/AT, S-JTSK/CZ — to inherit Germany's
 * DHDN shift). Accuracy is typically ~1-5 m, sufficient for map display.
 */
const DATUM_TOWGS84: Record<string, string> = {
  // United Kingdom — OSGB36 (Airy 1830). The bundled EPSG index (packages/data)
  // reports this datum as the bare "OSGB36" for EPSG:27700 — keep both forms
  // keyed since IFC files and EPSG metadata are inconsistent about which one
  // they emit.
  'osgb 1936': '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',
  'osgb36': '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',
  // North America — NAD27 (Clarke 1866)
  'north american datum 1927': '+towgs84=-8,160,176,0,0,0,0',
  'nad27': '+towgs84=-8,160,176,0,0,0,0',
  // NAD83 ≈ WGS84 to within ~1 m; identity is the standard browser approximation.
  'north american datum 1983': '+towgs84=0,0,0,0,0,0,0',
  'nad83': '+towgs84=0,0,0,0,0,0,0',
  // Germany — DHDN (Bessel 1841)
  'deutsches hauptdreiecksnetz': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',
  'dhdn': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',
  // Netherlands — Amersfoort (Bessel 1841). The bundled EPSG:28992 already
  // ships with the higher-precision Kadaster +towgs84, so this fires only
  // when a derived/compound CRS lacks it (e.g. some compound RD/NAP cases).
  // The compound EPSG:7415 (RD + NAP height) reports its datum as "RD" rather
  // than "Amersfoort", and its bundled proj4 carries no +towgs84 at all, so it
  // needs the same shift under that key for the offline (no precision-grid)
  // fallback to land in the Netherlands instead of ~117 m off.
  'amersfoort': '+towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725',
  'rd': '+towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725',
  // Austria — MGI (Bessel 1841)
  'militar-geographische institut': '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
  'mgi': '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
  // Czech Republic — S-JTSK (Bessel 1841). EPSG:2065 (Ferro Krovak) — the
  // exact code #1357 was filed against, and the only S-JTSK code with no
  // precision-grid coverage (see precision-grids.ts) so this fallback is its
  // ONLY datum shift — reports its datum as "S-JTSK (Ferro)" in the bundled
  // EPSG index, not the bare "S-JTSK" below. Without this key the lookup
  // silently missed (no warning either, since there's no +nadgrids to trigger
  // one) and EPSG:2065 got zero datum shift.
  'system of the unified trigonometrical cadastral network': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  's-jtsk': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  's-jtsk (ferro)': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  // New Zealand — NZGD49 (International 1924)
  'new zealand geodetic datum 1949': '+towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993',
  'nzgd49': '+towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993',
  // Australia — AGD84 (Australian National Spheroid)
  'australian geodetic datum 1984': '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191',
  'agd84': '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191',
};

/**
 * Strip +nadgrids=... from a proj4 string and add a +towgs84 approximation
 * keyed by the datum name from the bundled EPSG index. Grid files cannot be
 * loaded in the browser; +towgs84 is the standard fallback.
 *
 * Skipped (returns input verbatim) when:
 *   - No +nadgrids reference (or it's the no-op `@null`)
 *   - A +towgs84 is already present (proj4 will honour it)
 *
 * `datumShift` is `helmert-approximation` when a 7-parameter shift stands in
 * for a grid (or for a shift the definition omits), `grid-unavailable` when a
 * required grid was dropped with nothing to replace it.
 */
export function sanitizeProj4(def: string, code?: string | null, datumName?: string | null): ResolvedDefinition {
  const stripNadgrids = (s: string) => s.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim();
  const hasNadgrids = def.includes('+nadgrids') && !def.includes('+nadgrids=@null');
  const hasTowgs84 = /\+towgs84=/.test(def);

  // An embedded Helmert is an explicit approximation only when it replaces a
  // required grid.  The old code stripped the grid and then represented this
  // result as an ordinary definition, allowing federation to claim exact CRS
  // placement while silently losing metres of accuracy.
  if (hasTowgs84) {
    return hasNadgrids
      ? { definition: stripNadgrids(def), datumShift: 'helmert-approximation' }
      : { definition: def, datumShift: 'as-defined' };
  }

  const datumKey = datumName?.trim().toLowerCase() ?? '';
  const towgs84 = datumKey ? DATUM_TOWGS84[datumKey] : undefined;

  if (!towgs84) {
    // No known fallback shift. For a grid-referencing def, warn + strip the
    // unusable reference. For a plain def we leave it untouched (its datum may
    // already be WGS84-aligned, or simply unknown to us).
    if (hasNadgrids && datumKey && !unknownDatumWarningCache.has(datumKey)) {
      unknownDatumWarningCache.add(datumKey);
      reportCrsDiagnostic(
        `[reproject] EPSG:${code ?? '?'} ("${datumName}") needs browser-unavailable `
        + 'datum grids and has no known +towgs84 fallback for its datum. '
        + 'Positions will be aligned to the source CRS but may be tens of metres '
        + 'off relative to WGS84/basemaps. Consider adding the datum to '
        + 'DATUM_TOWGS84 in packages/geo/src/sanitize-proj4.ts.',
      );
    }
    return hasNadgrids
      ? { definition: stripNadgrids(def), datumShift: 'grid-unavailable' }
      : { definition: def, datumShift: 'as-defined' };
  }

  // We have a +towgs84 for this datum and the def carries none. Apply it. This
  // covers a +nadgrids grid we can't load (strip + approximate) AND a bundled
  // def that simply omits the shift for an offset datum — e.g. Ferro Krovak
  // (EPSG:2065) / S-JTSK, where without it proj4 performs no datum shift at
  // all and the model lands hundreds of metres off the basemap. (#1357)
  if (code && !approxDatumWarningCache.has(code)) {
    approxDatumWarningCache.add(code);
    reportCrsDiagnostic(
      `[reproject] EPSG:${code} ("${datumName}") uses an approximate +towgs84 `
      + 'datum shift (browser-unavailable precision grid). '
      + 'Expect metre-level XY differences for some locations.',
    );
  }

  return {
    definition: `${hasNadgrids ? stripNadgrids(def) : def.replace(/\s+/g, ' ').trim()} ${towgs84}`,
    datumShift: 'helmert-approximation',
  };
}
