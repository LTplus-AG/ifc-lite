/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const sweptDiskInspectionDe = {
  "properties.sweptDisk.heading": "Abgeleitete Quellgeometrie",
  "properties.sweptDisk.sourceNote": "Abgeleitete Leitkurvenmessungen aus der erstellten Quelle. IFC-Attribute und IfcElementQuantity-Werte werden separat aufgelistet.",
  "properties.sweptDisk.loading": "Ausgewählte Quellgeometrie wird gelesen…",
  "properties.sweptDisk.empty": "Keine Quellgeometrie aus Kreisprofil-Extrusionen für diese Auswahl",
  "properties.sweptDisk.solid": "IfcSweptDiskSolid #{id}",
  "properties.sweptDisk.status": "Beschreibung",
  "properties.sweptDisk.complete": "Vollständig",
  "properties.sweptDisk.unsupported": "Nicht unterstützt",
  "properties.sweptDisk.sourceModified": "Quelle durch CSG geändert",
  "properties.sweptDisk.modifiedHint": "Die Quellleitkurve kann vom sichtbaren Ergebnis abweichen.",
  "properties.sweptDisk.modifiedHighlightHint": "Das Quellsegment kann am CSG-veränderten Netz nicht hervorgehoben werden.",
  "properties.sweptDisk.yes": "Ja",
  "properties.sweptDisk.no": "Nein",
  "properties.sweptDisk.directrix": "Quellleitkurve",
  "properties.sweptDisk.mappingPath": "Abbildungspfad",
  "properties.sweptDisk.none": "Keine",
  "properties.sweptDisk.radius": "Radius",
  "properties.sweptDisk.innerRadius": "InnerRadius",
  "properties.sweptDisk.unsupportedRadiusHint": "Radius ist der erstellte Wert; ein Weltradius konnte nicht ermittelt werden.",
  "properties.sweptDisk.derivedCentreline": "Abgeleitete Mittellinienmessungen",
  "properties.sweptDisk.totalLength": "Gesamtlänge der Mittellinie",
  "properties.sweptDisk.segment": "Segment {index}",
  "properties.sweptDisk.bend": "Biegungsbetrag",
  "properties.sweptDisk.signedSweep": "Vorzeichenbehafteter Schwenkwinkel"
} satisfies Catalogue;
