/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Terms of use and required attribution per dataset, as read on the date in
 * `termsVerifiedOn`. Sources are listed in the package README. The FSDI's
 * general terms (https://www.geo.admin.ch/en/general-terms-of-use-fsdi)
 * apply on top of every geo.admin.ch service: free of charge, fair use,
 * access may be restricted on excessive use, and bulk acquisition should use
 * the download service rather than scraping the web services.
 */

import type { Attribution } from './contracts.js';

const VERIFIED = '2026-11-15';

const SWISSTOPO_OGD = {
  licence: 'swisstopo OGD: open use, commercial use allowed, source reference mandatory',
  termsUrl: 'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices',
};

const SWISSIMAGE_PRODUCT_PAGE = 'https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10';

/** The OGD terms list datasets whose source line differs from "© swisstopo". */
const TERMS_NAME_OTHER_SOURCES =
  'The swisstopo terms name datasets that need a different source line than "© swisstopo"; the exact wording is in each dataset\'s documentation';

const FSDI_FAIR_USE =
  'FSDI fair use: access may be restricted on excessive use; obtain whole datasets via the download service, not by scraping web services';

function swisstopo(datasetId: string, extra: string[] = []): Attribution {
  return {
    datasetId,
    text: '© swisstopo',
    ...SWISSTOPO_OGD,
    restrictions: [FSDI_FAIR_USE, ...extra, TERMS_NAME_OTHER_SOURCES],
    termsVerifiedOn: VERIFIED,
  };
}

export const DATASETS = {
  /** Address/location search (SearchServer). Results come from the official address directory and others. */
  geocoding: swisstopo('geocoding'),
  swissalti3d: swisstopo('swissalti3d'),
  swissbuildings3d: swisstopo('swissbuildings3d', [
    'swissBUILDINGS3D 3.0 is published as "Beta" in the STAC catalogue',
  ]),
  swisstlm3d: swisstopo('swisstlm3d'),
  swissimage: {
    datasetId: 'swissimage',
    // The layer-level text from the api3 layer configuration, which the map viewer shows.
    text: '© CNES, Spot Image, swisstopo, NPOC',
    ...SWISSTOPO_OGD,
    restrictions: [
      FSDI_FAIR_USE,
      `This text is the layer-level attribution from the api3 layer configuration. The product page states the source line per vintage and is authoritative: ${SWISSIMAGE_PRODUCT_PAGE}`,
      TERMS_NAME_OTHER_SOURCES,
    ],
    termsVerifiedOn: VERIFIED,
  },
  pixelkarte: swisstopo('pixelkarte'),
  relief: swisstopo('relief'),
  cadastre: {
    datasetId: 'cadastre',
    text: '© Cadastral surveying (CS) and the cantons',
    licence: 'Cantonal data, published through CadastralWebMap; terms page could not be read',
    termsUrl: 'http://www.cadastre.ch/cwm',
    restrictions: [
      FSDI_FAIR_USE,
      'The data owners are the cantons. geocat.ch points to http://www.cadastre.ch/cwm for the terms, which returned HTTP 404 on 2026-11-15; check the canton\'s terms before redistributing parcel geometry',
    ],
    termsVerifiedOn: null,
  },
  gwr: {
    datasetId: 'gwr',
    text: '© FSO, Federal Register of Buildings and Dwellings (GWR)',
    licence: 'Opendata BY: open use, source reference mandatory',
    termsUrl: 'https://opendata.swiss/en/terms-of-use#terms_by',
    restrictions: [
      FSDI_FAIR_USE,
      'Only the attributes of access level A are public (Art. 16 VGWR, SR 431.841)',
    ],
    termsVerifiedOn: VERIFIED,
  },
  oerebAvailability: {
    datasetId: 'oerebAvailability',
    text: '© swisstopo',
    licence: 'No restriction stated ("Keine Einschränkung")',
    termsUrl: 'https://www.geocat.ch/geonetwork/srv/eng/catalog.search#/metadata/fb60594e-2b16-45af-9bc0-b444035070f5',
    restrictions: [FSDI_FAIR_USE],
    termsVerifiedOn: VERIFIED,
  },
  surfaceRunoff: {
    datasetId: 'surfaceRunoff',
    text: '© FOEN',
    licence: 'Opendata OPEN: open use',
    termsUrl: 'https://opendata.swiss/en/terms-of-use/#terms_open',
    restrictions: [FSDI_FAIR_USE],
    termsVerifiedOn: VERIFIED,
  },
} satisfies Record<string, Attribution>;

export type DatasetId = keyof typeof DATASETS;

/** The attribution a UI must show for data from `id`. */
export function attributionFor(id: DatasetId): Attribution {
  return DATASETS[id];
}
