/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const pushPullAlignDe = {
  "commands.model.pushPull": "Fläche des ausgewählten Bauteils drücken oder ziehen (Modellarbeitsbereich)",
  "commands.model.align": "Bauteile an einer Kante einer Referenz ausrichten (Modellarbeitsbereich)",
  "modelWorkspace.tool.pushPull": "Drücken / Ziehen",
  "modelWorkspace.tool.align": "Ausrichten",
  "modelWorkspace.blocked.pushPull": "Wand, Decke, Stütze oder Träger zum Drücken oder Ziehen auswählen",
  "commandPalette.tool.pushPull.label": "Fläche drücken / ziehen",
  "commandPalette.tool.align.label": "Bauteile ausrichten",
  "pushPull.label": "Drücken / Ziehen",
  "pushPull.field.size": "Größe",
  "pushPull.hint.noTarget": "Wählen Sie eine Wand, Decke, Stütze oder einen Träger, um deren Flächen zu drücken oder zu ziehen.",
  "pushPull.hint.pick": "Flächengriff greifen, dann ziehen oder Größe eingeben",
  "pushPull.hint.drag": "Ziehen oder Größe eingeben · Klicken oder Enter übernimmt · Esc bricht ab",
  "pushPull.unchanged": "Die Größe hat sich nicht geändert.",
  "pushPull.face.wallHeight": "Wandhöhe",
  "pushPull.face.wallThickness": "Wanddicke",
  "pushPull.face.slabThickness": "Deckendicke",
  "pushPull.face.length": "Länge",
  "pushPull.handleAria": "{face} ziehen",
  "pushPull.bar.readout": "{face} {delta} m",
  "pushPull.bar.snapLevel": "An Geschossebene gefangen",
  "pushPull.bar.snapStep": "An Schritt gefangen",
  "align.label": "Ausrichten",
  "align.hint.reference": "Bauteil anklicken, an dem die anderen ausgerichtet werden",
  "align.hint.targets": "Auszurichtende Bauteile anklicken",
  "align.hint.commit": "Enter richtet aus · Bauteil anklicken zum Hinzufügen oder Entfernen · Esc beginnt neu",
  "align.alreadyAligned": "Sie sind bereits an dieser Kante ausgerichtet.",
  "align.mode.aria": "Ausrichtungskante",
  "align.mode.left": "Links",
  "align.mode.centre": "Mitte",
  "align.mode.right": "Rechts",
  "align.mode.top": "Oben",
  "align.mode.middle": "Mittig",
  "align.mode.bottom": "Unten",
  "align.bar.count": "{targets} gewählt · {moving} zu verschieben"
} satisfies Catalogue;
