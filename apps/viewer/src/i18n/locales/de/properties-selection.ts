/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const propertiesSelectionDe = {
  "properties.copy.valueLabel": "{name} kopieren",
  "properties.copy.valueTooltip": "{name} kopieren (Shift oder halten: Name=Wert kopieren)",
  "properties.copy.copied": "In Zwischenablage kopiert",
  "properties.copy.failed": "Konnte nicht in die Zwischenablage kopiert werden",
  "properties.summary.elementCount": {
    "one": "{countDisplay} Bauteil",
    "other": "{countDisplay} Bauteile"
  },
  "properties.summary.byClassHeading": "Nach Klasse",
  "properties.summary.byModelHeading": "Nach Modell",
  "properties.summary.elementsHeading": "Bauteile",
  "properties.summary.attributesHeading": "Gemeinsame Attribute",
  "properties.summary.propertiesHeading": "Gemeinsame Eigenschaften",
  "properties.summary.quantitiesHeading": "Gemeinsame Mengen",
  "properties.summary.varies": {
    "one": "(variiert: {countDisplay} Wert)",
    "other": "(variiert: {countDisplay} Werte)"
  },
  "properties.summary.noShared": "Die ausgewählten Bauteile haben keine gemeinsamen Eigenschaften oder Mengen",
  "properties.summary.selectOnly": "Nur {name} auswählen",
  "properties.summary.moreElements": {
    "one": "{countDisplay} weiteres Bauteil",
    "other": "{countDisplay} weitere Bauteile"
  },
  "properties.summary.valuesCapped": "Werte der ersten {limit} von {total} Bauteilen verglichen"
} satisfies Catalogue;
