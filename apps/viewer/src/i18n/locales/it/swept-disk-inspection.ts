/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const sweptDiskInspectionIt = {
  "properties.sweptDisk.heading": "Geometria di origine derivata",
  "properties.sweptDisk.sourceNote": "Misure della direttrice derivate dalla geometria di origine definita nel modello. Gli attributi IFC e i valori di IfcElementQuantity sono elencati separatamente.",
  "properties.sweptDisk.loading": "Lettura della geometria di origine selezionata…",
  "properties.sweptDisk.empty": "Nessuna geometria di origine swept-disk per questa selezione",
  "properties.sweptDisk.solid": "IfcSweptDiskSolid #{id}",
  "properties.sweptDisk.status": "Descrizione",
  "properties.sweptDisk.complete": "Completa",
  "properties.sweptDisk.unsupported": "Non supportata",
  "properties.sweptDisk.sourceModified": "Origine modificata da CSG",
  "properties.sweptDisk.modifiedHint": "La direttrice di origine può differire dal risultato visibile.",
  "properties.sweptDisk.modifiedHighlightHint": "Il segmento di origine non può essere evidenziato sulla mesh modificata da CSG.",
  "properties.sweptDisk.yes": "Sì",
  "properties.sweptDisk.no": "No",
  "properties.sweptDisk.directrix": "Direttrice di origine",
  "properties.sweptDisk.mappingPath": "Percorso mappato",
  "properties.sweptDisk.none": "Nessuno",
  "properties.sweptDisk.radius": "Raggio",
  "properties.sweptDisk.innerRadius": "InnerRadius",
  "properties.sweptDisk.unsupportedRadiusHint": "Il raggio è il valore definito nel modello; non è stato possibile determinare un raggio nelle coordinate globali.",
  "properties.sweptDisk.derivedCentreline": "Misure derivate dell'asse",
  "properties.sweptDisk.totalLength": "Lunghezza totale dell'asse",
  "properties.sweptDisk.segment": "Segmento {index}",
  "properties.sweptDisk.bend": "Ampiezza della curvatura",
  "properties.sweptDisk.signedSweep": "Angolo di sweep con segno",
} satisfies Catalogue;
