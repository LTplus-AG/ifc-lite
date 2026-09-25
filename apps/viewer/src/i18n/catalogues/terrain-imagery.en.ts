/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** #5942: imagery draped on a LandXML terrain (mapping spec §15). */
export const terrainImageryEn = {
  'terrainImagery.heading': 'Terrain Imagery',
  'terrainImagery.none': 'No imagery draped. Drop a GeoTIFF, or a PNG/JPEG with its world file and .prj, onto the viewer to drape it on this terrain.',
  'terrainImagery.source': 'Source',
  'terrainImagery.sourceTiles': '{name} (map tiles: viewer only, never exported)',
  'terrainImagery.crs': 'Image CRS',
  'terrainImagery.crsReprojected': '{image}, reprojected to {terrain}',
  'terrainImagery.gsd': 'Ground sample distance',
  'terrainImagery.gsdValue': '{gsd} {unit} per pixel (as displayed)',
  'terrainImagery.covered': 'Covered',
  'terrainImagery.coveredValue': '{percent} % ({covered} of {total} vertices)',
  'terrainImagery.tiles.viewerOnly': 'Map tiles are draped in the viewer only; they are never written to an export.',
  'terrainImagery.tiles.kind': 'Service',
  'terrainImagery.tiles.kindXyz': 'XYZ tiles',
  'terrainImagery.tiles.kindWms': 'WMS',
  'terrainImagery.tiles.template': 'Tile URL template ({z}/{x}/{y})',
  'terrainImagery.tiles.templatePlaceholder': 'https://tile.example.org/{z}/{x}/{y}.png',
  'terrainImagery.tiles.wmsUrl': 'WMS endpoint',
  'terrainImagery.tiles.wmsPlaceholder': 'https://wms.example.org/service',
  'terrainImagery.tiles.zoom': 'Zoom',
  'terrainImagery.tiles.layers': 'Layers',
  'terrainImagery.tiles.resolution': 'Ground distance per pixel',
  'terrainImagery.tiles.drape': 'Drape tiles',
  'terrainImagery.tiles.fetching': 'Fetching…',
  'terrainImagery.tiles.refused': 'Tiles not draped: {reason}',
} as const satisfies Record<string, TranslationValue>;
