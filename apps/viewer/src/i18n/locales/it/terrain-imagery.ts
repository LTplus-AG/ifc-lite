/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const terrainImageryIt = {
  "terrainImagery.heading": "Immagini del terreno",
  "terrainImagery.none": "Nessuna immagine applicata. Rilascia nel visualizzatore un GeoTIFF, oppure un PNG/JPEG con il relativo world file e .prj, per applicarlo a questo terreno.",
  "terrainImagery.source": "Origine",
  "terrainImagery.sourceTiles": "{name} (tessere cartografiche: solo nel visualizzatore, mai esportate)",
  "terrainImagery.crs": "CRS dell'immagine",
  "terrainImagery.crsReprojected": "{image}, riproiettato in {terrain}",
  "terrainImagery.gsd": "Distanza di campionamento al suolo",
  "terrainImagery.gsdValue": "{gsd} {unit} per pixel (come visualizzato)",
  "terrainImagery.covered": "Copertura",
  "terrainImagery.coveredValue": "{percent} % ({covered} di {total} vertici)",
  "terrainImagery.tiles.viewerOnly": "Le tessere cartografiche vengono applicate solo nel visualizzatore; non vengono mai scritte in un'esportazione.",
  "terrainImagery.tiles.kind": "Servizio",
  "terrainImagery.tiles.kindXyz": "Tessere XYZ",
  "terrainImagery.tiles.kindWms": "WMS",
  "terrainImagery.tiles.template": "Modello URL delle tessere ({z}/{x}/{y})",
  "terrainImagery.tiles.templatePlaceholder": "https://tile.example.org/{z}/{x}/{y}.png",
  "terrainImagery.tiles.wmsUrl": "Endpoint WMS",
  "terrainImagery.tiles.wmsPlaceholder": "https://wms.example.org/service",
  "terrainImagery.tiles.zoom": "Zoom",
  "terrainImagery.tiles.layers": "Livelli",
  "terrainImagery.tiles.resolution": "Distanza al suolo per pixel",
  "terrainImagery.tiles.drape": "Applica tessere al terreno",
  "terrainImagery.tiles.fetching": "Recupero…",
  "terrainImagery.tiles.refused": "Tessere non applicate: {reason}"
} satisfies Catalogue;
