/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Descriptors for imagery, basemap and hazard layers: enough for a renderer
 * to request tiles itself. Nothing here fetches imagery.
 *
 * Checked against the live capabilities documents on 2026-11-15:
 * https://wmts.geo.admin.ch/EPSG/2056/1.0.0/WMTSCapabilities.xml (resource
 * URL templates and tile matrix sets) and
 * https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities
 * (layer names; a GetMap of the overland-flow layer in EPSG:2056 answered
 * 200 image/png). Attribution text follows api3's `layersConfig`.
 */

import { attributionFor, type DatasetId } from './attribution.js';
import type { MapLayerDescriptor, MapServiceDescriptor } from './contracts.js';

export const WMTS_CAPABILITIES_2056 = 'https://wmts.geo.admin.ch/EPSG/2056/1.0.0/WMTSCapabilities.xml';
export const WMS_BASE = 'https://wms.geo.admin.ch/';
export const WMS_CAPABILITIES = `${WMS_BASE}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;

/** Four of the CRSs every wms.geo.admin.ch layer advertised in the 2026-11-15 capabilities. */
const WMS_CRS = ['EPSG:2056', 'EPSG:21781', 'EPSG:4326', 'EPSG:3857'];

function wmts(layer: string, format: 'jpeg' | 'png', tileMatrixSet: string): MapServiceDescriptor {
  return {
    type: 'WMTS',
    urlTemplate: `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/2056/{TileMatrix}/{TileCol}/{TileRow}.${format}`,
    tileMatrixSet,
    crs: 'EPSG:2056',
    format: `image/${format}`,
    capabilitiesUrl: WMTS_CAPABILITIES_2056,
  };
}

function wms(layer: string, format: 'image/jpeg' | 'image/png'): MapServiceDescriptor {
  return { type: 'WMS', url: WMS_BASE, version: '1.3.0', layers: layer, crs: WMS_CRS, format, capabilitiesUrl: WMS_CAPABILITIES };
}

function layer(
  id: string,
  title: string,
  kind: MapLayerDescriptor['kind'],
  dataset: DatasetId,
  services: MapServiceDescriptor[],
): MapLayerDescriptor {
  return { id, title, kind, services, attribution: attributionFor(dataset) };
}

export const MAP_LAYERS: readonly MapLayerDescriptor[] = [
  layer('ch.swisstopo.swissimage', 'SWISSIMAGE orthophoto', 'imagery', 'swissimage', [
    wmts('ch.swisstopo.swissimage', 'jpeg', '2056_28'),
    wms('ch.swisstopo.swissimage', 'image/jpeg'),
  ]),
  layer('ch.swisstopo.pixelkarte-farbe', 'National map (colour)', 'basemap', 'pixelkarte', [
    wmts('ch.swisstopo.pixelkarte-farbe', 'jpeg', '2056_27'),
  ]),
  layer('ch.swisstopo.swissalti3d-reliefschattierung', 'swissALTI3D hillshade', 'basemap', 'relief', [
    wmts('ch.swisstopo.swissalti3d-reliefschattierung', 'png', '2056_26'),
  ]),
  layer('ch.bafu.gefaehrdungskarte-oberflaechenabfluss', 'Overland flow hazard map', 'hazard', 'surfaceRunoff', [
    wmts('ch.bafu.gefaehrdungskarte-oberflaechenabfluss', 'png', '2056_27'),
    wms('ch.bafu.gefaehrdungskarte-oberflaechenabfluss', 'image/png'),
  ]),
];

export function mapLayer(id: string): MapLayerDescriptor | undefined {
  return MAP_LAYERS.find((l) => l.id === id);
}
