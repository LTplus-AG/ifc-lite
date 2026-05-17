/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Precision datum-shift grids for CRSs where 7-parameter Helmert
 * (`+towgs84`) gives unacceptable error (≥ ~1 m).
 *
 * Browser proj4js can't read NTv2 `.gsb` files directly, but it CAN consume
 * GeoTIFF datum-shift grids published by PROJ at cdn.proj.org. We fetch the
 * grid on first use of a covered CRS, parse with geotiff.js, register via
 * `proj4.nadgrid(key, adapter)`, then call `proj4.defs(...)` with a string
 * that references `+nadgrids={key}`. proj4js resolves the reference and
 * does the datum-shift via the loaded grid — sub-decimeter accuracy.
 *
 * Without the grid (network blocked, fetch failed, CRS not in our list),
 * proj4js falls back to the `+towgs84` baked into the bundled definition,
 * which is the ~1–120 m approximation we had before.
 *
 * Filenames are taken verbatim from the OSGeo/PROJ-data repository (the
 * upstream that publishes to cdn.proj.org). Pattern lifted from
 * bedrock-engineer/ifc-gref under Apache-2.0.
 */

import proj4 from 'proj4';

export interface PrecisionGridSpec {
  /** Key proj4 references via `+nadgrids={key}` (typically the filename). */
  key: string;
  /** Filename under cdn.proj.org/ */
  filename: string;
  /** Full proj4 string with `+nadgrids` instead of `+towgs84` */
  proj4: string;
  /** Human-readable name for diagnostics */
  region: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function gridSpec(filename: string, projection: string, region: string): PrecisionGridSpec {
  return {
    key: filename,
    filename,
    proj4: `${projection} +nadgrids=${filename} +units=m +no_defs +type=crs`,
    region,
  };
}

/** Build a UTM proj4 string ready to receive a `+nadgrids=` suffix. */
function utm(zone: number, south: boolean, ellps: string): string {
  return `+proj=utm +zone=${zone}${south ? ' +south' : ''} +ellps=${ellps}`;
}

// ── Grid filenames (single source of truth) ────────────────────────────────

const GRIDS = {
  rdtrans2018: 'nl_nsgi_rdtrans2018.tif',       // Netherlands RD → ETRS89
  ostn15:      'uk_os_OSTN15_NTv2_OSGBtoETRS.tif', // UK OSGB36 → ETRS89
  bd72:        'be_ign_bd72lb72_etrs89lb08.tif',   // Belgium BD72 → ETRS89
  beta2007:    'de_adv_BETA2007.tif',              // Germany DHDN → ETRS89
  atGisGrid:   'at_bev_AT_GIS_GRID.tif',           // Austria MGI → ETRS89
  ntfR93:      'fr_ign_ntf_r93.tif',               // France NTF → RGF93
  chENyx06:    'ch_swisstopo_CHENyx06_ETRS.tif',   // Switzerland CH1903 → ETRS89
  sjtskCR2005: 'cz_cuzk_CR-2005.tif',              // Czechia S-JTSK → ETRS89
  sjtsk03:     'sk_gku_JTSK03_to_JTSK.tif',        // Slovakia JTSK03 → JTSK
  sped2etv2:   'es_ign_SPED2ETV2.tif',             // Spain ED50 → ETRS89
  d73Etrs89:   'pt_dgt_D73_ETRS89_geo.tif',        // Portugal D73 → ETRS89
  dlxEtrs89:   'pt_dgt_DLx_ETRS89_geo.tif',        // Portugal Lisbon → ETRS89
  sad69:       'br_ibge_SAD69_003.tif',            // Brazil SAD69 → SIRGAS2000
  sad96:       'br_ibge_SAD96_003.tif',            // Brazil SAD96 → SIRGAS2000
  agd66:       'au_icsm_A66_National_13_09_01.tif',// Australia AGD66 → GDA94
  agd84:       'au_icsm_National_84_02_07_01.tif', // Australia AGD84 → GDA94
  gda94To2020: 'au_icsm_GDA94_GDA2020_conformal.tif', // Australia GDA94 → GDA2020
  nzgd49:      'nz_linz_nzgd2kgrid0005.tif',       // NZ NZGD49 → NZGD2000
  ntv2Can:     'ca_nrc_ntv2_0.tif',                // Canada NAD27 → NAD83
  nadcon5Conus:'us_noaa_nadcon5_nad27_nad83_1986_conus.tif', // US NAD27 → NAD83 (continental)
  nadcon5Alaska:'us_noaa_nadcon5_nad27_nad83_1986_alaska.tif', // US NAD27 → NAD83 (Alaska)
  nadcon5Hawaii:'us_noaa_nadcon5_nad83_1986_nad83_1993_hawaii.tif', // US Hawaii datum chain
  nadcon5Prvi: 'us_noaa_nadcon5_nad83_1986_nad83_1993_prvi.tif', // Puerto Rico / USVI
} as const;

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
 * zones, etc.) — their bundled +towgs84 already gives sub-decimeter
 * accuracy and a grid would be redundant.
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

  // Czech Republic — S-JTSK / Krovak via CR-2005 (ČÚZK). +towgs84 off ~1–2 m.
  // 5514 is East-North orientation; 2065 is the older South-West Krovak.
  '5514': gridSpec(
    GRIDS.sjtskCR2005,
    '+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 '
    + '+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel',
    'Czech Republic (S-JTSK Krovak EN)',
  ),
  '2065': gridSpec(
    GRIDS.sjtskCR2005,
    '+proj=krovak +axis=swu +lat_0=49.5 +lon_0=24.8333333333333 '
    + '+alpha=30.2881397527778 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel',
    'Czech Republic (S-JTSK Krovak SW)',
  ),

  // Slovakia — S-JTSK03 → S-JTSK (ÚGKK). Same projection as Czech.
  '5513': gridSpec(
    GRIDS.sjtsk03,
    '+proj=krovak +axis=swu +lat_0=49.5 +lon_0=24.8333333333333 '
    + '+alpha=30.2881397527778 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel',
    'Slovakia (S-JTSK Krovak SW)',
  ),

  // Spain — ED50 / UTM zones via SPED2ETV2 (IGN). +towgs84 off ~1–2 m.
  '23029': gridSpec(GRIDS.sped2etv2, utm(29, false, 'intl'), 'Spain (ED50 / UTM 29N)'),
  '23030': gridSpec(GRIDS.sped2etv2, utm(30, false, 'intl'), 'Spain (ED50 / UTM 30N)'),
  '23031': gridSpec(GRIDS.sped2etv2, utm(31, false, 'intl'), 'Spain (ED50 / UTM 31N)'),

  // Portugal — Datum 73 / TM06 via DGT grid. +towgs84 off ~1–3 m.
  '27493': gridSpec(
    GRIDS.d73Etrs89,
    '+proj=tmerc +lat_0=39.6677777777778 +lon_0=-8.13190611111111 +k=1 +x_0=180.598 +y_0=-86.99 +ellps=intl',
    'Portugal (Datum 73 / Modified Portuguese Grid)',
  ),
  '3763': gridSpec(
    GRIDS.dlxEtrs89,
    '+proj=tmerc +lat_0=39.6682583333333 +lon_0=-8.13310833333333 +k=1 +x_0=0 +y_0=0 +ellps=GRS80',
    'Portugal (ETRS89 / Portugal TM06)',
  ),

  // ────────────────────────────────────────────────────────────────────────
  // NORTH AMERICA
  // ────────────────────────────────────────────────────────────────────────

  // USA — NAD27 / UTM zones 10N–19N via NADCON5 CONUS (NOAA).
  // +towgs84 typically off by 5–50 m depending on region.
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

  // Canada NAD27 / UTM zones via NTv2_0 (NRC). +towgs84 off ~1–5 m.
  '2007': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=7 +ellps=clrk66', 'Canada (NAD27 / UTM 7N, CSRS-style)'),
  '32007': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=7 +ellps=clrk66', 'Canada (NAD27 / UTM 7N)'),
  '32008': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=8 +ellps=clrk66', 'Canada (NAD27 / UTM 8N)'),
  '32009': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=9 +ellps=clrk66', 'Canada (NAD27 / UTM 9N)'),
  '32010': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=10 +ellps=clrk66', 'Canada (NAD27 / UTM 10N)'),
  '32011': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=11 +ellps=clrk66', 'Canada (NAD27 / UTM 11N)'),
  '32012': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=12 +ellps=clrk66', 'Canada (NAD27 / UTM 12N)'),
  '32013': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=13 +ellps=clrk66', 'Canada (NAD27 / UTM 13N)'),
  '32014': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=14 +ellps=clrk66', 'Canada (NAD27 / UTM 14N)'),
  '32015': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=15 +ellps=clrk66', 'Canada (NAD27 / UTM 15N)'),
  '32016': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=16 +ellps=clrk66', 'Canada (NAD27 / UTM 16N)'),
  '32017': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=17 +ellps=clrk66', 'Canada (NAD27 / UTM 17N)'),
  '32018': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=18 +ellps=clrk66', 'Canada (NAD27 / UTM 18N)'),
  '32019': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=19 +ellps=clrk66', 'Canada (NAD27 / UTM 19N)'),
  '32020': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=20 +ellps=clrk66', 'Canada (NAD27 / UTM 20N)'),
  '32021': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=21 +ellps=clrk66', 'Canada (NAD27 / UTM 21N)'),
  '32022': gridSpec(GRIDS.ntv2Can, '+proj=utm +zone=22 +ellps=clrk66', 'Canada (NAD27 / UTM 22N)'),

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

// ── Grid loader ────────────────────────────────────────────────────────────

const CDN_BASE = 'https://cdn.proj.org';

const loadedGrids = new Set<string>();
const inflightGrids = new Map<string, Promise<boolean>>();
const failedGrids = new Set<string>();

/**
 * Load a GeoTIFF datum-shift grid into proj4js. Idempotent: subsequent
 * calls for the same key resolve immediately. Concurrent calls dedup.
 * Returns `true` on success, `false` on any failure (caller decides
 * whether to fall back to a `+towgs84`-based proj4 string).
 */
export async function loadPrecisionGrid(spec: PrecisionGridSpec): Promise<boolean> {
  if (loadedGrids.has(spec.key)) return true;
  if (failedGrids.has(spec.key)) return false;
  const pending = inflightGrids.get(spec.key);
  if (pending) return pending;

  const promise = (async (): Promise<boolean> => {
    try {
      const url = `${CDN_BASE}/${spec.filename}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[precision-grid] ${spec.key}: fetch failed (HTTP ${response.status})`);
        return false;
      }
      const buffer = await response.arrayBuffer();
      const { fromArrayBuffer } = await import('geotiff');
      const tiff = await fromArrayBuffer(buffer);

      // proj4js's GeoTIFF nadgrid path expects an older API shape.
      // Bridge to geotiff.js v3 via a Proxy. Adapter borrowed from
      // bedrock-engineer/ifc-gref under Apache-2.0.
      const adapter = {
        getImageCount: () => tiff.getImageCount(),
        getImage: async (index: number) => {
          const img = await tiff.getImage(index);
          const [scaleX = 0, scaleY = 0] = img.getResolution();
          return new Proxy(img, {
            get(target, property) {
              if (property === 'fileDirectory') {
                return {
                  ModelPixelScale: [Math.abs(scaleX), Math.abs(scaleY), 0],
                };
              }
              const value = (target as unknown as Record<string | symbol, unknown>)[
                property as string
              ];
              return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
            },
          });
        },
      };

      // proj4js types lag the actual adapter shape; cast at the boundary.
      const grid = (proj4 as unknown as {
        nadgrid: (key: string, source: unknown) => { ready?: Promise<unknown> } | undefined;
      }).nadgrid(spec.key, adapter);
      const ready = grid?.ready;
      if (ready && typeof ready.then === 'function') {
        await ready;
      }
      loadedGrids.add(spec.key);
      console.info(`[precision-grid] loaded ${spec.key} (${spec.region})`);
      return true;
    } catch (error) {
      console.warn(`[precision-grid] ${spec.key}: load failed, falling back to +towgs84`, error);
      failedGrids.add(spec.key);
      return false;
    }
  })();

  inflightGrids.set(spec.key, promise);
  promise.finally(() => inflightGrids.delete(spec.key));
  return promise;
}

/**
 * If `epsgCode` has a registered precision grid, load it and return the
 * grid-using proj4 definition. Returns `null` when the code isn't in our
 * curated list — caller should fall back to the bundled `+towgs84` def.
 */
export async function resolvePrecisionDef(epsgCode: string): Promise<string | null> {
  const spec = PRECISION_GRIDS[epsgCode];
  if (!spec) return null;
  const loaded = await loadPrecisionGrid(spec);
  if (!loaded) return null;
  return spec.proj4;
}

/**
 * Diagnostic — has the grid for this code been loaded successfully?
 * Surfaces in the GeoreferencingPanel so users know they're getting
 * the grid-accurate transform vs. the +towgs84 fallback.
 */
export function hasLoadedPrecisionGrid(epsgCode: string): boolean {
  const spec = PRECISION_GRIDS[epsgCode];
  return spec ? loadedGrids.has(spec.key) : false;
}

/**
 * Diagnostic — did the grid load fail (so the badge can stop spinning
 * and show an error state instead of perpetually "loading")?
 */
export function hasFailedPrecisionGrid(epsgCode: string): boolean {
  const spec = PRECISION_GRIDS[epsgCode];
  return spec ? failedGrids.has(spec.key) : false;
}
