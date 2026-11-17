/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const roomLayoutDe = {
  'roomLayout.mode.edit': 'Bearbeiten',
  'roomLayout.tool.label': 'Was ein Klick auf das Layout bewirkt',
  'roomLayout.tool.shape': 'Verschieben · Schneiden',
  'roomLayout.tool.remove': 'Zusammenführen · Entfernen',
  'roomLayout.tool.shapeTitle': 'Ziehen Sie eine Ecke, um sie zu verschieben; klicken Sie auf zwei Punkte eines Raumumrisses, um den Raum dazwischen zu schneiden',
  'roomLayout.tool.removeTitle': 'Klicken Sie auf die Wand zwischen zwei Räumen, um sie zusammenzuführen; klicken Sie auf eine Ecke, um sie zu entfernen',
  'roomLayout.cleanup.label': 'Bereinigen',
  'roomLayout.cleanup.title': 'Lose Wände, lose Knoten und überflüssige Ecken in einem Rückgängig-Schritt aus dem Layout entfernen',
  'roomLayout.hint.shape': 'Ecke ziehen, um sie zu verschieben · auf einen Raumumriss klicken, um einen Schnitt zu beginnen',
  'roomLayout.hint.remove': 'Klicken Sie auf die Wand zwischen zwei Räumen, um sie zusammenzuführen, oder auf eine Ecke, um sie zu entfernen',
  'roomLayout.hint.drop': 'Loslassen oder klicken, um die Ecke abzusetzen · Esc bricht ab',
  'roomLayout.hint.cutEnd': 'Klicken Sie auf einen weiteren Punkt desselben Raumumrisses, um ihn zu schneiden · Esc bricht ab',
  'roomLayout.hint.open': 'Keine Wände schließen diesen Bereich: Die offenen Wandenden sind markiert',
  'roomLayout.edit.none': 'Zeigen Sie zuerst auf eine Ecke oder einen Raumumriss',
  'roomLayout.edit.refused': 'Das Layout kann diese Bearbeitung nicht übernehmen: {reason}',
  'roomLayout.prune.none': 'Nichts zu bereinigen: Das Layout hat keine losen Wände oder Knoten',
  'roomLayout.refused.shape': 'Ein Raum hier ist kein senkrecht extrudierter Umriss, daher kann seine Form nicht bearbeitet werden: Verwenden Sie Räume aktualisieren oder zeichnen Sie ihn neu',
  'roomLayout.refused.storey': 'Ein Raum hier liegt in keinem Geschoss, daher kann seine Form nicht bearbeitet werden',
  'roomLayout.refused.merge': 'Einer der zusammengeführten Räume konnte nicht entfernt werden',
  'roomLayout.more.label': 'Mehr',
  'roomLayout.more.title': 'Grundfläche, Automatisch in jedem Geschoss, Eckverschweißung und Lückendiagnose',
  'roomLayout.footprint.label': 'Grundfläche',
  'roomLayout.footprint.title': 'Ein Raum über den gesamten Umriss dieses Geschosses, in einem Rückgängig-Schritt',
  'roomLayout.footprint.taken': 'Dieses Geschoss hat bereits Räume: Grundfläche erzeugt einen Raum über das gesamte Geschoss, der sie überlappen würde',
  'roomLayout.autoAll.label': 'Automatisch in jedem Geschoss',
  'roomLayout.autoAll.title': 'Jeden von Wänden umschlossenen Bereich ohne Raum in jedem Geschoss zu einem Raum machen, in einem Rückgängig-Schritt',
  'roomLayout.autoAll.none': 'Jeder von Wänden umschlossene Bereich hat in jedem Geschoss bereits einen Raum',
  'roomLayout.weld.label': 'Eckverschweißung',
  'roomLayout.weld.title': 'Wie nah zwei Wandecken beieinander liegen müssen, um als eine zu gelten: Erhöhen Sie den Wert, wenn aufeinandertreffende Wände einen Raum offen lassen',
  'roomLayout.weld.aria': 'Eckverschweißung (Meter)',
  'roomLayout.weld.auto': 'Standard (5 cm)',
  'roomLayout.weld.reset': 'Auf den Standardwert von 5 cm zurücksetzen',
  'roomLayout.weld.rooms': {
    one: '{countDisplay} Raum',
    other: '{countDisplay} Räume',
  },
  'roomLayout.leaks.label': 'Lücken anzeigen',
  'roomLayout.leaks.title': 'Wände markieren, die keinen Raum umschließen, und Wandenden, die nichts berühren: warum ein Bereich nicht geschlossen ist',
} satisfies Catalogue;
