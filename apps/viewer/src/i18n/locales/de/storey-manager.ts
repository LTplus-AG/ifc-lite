/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const storeyManagerDe = {
  "storeyManager.title": "Geschosse",
  "storeyManager.subtitle": "{model} · {count} Geschosse",
  "storeyManager.open": "Geschosse verwalten…",
  "storeyManager.back": "Zurück zum Inspektor",
  "storeyManager.undoLabel": "Geschossänderung",
  "storeyManager.addAbove": "Geschoss darüber hinzufügen",
  "storeyManager.addBelow": "Geschoss darunter hinzufügen",
  "storeyManager.addAboveOf": "Geschoss über {storey} hinzufügen",
  "storeyManager.addBelowOf": "Geschoss unter {storey} hinzufügen",
  "storeyManager.fallbackName": "Ebene {index}",
  "storeyManager.added": "{storey} auf {elevation} m hinzugefügt",
  "storeyManager.renamed": "Umbenannt in {storey}",
  "storeyManager.column.name": "Name",
  "storeyManager.column.elevation": "Höhenlage",
  "storeyManager.column.height": "Geschosshöhe",
  "storeyManager.column.elements": "Elemente",
  "storeyManager.elements": {
    "one": "{count} Element",
    "other": "{count} Elemente"
  },
  "storeyManager.active": "Hier wird gezeichnet",
  "storeyManager.activeGroup": "Geschoss zum Zeichnen",
  "storeyManager.activate": "Auf {storey} zeichnen",
  "storeyManager.noStoreyAbove": "Oberstes Geschoss: kein Geschoss darüber, bis zu dem gemessen werden kann",
  "storeyManager.field.name": "Name von {storey}",
  "storeyManager.field.elevation": "Höhenlage von {storey} in Metern",
  "storeyManager.field.height": "Geschosshöhe von {storey} in Metern",
  "storeyManager.field.hint": "Enter übernimmt · Esc bricht ab",
  "storeyManager.invalid.name": "Ein Geschoss braucht einen Namen",
  "storeyManager.invalid.length": "Geben Sie eine Länge ein, z. B. 3.00, 3,5 oder 3500 mm",
  "storeyManager.invalid.height": "Geben Sie eine Höhe über null ein, z. B. 3.00 oder 3500 mm",
  "storeyManager.mode.elevation": "Verschiebt nur {storey}; die Geschosse darüber bleiben",
  "storeyManager.mode.height": "Verschiebt alle Geschosse über {storey} um denselben Betrag",
  "storeyManager.impact.title": "Was sich ändert",
  "storeyManager.impact.storeys": {
    "one": "Verschiebt {count} Geschoss",
    "other": "Verschiebt {count} Geschosse"
  },
  "storeyManager.impact.elements": {
    "one": "verschiebt {count} Element",
    "other": "verschiebt {count} Elemente"
  },
  "storeyManager.impact.walls": {
    "one": "passt {count} Wand an",
    "other": "passt {count} Wände an"
  },
  "storeyManager.impact.stairs": {
    "one": "passt {count} Treppe an",
    "other": "passt {count} Treppen an"
  },
  "storeyManager.impact.held": {
    "one": "hält {count} Element eines anderen Geschosses an seinem Ort",
    "other": "hält {count} Elemente anderer Geschosse an ihrem Ort"
  },
  "storeyManager.impact.nothing": "Nichts bewegt sich: Das Geschoss liegt bereits dort",
  "storeyManager.impact.preview": "Wird vor dem Übernehmen in 3D und im Grundriss gezeigt",
  "storeyManager.impact.planOnly": "In einem geteilten Raum wird die Vorschau nicht allen gezeigt: Enter übernimmt sie",
  "storeyManager.notice.wallNotResized": {
    "one": "{count} angeschlossene Wand wird verschoben, behält aber ihre Höhe: Sie ist keine einfache Extrusion",
    "other": "{count} angeschlossene Wände werden verschoben, behalten aber ihre Höhe: Sie sind keine einfachen Extrusionen"
  },
  "storeyManager.notice.stairNotRefit": {
    "one": "{count} Treppe wird verschoben, aber nicht angepasst: Sie ist kein einzelner Treppenlauf",
    "other": "{count} Treppen werden verschoben, aber nicht angepasst: Sie sind keine einzelnen Treppenläufe"
  },
  "storeyManager.notice.select": "Auswählen",
  "storeyManager.refusal.spacing": "Dann bleibt keine Höhe zwischen {storey} und {neighbour}",
  "storeyManager.refusal.crossingAbove": "{storey} würde {neighbour} ({neighbourElevation} m) darüber überholen",
  "storeyManager.refusal.crossingBelow": "{storey} würde {neighbour} ({neighbourElevation} m) darunter überholen",
  "storeyManager.refusal.topStorey": "{storey} ist das oberste Geschoss: Es gibt kein Geschoss darüber, bis zu dem gemessen werden kann",
  "storeyManager.refusal.shared": {
    "one": "{count} Element teilt seine Platzierung mit einem anderen Geschoss und kann nicht allein verschoben werden",
    "other": "{count} Elemente teilen Platzierungen mit einem anderen Geschoss und können nicht allein verschoben werden"
  },
  "storeyManager.refusal.unplaced": {
    "one": "{count} Element hat Geometrie, aber keine Platzierung, und kann nicht verschoben werden",
    "other": "{count} Elemente haben Geometrie, aber keine Platzierung, und können nicht verschoben werden"
  },
  "storeyManager.refusal.unreadable": {
    "one": "{count} Element hat eine Platzierung, die nicht gelesen werden kann",
    "other": "{count} Elemente haben Platzierungen, die nicht gelesen werden können"
  },
  "storeyManager.refusal.onlyStorey": "Ein Modell behält mindestens ein Geschoss",
  "storeyManager.refusal.stale": "Das Modell hat sich seit der Prüfung geändert. Prüfen Sie es erneut, bevor Sie bestätigen.",
  "storeyManager.refusal.tooLarge": "{storey} enthält zu viele Elemente, um es in einem Schritt zu bearbeiten",
  "storeyManager.refusal.other": "Nicht übernommen: {reason}",
  "storeyManager.refusal.nothingChanged": "Es wurde nichts geändert.",
  "storeyManager.delete": "{storey} löschen",
  "storeyManager.deleted": "{storey} gelöscht",
  "storeyManager.undo": "Rückgängig",
  "storeyManager.delete.title": {
    "one": "{storey} enthält {count} Element",
    "other": "{storey} enthält {count} Elemente"
  },
  "storeyManager.delete.moveTo": "Verschieben nach",
  "storeyManager.delete.move": "Verschieben und löschen",
  "storeyManager.delete.withContents": {
    "one": "Mit seinem {count} Element löschen",
    "other": "Mit seinen {count} Elementen löschen"
  },
  "storeyManager.delete.cancel": "Geschoss behalten",
  "storeyManager.strip.label": "Geschosse maßstäblich",
  "storeyManager.strip.level": "{storey} auf {elevation} m",
  "storeyManager.loading": "Geschosse werden gelesen…",
  "storeyManager.empty": "Dieses Modell hat noch keine Geschosse",
  "storeyManager.addFirst": "Geschoss auf ±0.00 hinzufügen",
  "storeyManager.noModel": "Öffnen Sie ein Modell im Modellierbereich, um seine Geschosse zu verwalten",
  "storeyManager.readOnly": "Geschosse können angezeigt, aber nicht bearbeitet werden: {reason}",
  "storeyManager.error": "Geschosse können nicht gelesen werden: {reason}"
} satisfies Catalogue;
