/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const roomToolDe = {
  "roomTool.options.minArea": "Mindestfläche (m²)",
  "roomTool.options.namePattern": "Namensmuster",
  "roomTool.options.nameHint": "Das Token {token} fügt die Raumnummer ein.",
  "roomTool.options.classification": "IfcSpace.{attribute}",
  "roomTool.options.objectType": "IfcSpace.ObjectType",
  "roomTool.options.invalid": "Positive Mindestfläche und nicht leeres Raumnamensmuster eingeben",
  "roomTool.options.objectTypeRequired": "IfcSpace.ObjectType für einen USERDEFINED-Raum eingeben",
  "roomTool.preview.total": {
    "one": "{countDisplay} neuer Raum · insgesamt {area} m²",
    "other": "{countDisplay} neue Räume · insgesamt {area} m²"
  },
  "roomTool.preview.graph": "{walls} Wände · {vertices} Grundrisseckpunkte · {edges} Grundrisskanten",
  "roomTool.preview.leaks": "{openEnds} offene Wandenden · {unboundedWalls} Wände umschließen keinen Raum",
  "roomTool.label": "Raum",
  "commands.model.room": "Räume aus Wänden erzeugen oder zeichnen (Modellarbeitsbereich)",
  "roomTool.hint.pick": "Innerhalb der Wände klicken, um einen Raum zu erzeugen · Automatik erzeugt alle Räume dieses Geschosses",
  "roomTool.hint.taken": "Diese Fläche hat bereits einen Raum",
  "roomTool.hint.drawCorner": "Raumecken anklicken",
  "roomTool.hint.drawClose": "Enter, Doppelklick oder Klick auf die erste Ecke schließt den Raum",
  "roomTool.mode.label": "Art der Raumerstellung",
  "roomTool.mode.pick": "Wählen",
  "roomTool.mode.draw": "Zeichnen",
  "roomTool.boundary.label": "Wandfläche, der der Raum folgt",
  "roomTool.boundary.inner": "Innen",
  "roomTool.boundary.center": "Achse",
  "roomTool.boundary.outer": "Außen",
  "roomTool.auto.label": "Automatisch · {countDisplay}",
  "roomTool.auto.title": "Jede wandumschlossene Fläche dieses Geschosses ohne Raum in einem rückgängig machbaren Schritt zu einem Raum machen",
  "roomTool.auto.none": "Jede wandumschlossene Fläche dieses Geschosses hat bereits einen Raum",
  "roomTool.update.label": "Räume aktualisieren",
  "roomTool.update.title": "Umrisse der ausgewählten Räume aus den aktuellen Wänden neu ableiten",
  "roomTool.update.noSelection": "Wählen Sie zuerst die zu aktualisierenden Räume aus",
  "roomTool.update.none": "Keiner der ausgewählten Räume konnte aktualisiert werden: Jeder muss eine Grundrissextrusion auf einem Geschoss innerhalb von Wänden sein",
  "roomTool.update.skipped": {
    "one": "{countDisplay} ausgewählter Raum blieb unverändert: Er ist keine Grundrissextrusion auf einem Geschoss oder wird nicht von Wänden umschlossen",
    "other": "{countDisplay} ausgewählte Räume blieben unverändert: Sie sind keine Grundrissextrusionen auf einem Geschoss oder werden nicht von Wänden umschlossen"
  },
  "roomTool.wasmFailed": "Die Raum-Engine wurde nicht geladen, daher können keine Räume abgeleitet werden: Seite neu laden und erneut versuchen",
  "roomTool.palette": "Räume erzeugen",
  "roomTool.loading": "Wände werden gelesen… versuchen Sie es gleich erneut",
  "roomTool.noWalls": "Keine Wände dieses Geschosses umschließen einen Raum: Zeichnen Sie die Wände oder wechseln Sie zu „Zeichnen“",
  "roomTool.pick.none": "Keine Wände umschließen diesen Punkt: Klicken Sie innerhalb eines Raums oder wechseln Sie zu „Zeichnen“",
  "roomTool.pick.taken": "Diese Fläche hat bereits einen Raum",
  "roomTool.draw.needThree": "Ein Raum benötigt mindestens drei Ecken",
  "roomTool.update.unresolvedPlacement": "Wand gedreht. Räume wurden nicht aktualisiert, weil die Wandplatzierung nicht gelesen werden konnte.",
} satisfies Catalogue;
