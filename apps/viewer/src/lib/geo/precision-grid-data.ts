/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source CRS names from PROJ's official grid catalogue:
 * https://cdn.proj.org/files.geojson (source_crs_name / target_crs_name).
 * The comments retain the audited target frames; their WGS84 approximation
 * is documented by precision-grids.ts.
 *
 * Accepted names use the bundled EPSG index's datum spelling. RD is the
 * horizontal component name exposed for the RD + NAP compound CRS; NTF
 * (Paris) differs from NTF only by prime meridian, handled by the projection.
 * Ellipsoid equality alone never establishes datum compatibility.
 */
export interface GridMetadata {
  readonly filename: string;
  readonly sourceDatums: readonly string[];
}

export const GRIDS = {
  // Amersfoort → ETRF2000
  rdtrans2018: { filename: 'nl_nsgi_rdtrans2018.tif', sourceDatums: ['Amersfoort', 'RD'] },
  // OSGB36 → ETRS89
  ostn15: { filename: 'uk_os_OSTN15_NTv2_OSGBtoETRS.tif', sourceDatums: ['OSGB36'] },
  // BD72 → ETRS89
  bd72: { filename: 'be_ign_bd72lb72_etrs89lb08.tif', sourceDatums: ['BD72'] },
  // DHDN → ETRS89
  beta2007: { filename: 'de_adv_BETA2007.tif', sourceDatums: ['DHDN'] },
  // MGI → ETRS89
  atGisGrid: { filename: 'at_bev_AT_GIS_GRID.tif', sourceDatums: ['MGI'] },
  // NTF → ETRS89-FRA [RGF93 v1]
  ntfR93: { filename: 'fr_ign_ntf_r93.tif', sourceDatums: ['NTF', 'NTF (Paris)'] },
  // CH1903 → ETRS89
  chENyx06: { filename: 'ch_swisstopo_CHENyx06_ETRS.tif', sourceDatums: ['CH1903'] },
  // ED50 → ETRS89
  sped2etv2: { filename: 'es_ign_SPED2ETV2.tif', sourceDatums: ['ED50'] },
  // Datum 73 → ETRS89
  d73Etrs89: { filename: 'pt_dgt_D73_ETRS89_geo.tif', sourceDatums: ['Datum 73'] },
  // SAD69 → SIRGAS 2000
  sad69: { filename: 'br_ibge_SAD69_003.tif', sourceDatums: ['SAD69'] },
  // AGD66 → GDA94
  agd66: { filename: 'au_icsm_A66_National_13_09_01.tif', sourceDatums: ['AGD66'] },
  // AGD84 → GDA94
  agd84: { filename: 'au_icsm_National_84_02_07_01.tif', sourceDatums: ['AGD84'] },
  // NZGD49 → NZGD2000
  nzgd49: { filename: 'nz_linz_nzgd2kgrid0005.tif', sourceDatums: ['NZGD49'] },
  // NAD27 → NAD83 (CONUS)
  nadcon5Conus: { filename: 'us_noaa_nadcon5_nad27_nad83_1986_conus.tif', sourceDatums: ['NAD27'] },
  // NAD27 → NAD83 (Alaska)
  nadcon5Alaska: { filename: 'us_noaa_nadcon5_nad27_nad83_1986_alaska.tif', sourceDatums: ['NAD27'] },
} as const satisfies Readonly<Record<string, GridMetadata>>;

/** EPSG-deprecated CRSs omitted by the bundled index, verified in PROJ 9.8.
 * Their independent projection controls are in precision-grids.test.ts.
 * Missing metadata for every other code must fail closed.
 */
export const DEPRECATED_SOURCE_DATUMS: Readonly<Record<string, string>> = {
  '20248': 'AGD66',
  '20348': 'AGD84',
};
