/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const terrainImageryFr = {
  "terrainImagery.heading": "Imagerie du terrain",
  "terrainImagery.none": "Aucune image appliquée. Déposez un GeoTIFF, ou un PNG/JPEG avec son fichier de géoréférencement et son .prj, sur la visionneuse pour l’appliquer à ce terrain.",
  "terrainImagery.source": "Source",
  "terrainImagery.sourceTiles": "{name} (tuiles cartographiques : visionneuse uniquement, jamais exportées)",
  "terrainImagery.crs": "Système de coordonnées de l’image",
  "terrainImagery.crsReprojected": "{image}, reprojeté vers {terrain}",
  "terrainImagery.gsd": "Résolution au sol",
  "terrainImagery.gsdValue": "{gsd} {unit} par pixel (à l’affichage)",
  "terrainImagery.covered": "Couverture",
  "terrainImagery.coveredValue": "{percent} % ({covered} sommets sur {total})",
  "terrainImagery.tiles.viewerOnly": "Les tuiles cartographiques sont appliquées uniquement dans la visionneuse ; elles ne sont jamais écrites dans un export.",
  "terrainImagery.tiles.kind": "Service",
  "terrainImagery.tiles.kindXyz": "Tuiles XYZ",
  "terrainImagery.tiles.kindWms": "WMS",
  "terrainImagery.tiles.template": "Modèle d’URL des tuiles ({z}/{x}/{y})",
  "terrainImagery.tiles.templatePlaceholder": "https://tile.example.org/{z}/{x}/{y}.png",
  "terrainImagery.tiles.wmsUrl": "Point de terminaison WMS",
  "terrainImagery.tiles.wmsPlaceholder": "https://wms.example.org/service",
  "terrainImagery.tiles.zoom": "Zoom",
  "terrainImagery.tiles.layers": "Couches",
  "terrainImagery.tiles.resolution": "Distance au sol par pixel",
  "terrainImagery.tiles.drape": "Appliquer les tuiles",
  "terrainImagery.tiles.fetching": "Récupération…",
  "terrainImagery.tiles.refused": "Tuiles non appliquées : {reason}",
} satisfies Catalogue;
