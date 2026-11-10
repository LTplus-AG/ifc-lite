/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const landXmlGeorefAssumptionsIt = {
  "landXmlGeorefAssumptions.sharedVerticalDatum.label": "Presumi un sistema altimetrico condiviso",
  "landXmlGeorefAssumptions.sharedVerticalDatum.description": "Quando il file LandXML o il modello su cui viene posizionato non indica quale sistema altimetrico usano le sue quote, posiziona le quote così come sono scritte, come se entrambi usassero lo stesso sistema. Se non è così, la superficie risulta troppo alta o troppo bassa della differenza tra i due sistemi altimetrici.",
  "landXmlGeorefAssumptions.epsgFromName.label": "Leggi un codice EPSG dal nome del sistema di coordinate",
  "landXmlGeorefAssumptions.epsgFromName.description": "Quando il CoordinateSystem LandXML non indica un codice EPSG ma il suo nome è esattamente \"EPSG:\" seguito da un numero (ad esempio EPSG:31467), usa quel codice. Nessun altro nome viene mai letto. Se il nome era solo un'etichetta, la superficie finisce nel posto sbagliato.",
  "landXmlGeorefAssumptions.title": "Il file LandXML \"{fileName}\" non è stato allineato al modello",
  "landXmlGeorefAssumptions.offer": "Può essere posizionato se accetti:",
  "landXmlGeorefAssumptions.load": "Carica con queste ipotesi",
  "landXmlGeorefAssumptions.always": "Presumi sempre questo",
  "landXmlGeorefAssumptions.alwaysHint": "\"Presumi sempre questo\" attiva anche le ipotesi selezionate in Impostazioni, Generale, per tutti i file LandXML successivi. Puoi disattivarle di nuovo da lì.",
  "landXmlGeorefAssumptions.cancel": "Annulla",
  "landXmlGeorefAssumptions.settings": "Georeferenziazione LandXML",
  "landXmlGeorefAssumptions.settingsHint": "Entrambe sono disattivate per impostazione predefinita: un file LandXML che non indica come si allinea al modello viene rifiutato e il messaggio indica cosa manca. Attivane una solo se vale per i tuoi file. Un modello posizionato in questo modo è contrassegnato come \"Presunto\".",
  "landXmlGeorefAssumptions.badge": "Presunto",
  "landXmlGeorefAssumptions.assumed": "Posizionato usando ipotesi scelte da te",
  "landXmlGeorefAssumptions.sharedVerticalDatum.applied": "Si presume che le quote condividano il sistema altimetrico del modello di ancoraggio: non è dichiarato alcun datum verticale.",
  "landXmlGeorefAssumptions.epsgFromName.applied": "{crs} letto dal nome del CoordinateSystem: non è dichiarato alcun codice EPSG.",
} satisfies Catalogue;
