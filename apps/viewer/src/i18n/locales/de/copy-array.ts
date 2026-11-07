/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const copyArrayDe = {
  "commands.model.copy": "Kopieren Sie die ausgewählten Bauteile (Modellarbeitsbereich)",
  "commands.model.paste": "Fügen Sie die kopierten Bauteile am Cursor ein (Modellarbeitsbereich).",
  "commands.model.pasteInPlace": "Fügen Sie die kopierten Bauteile an Ort und Stelle im aktuellen Geschoss ein (Modellarbeitsbereich).",
  "commands.model.array": "Wiederholen Sie die ausgewählten Bauteile in einer Reihe oder um einen Mittelpunkt (Modellarbeitsbereich)",
  "copyArray.copied": {"one": "{countDisplay} Bauteil kopiert", "other": "{countDisplay} Bauteile kopiert"},
  "copyArray.cameFree": {"one": "{countDisplay} Kopie liegt auf keinem Rasterschnittpunkt und ist nicht mehr an das Raster gebunden", "other": "{countDisplay} Kopien liegen auf keinem Rasterschnittpunkt und sind nicht mehr an das Raster gebunden"},
  "copyArray.paste.label": "Einfügen",
  "copyArray.paste.hint": "Klicken Sie auf die Zielposition der Kopie. Zum Einfügen in einem anderen Geschoss zuerst das Geschoss wechseln",
  "copyArray.paste.empty": "Es wird noch nichts kopiert: Wählen Sie Bauteile aus und kopieren Sie sie zuerst",
  "copyArray.paste.stale": "Die kopierten Bauteile können nicht mehr kopiert werden: Wählen Sie sie aus und kopieren Sie sie erneut",
  "copyArray.paste.otherModel": "Die kopierten Bauteile befinden sich in einem anderen Modell: Fügen Sie sie dort ein",
  "copyArray.tool.array": "Anordnung",
  "copyArray.blocked.array": "Wählen Sie zuerst die Bauteile aus, die wiederholt werden sollen",
  "copyArray.array.label": "Anordnung",
  "copyArray.array.noSelection": "Wählen Sie zuerst die Bauteile aus, die wiederholt werden sollen",
  "copyArray.array.refused": "Diese Bauteile können nicht wiederholt werden: Klicken Sie, um zu sehen, warum",
  "copyArray.array.linearStart": "Klicken Sie dort, wo die Richtung beginnt",
  "copyArray.array.linearEnd": "Klicken Sie auf den Endpunkt: Der Abstand entspricht einem Schritt (Abstand) oder der gesamten Anordnung (Einpassen)",
  "copyArray.array.polarCentre": "Klicken Sie auf den Mittelpunkt, um den die Kopien gedreht werden",
  "copyArray.array.polarCommit": "Klicken oder Enter drücken, um die Kopien zu platzieren",
  "copyArray.field.count": "Anzahl",
  "copyArray.field.spacing": "Abstand",
  "copyArray.field.total": "Insgesamt",
  "copyArray.field.angle": "Winkel",
  "copyArray.mode.label": "Art der Anordnung",
  "copyArray.mode.linear": "Linear",
  "copyArray.mode.polar": "Polar",
  "copyArray.fit.label": "Was die Entfernung misst",
  "copyArray.fit.spacing": "Abstand",
  "copyArray.fit.fit": "Einpassen",
  "copyArray.fit.spacingTitle": "Der Abstand ist der Schritt von einer Kopie zur nächsten",
  "copyArray.fit.fitTitle": "Der Abstand umfasst die gesamte Anordnung",
} satisfies Catalogue;
