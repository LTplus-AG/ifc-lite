/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const multiSplitDe = {
  "multiSplit.label": "Entlang einer Linie teilen",
  "multiSplit.tool": "Entlang einer Linie teilen",
  "commands.model.splitMulti": "Alles entlang einer Linie aufteilen (Modellarbeitsbereich)",
  "multiSplit.hintStart": "Ersten Punkt der Schnittlinie anklicken · Auswahl oder Geschoss wird entlang der Linie geteilt · Esc beendet",
  "multiSplit.hintEnd": "Zweiten Punkt anklicken oder Enter drücken, um gekreuzte Bauteile zu teilen · Backspace beginnt die Linie neu · Esc beginnt von vorn",
  "multiSplit.noTargets": "Hier gibt es nichts zu teilen: Wählen Sie Bauteile aus oder wählen Sie ein Geschoss mit Wänden, Balken oder Platten",
  "multiSplit.needLine": "Zeichnen Sie zuerst die Schnittlinie: zwei Punkte",
  "multiSplit.crossesNothing": "Die Linie kreuzt nichts, was sie teilen kann",
  "multiSplit.nothingSplittable": "Alle von der Linie gekreuzten Bauteile werden abgelehnt: Es würde nichts geteilt",
  "multiSplit.scope.selection": {"one": "Ausgewählt: {countDisplay} Bauteil", "other": "Ausgewählt: {countDisplay} Bauteile"},
  "multiSplit.scope.storey": {"one": "Geschoss: {countDisplay} Wand, Balken oder Platte", "other": "Geschoss: {countDisplay} Wände, Balken und Platten"},
  "multiSplit.bar.splits": {"one": "{countDisplay} wird geteilt", "other": "{countDisplay} werden geteilt"},
  "multiSplit.bar.refused": {"one": "{countDisplay} abgelehnt", "other": "{countDisplay} abgelehnt"},
  "multiSplit.refused.otherModel": "Gehört zu einem anderen Modell als dem, das bearbeitet wird",
  "multiSplit.refused.column": "Kann nicht geteilt werden: Ein vertikaler Schnitt kreuzt eine Säule nicht in Längsrichtung",
  "multiSplit.refused.vertical": "Kann nicht geteilt werden: Ein vertikales Bauteil hat keine Planachse, die die Linie kreuzen könnte",
  "multiSplit.refused.nearEnd": "Nicht teilbar: Die Linie verläuft weniger als {min} cm vom Ende entfernt",
  "multiSplit.done": {"one": "{countDisplay} Bauteil geteilt", "other": "{countDisplay} Bauteile geteilt"},
  "multiSplit.leftAlone": {"one": "{countDisplay} Bauteil, das die Linie kreuzt, wurde so belassen, wie es war (siehe den Grund daneben)", "other": "{countDisplay} Bauteile, bei denen die Linienkreuze so belassen wurden, wie sie waren (siehe jeweils nebenstehenden Grund)"},
  "multiSplit.openingsSkipped": {"one": "Die Öffnung {countDisplay} konnte nicht neu zugewiesen werden und muss möglicherweise manuell neu positioniert werden", "other": "{countDisplay} Öffnungen konnten nicht neu zugewiesen werden und müssen möglicherweise manuell neu positioniert werden"},
  "commandPalette.tool.splitMulti.label": "Entlang einer Linie teilen",
} satisfies Catalogue;
