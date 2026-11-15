/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which EPSG codes have a precision datum-shift grid, and the proj4
 * definition that uses it. Loading is `precision-grids.ts`.
 */

import { GRIDS, type GridMetadata } from './precision-grid-data.js';

export interface PrecisionGridSpec {
  /** Key proj4 references via `+nadgrids={key}` (typically the filename). */
  key: string;
  /** Filename under cdn.proj.org/ */
  filename: string;
  /** Full proj4 string with `+nadgrids` instead of `+towgs84` */
  proj4: string;
  /** EPSG datum names compatible with the upstream grid source CRS. */
  sourceDatums: readonly string[];
  /** Human-readable name for diagnostics */
  region: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function gridSpec(grid: GridMetadata, projection: string, region: string): PrecisionGridSpec {
  const { filename, sourceDatums } = grid;
  return {
    key: filename,
    filename,
    sourceDatums,
    proj4: `${projection} +nadgrids=${filename} +units=m +no_defs +type=crs`,
    region,
  };
}

/** Build a UTM proj4 string ready to receive a `+nadgrids=` suffix. */
function utm(zone: number, south: boolean, ellps: string): string {
  return `+proj=utm +zone=${zone}${south ? ' +south' : ''} +ellps=${ellps}`;
}

// ── Coverage table ─────────────────────────────────────────────────────────

/**
 * EPSG code → grid spec. Order is irrelevant; loaded lazily on first use.
 *
 * Curated to cover every region where `+towgs84` Helmert is ≥ 1 m off and
 * the upstream PROJ project publishes a precision grid. Adding a new
 * entry: pick the EPSG code, find the canonical grid filename in
 * github.com/OSGeo/PROJ-data, write the proj4 string with `+nadgrids=<file>`
 * (replace any existing `+towgs84`).
 *
 * NOT included: ETRS89/WGS84/NAD83-aligned systems (Swiss LV95 2056, French
 * Lambert-93 2154, all WGS84 UTM zones, Web Mercator 3857, ETRS89 UTM
 * zones, etc.) — these do not require a legacy-datum grid. ETRS89, NAD83 and other
 * regional reference frames are approximated as WGS84 here; this is not an
 * epoch-aware, sub-decimeter transformation to modern WGS84 realizations.
 */
export const PRECISION_GRIDS: Record<string, PrecisionGridSpec> = {
  // ────────────────────────────────────────────────────────────────────────
  // EUROPE
  // ────────────────────────────────────────────────────────────────────────

  // Netherlands — RDNAPTRANS™2018 (Kadaster canonical). +towgs84 off ~117 m.
  '28992': gridSpec(
    GRIDS.rdtrans2018,
    '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 '
    + '+k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel',
    'Netherlands (RDNAPTRANS™2018)',
  ),
  // RD + NAP compound — same horizontal grid.
  '7415': gridSpec(
    GRIDS.rdtrans2018,
    '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 '
    + '+k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel',
    'Netherlands (RD + NAP compound)',
  ),

  // United Kingdom — OSTN15. +towgs84 off ~1–20 m (worst in Scotland).
  '27700': gridSpec(
    GRIDS.ostn15,
    '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy',
    'United Kingdom (OSTN15)',
  ),

  // Belgium — BD72 → ETRS89 (IGN/NGI). +towgs84 off ~2–5 m.
  '31370': gridSpec(
    GRIDS.bd72,
    '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 '
    + '+lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl',
    'Belgium (BD72 → ETRS89)',
  ),

  // Germany — DHDN Gauss-Krüger zones 2-5 via BeTA2007 (AdV).
  // +towgs84 off ~1–3 m. Same grid for all four zones.
  '31466': gridSpec(GRIDS.beta2007, '+proj=tmerc +lat_0=0 +lon_0=6 +k=1 +x_0=2500000 +y_0=0 +ellps=bessel',  'Germany (DHDN GK zone 2)'),
  '31467': gridSpec(GRIDS.beta2007, '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel',  'Germany (DHDN GK zone 3)'),
  '31468': gridSpec(GRIDS.beta2007, '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel', 'Germany (DHDN GK zone 4)'),
  '31469': gridSpec(GRIDS.beta2007, '+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=5500000 +y_0=0 +ellps=bessel', 'Germany (DHDN GK zone 5)'),

  // Austria — MGI / Austria Lambert via AT_GIS_GRID (BEV). +towgs84 off ~1–3 m.
  '31287': gridSpec(
    GRIDS.atGisGrid,
    '+proj=lcc +lat_0=47.5 +lon_0=13.3333333333333 +lat_1=49 +lat_2=46 '
    + '+x_0=400000 +y_0=400000 +ellps=bessel',
    'Austria (MGI Lambert → ETRS89)',
  ),
  // Austria GK zones — same grid.
  '31254': gridSpec(GRIDS.atGisGrid, '+proj=tmerc +lat_0=0 +lon_0=10.3333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel', 'Austria (MGI GK M28)'),
  '31255': gridSpec(GRIDS.atGisGrid, '+proj=tmerc +lat_0=0 +lon_0=13.3333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel', 'Austria (MGI GK M31)'),
  '31256': gridSpec(GRIDS.atGisGrid, '+proj=tmerc +lat_0=0 +lon_0=16.3333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel', 'Austria (MGI GK M34)'),

  // France — NTF Lambert (legacy zones I-IV) via NTF→RGF93 (IGN). +towgs84 off ~1–3 m.
  '27561': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=49.5 +lat_0=49.5 +lon_0=0 +k_0=0.99987734 +x_0=600000 +y_0=200000 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert I carto)'),
  '27562': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=200000 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert II carto)'),
  '27563': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=44.1 +lat_0=44.1 +lon_0=0 +k_0=0.99987750 +x_0=600000 +y_0=200000 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert III carto)'),
  '27564': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=42.165 +lat_0=42.165 +lon_0=0 +k_0=0.99994471 +x_0=234.358 +y_0=185861.369 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert IV carto)'),
  '27571': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=49.5 +lat_0=49.5 +lon_0=0 +k_0=0.99987734 +x_0=600000 +y_0=1200000 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert I)'),
  '27572': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert II étendu)'),
  '27573': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=44.1 +lat_0=44.1 +lon_0=0 +k_0=0.99987750 +x_0=600000 +y_0=3200000 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert III)'),
  '27574': gridSpec(GRIDS.ntfR93, '+proj=lcc +lat_1=42.165 +lat_0=42.165 +lon_0=0 +k_0=0.99994471 +x_0=234.358 +y_0=4185861.369 +a=6378249.2 +b=6356515 +pm=paris', 'France (NTF Lambert IV)'),

  // Switzerland — CH1903 / LV03 via CHENyx06 (swisstopo). +towgs84 off ~0.5–1 m.
  // (LV95 / EPSG:2056 is already aligned to ETRS89; no grid needed there.)
  '21781': gridSpec(
    GRIDS.chENyx06,
    '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 '
    + '+k_0=1 +x_0=600000 +y_0=200000 +ellps=bessel',
    'Switzerland (CH1903 LV03 → ETRS89)',
  ),

  // Czech Republic — S-JTSK / Krovak (EPSG:5514 EN, 2065 SW): NO precision grid.
  // The only Czech file PROJ publishes that we could reference, cz_cuzk_CR-2005.tif,
  // is a VERTICAL_OFFSET grid (ETRS89 → Baltic 1957 height) — a single-band height
  // model, NOT a horizontal datum shift. Pointing `+nadgrids` at it crashes proj4's
  // 2-band horizontal grid reader (`data[1]` undefined), so the load always failed
  // and surfaced a spurious "grid failed" badge. The only Czech HORIZONTAL_OFFSET
  // grid (cz_cuzk_table_-y-x_3_v1710.tif) is S-JTSK → S-JTSK/05, not → ETRS89, so
  // there is no single-grid S-JTSK → ETRS89 path proj4js can consume. We therefore
  // rely on the bundled `+towgs84` (~1 m), which is correct for these CRSs. (#1357)

  // S-JTSK (including EPSG:5513) is also excluded: JTSK03_to_JTSK
  // starts in S-JTSK [JTSK03] and ends in S-JTSK, not ETRS89/WGS84.
  // A horizontal raster alone is insufficient to make it a WGS84 shift. (#7052)

  // Spain — ED50 / UTM zones via SPED2ETV2 (IGN). +towgs84 off ~1–2 m.
  '23029': gridSpec(GRIDS.sped2etv2, utm(29, false, 'intl'), 'Spain (ED50 / UTM 29N)'),
  '23030': gridSpec(GRIDS.sped2etv2, utm(30, false, 'intl'), 'Spain (ED50 / UTM 30N)'),
  '23031': gridSpec(GRIDS.sped2etv2, utm(31, false, 'intl'), 'Spain (ED50 / UTM 31N)'),

  // Portugal — Datum 73 / Modified Portuguese Grid via DGT grid. +towgs84 off ~1–3 m.
  '27493': gridSpec(
    GRIDS.d73Etrs89,
    '+proj=tmerc +lat_0=39.6666666666667 +lon_0=-8.13190611111111 +k=1 +x_0=180.598 +y_0=-86.99 +ellps=intl',
    'Portugal (Datum 73 / Modified Portuguese Grid)',
  ),
  // EPSG:3763 already uses ETRS89. The Lisbon → ETRS89 grid applies
  // to Lisbon-based CRSs only and must never shift TM06 coordinates. (#7052)

  // ────────────────────────────────────────────────────────────────────────
  // NORTH AMERICA
  // ────────────────────────────────────────────────────────────────────────

  // USA — NAD27 / UTM zones 10N–19N via NADCON5 CONUS (NOAA).
  // +towgs84 typically off by 5–50 m depending on region.
  // This grid ends in NAD83 (1986), approximated as WGS84 like the other
  // regional target frames above; it is not an epoch-aware NAD83 → WGS84 chain.
  '26710': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=10 +ellps=clrk66', 'USA (NAD27 / UTM 10N)'),
  '26711': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=11 +ellps=clrk66', 'USA (NAD27 / UTM 11N)'),
  '26712': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=12 +ellps=clrk66', 'USA (NAD27 / UTM 12N)'),
  '26713': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=13 +ellps=clrk66', 'USA (NAD27 / UTM 13N)'),
  '26714': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=14 +ellps=clrk66', 'USA (NAD27 / UTM 14N)'),
  '26715': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=15 +ellps=clrk66', 'USA (NAD27 / UTM 15N)'),
  '26716': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=16 +ellps=clrk66', 'USA (NAD27 / UTM 16N)'),
  '26717': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=17 +ellps=clrk66', 'USA (NAD27 / UTM 17N)'),
  '26718': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=18 +ellps=clrk66', 'USA (NAD27 / UTM 18N)'),
  '26719': gridSpec(GRIDS.nadcon5Conus, '+proj=utm +zone=19 +ellps=clrk66', 'USA (NAD27 / UTM 19N)'),

  // Alaska NAD27 / UTM zones 3N–9N.
  '26703': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=3 +ellps=clrk66', 'USA (NAD27 / UTM 3N, Alaska)'),
  '26704': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=4 +ellps=clrk66', 'USA (NAD27 / UTM 4N, Alaska)'),
  '26705': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=5 +ellps=clrk66', 'USA (NAD27 / UTM 5N, Alaska)'),
  '26706': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=6 +ellps=clrk66', 'USA (NAD27 / UTM 6N, Alaska)'),
  '26707': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=7 +ellps=clrk66', 'USA (NAD27 / UTM 7N, Alaska)'),
  '26708': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=8 +ellps=clrk66', 'USA (NAD27 / UTM 8N, Alaska)'),
  '26709': gridSpec(GRIDS.nadcon5Alaska, '+proj=utm +zone=9 +ellps=clrk66', 'USA (NAD27 / UTM 9N, Alaska)'),

  // Do not assign Canada's NTv2 grid to guessed EPSG codes: 2007 is
  // St. Vincent 45, and 32007–32022 are US NAD27 State Plane CRSs (US feet),
  // not Canadian UTM zones. Their bundled projections remain authoritative.
  // NAD27 UTM zone codes are 267xx, shared across national borders. (#7052)

  // ────────────────────────────────────────────────────────────────────────
  // OCEANIA
  // ────────────────────────────────────────────────────────────────────────

  // Australia AGD66 / AMG zones 48-58 via A66 grid (ICSM). +towgs84 off ~5 m.
  '20248': gridSpec(GRIDS.agd66, '+proj=utm +zone=48 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 48)'),
  '20249': gridSpec(GRIDS.agd66, '+proj=utm +zone=49 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 49)'),
  '20250': gridSpec(GRIDS.agd66, '+proj=utm +zone=50 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 50)'),
  '20251': gridSpec(GRIDS.agd66, '+proj=utm +zone=51 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 51)'),
  '20252': gridSpec(GRIDS.agd66, '+proj=utm +zone=52 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 52)'),
  '20253': gridSpec(GRIDS.agd66, '+proj=utm +zone=53 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 53)'),
  '20254': gridSpec(GRIDS.agd66, '+proj=utm +zone=54 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 54)'),
  '20255': gridSpec(GRIDS.agd66, '+proj=utm +zone=55 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 55)'),
  '20256': gridSpec(GRIDS.agd66, '+proj=utm +zone=56 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 56)'),
  '20257': gridSpec(GRIDS.agd66, '+proj=utm +zone=57 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 57)'),
  '20258': gridSpec(GRIDS.agd66, '+proj=utm +zone=58 +south +ellps=aust_SA', 'Australia (AGD66 / AMG 58)'),

  // Australia AGD84 / AMG zones 48-58 via 84 grid (ICSM). +towgs84 off ~1–3 m.
  '20348': gridSpec(GRIDS.agd84, '+proj=utm +zone=48 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 48)'),
  '20349': gridSpec(GRIDS.agd84, '+proj=utm +zone=49 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 49)'),
  '20350': gridSpec(GRIDS.agd84, '+proj=utm +zone=50 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 50)'),
  '20351': gridSpec(GRIDS.agd84, '+proj=utm +zone=51 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 51)'),
  '20352': gridSpec(GRIDS.agd84, '+proj=utm +zone=52 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 52)'),
  '20353': gridSpec(GRIDS.agd84, '+proj=utm +zone=53 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 53)'),
  '20354': gridSpec(GRIDS.agd84, '+proj=utm +zone=54 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 54)'),
  '20355': gridSpec(GRIDS.agd84, '+proj=utm +zone=55 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 55)'),
  '20356': gridSpec(GRIDS.agd84, '+proj=utm +zone=56 +south +ellps=aust_SA', 'Australia (AGD84 / AMG 56)'),

  // New Zealand — NZGD49 / NZMG (LINZ). Legacy projection still used for old data.
  '27200': gridSpec(
    GRIDS.nzgd49,
    '+proj=nzmg +lat_0=-41 +lon_0=173 +x_0=2510000 +y_0=6023150 +ellps=intl',
    'New Zealand (NZGD49 / NZMG)',
  ),

  // ────────────────────────────────────────────────────────────────────────
  // SOUTH AMERICA
  // ────────────────────────────────────────────────────────────────────────

  // Brazil SAD69 / UTM zones via SAD69_003 (IBGE). +towgs84 off ~5–10 m.
  '29101': gridSpec(GRIDS.sad69, '+proj=poly +lat_0=0 +lon_0=-54 +x_0=5000000 +y_0=10000000 +ellps=aust_SA', 'Brazil (SAD69 / Polyconic)'),
  '29168': gridSpec(GRIDS.sad69, '+proj=utm +zone=18 +ellps=aust_SA', 'Brazil (SAD69 / UTM 18N)'),
  '29169': gridSpec(GRIDS.sad69, '+proj=utm +zone=19 +ellps=aust_SA', 'Brazil (SAD69 / UTM 19N)'),
  '29170': gridSpec(GRIDS.sad69, '+proj=utm +zone=20 +ellps=aust_SA', 'Brazil (SAD69 / UTM 20N)'),
  '29171': gridSpec(GRIDS.sad69, '+proj=utm +zone=21 +ellps=aust_SA', 'Brazil (SAD69 / UTM 21N)'),
  '29172': gridSpec(GRIDS.sad69, '+proj=utm +zone=22 +ellps=aust_SA', 'Brazil (SAD69 / UTM 22N)'),
  '29187': gridSpec(GRIDS.sad69, '+proj=utm +zone=17 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 17S)'),
  '29188': gridSpec(GRIDS.sad69, '+proj=utm +zone=18 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 18S)'),
  '29189': gridSpec(GRIDS.sad69, '+proj=utm +zone=19 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 19S)'),
  '29190': gridSpec(GRIDS.sad69, '+proj=utm +zone=20 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 20S)'),
  '29191': gridSpec(GRIDS.sad69, '+proj=utm +zone=21 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 21S)'),
  '29192': gridSpec(GRIDS.sad69, '+proj=utm +zone=22 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 22S)'),
  '29193': gridSpec(GRIDS.sad69, '+proj=utm +zone=23 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 23S)'),
  '29194': gridSpec(GRIDS.sad69, '+proj=utm +zone=24 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 24S)'),
  '29195': gridSpec(GRIDS.sad69, '+proj=utm +zone=25 +south +ellps=aust_SA', 'Brazil (SAD69 / UTM 25S)'),
};
