/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const terrainImageryDe = {
  'terrainImagery.heading': 'Geländebilder',
  'terrainImagery.none': 'Kein Bild aufgelegt. Ziehen Sie ein GeoTIFF oder ein PNG/JPEG mit World-File und .prj in den Viewer, um es auf dieses Gelände zu legen.',
  'terrainImagery.source': 'Quelle',
  'terrainImagery.sourceTiles': '{name} (Kartenkacheln: nur im Viewer, werden nie exportiert)',
  'terrainImagery.crs': 'Bild-KBS',
  'terrainImagery.crsReprojected': '{image}, umprojiziert nach {terrain}',
  'terrainImagery.gsd': 'Bodenauflösung',
  'terrainImagery.gsdValue': '{gsd} {unit} pro Pixel (wie angezeigt)',
  'terrainImagery.covered': 'Abgedeckt',
  'terrainImagery.coveredValue': '{percent} % ({covered} von {total} Eckpunkten)',
  'terrainImagery.tiles.viewerOnly': 'Kartenkacheln werden nur im Viewer aufgelegt; sie werden nie in einen Export geschrieben.',
  'terrainImagery.tiles.kind': 'Dienst',
  'terrainImagery.tiles.kindXyz': 'XYZ-Kacheln',
  'terrainImagery.tiles.kindWms': 'WMS',
  'terrainImagery.tiles.template': 'Kachel-URL-Vorlage ({z}/{x}/{y})',
  'terrainImagery.tiles.templatePlaceholder': 'https://tile.example.org/{z}/{x}/{y}.png',
  'terrainImagery.tiles.wmsUrl': 'WMS-Endpunkt',
  'terrainImagery.tiles.wmsPlaceholder': 'https://wms.example.org/service',
  'terrainImagery.tiles.zoom': 'Zoomstufe',
  'terrainImagery.tiles.layers': 'Ebenen',
  'terrainImagery.tiles.resolution': 'Bodenabstand pro Pixel',
  'terrainImagery.tiles.drape': 'Kacheln auflegen',
  'terrainImagery.tiles.fetching': 'Wird abgerufen …',
  'terrainImagery.tiles.refused': 'Kacheln nicht aufgelegt: {reason}',
} satisfies Catalogue;
