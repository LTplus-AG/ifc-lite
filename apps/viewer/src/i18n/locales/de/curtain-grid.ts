/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const curtainGridDe = {
  "curtainWall.label": "Vorhangfassade",
  "curtainWall.palette": "Platzieren Sie Vorhangfassaden",
  "commands.model.curtainWall": "Vorhangfassaden platzieren: Pfosten, Riegel und Paneele (Modellarbeitsbereich)",
  "curtainWall.hint.start": "Klicken Sie, um die Vorhangfassade zu starten. Geben Sie eine Länge ein, um sie zu fixieren",
  "curtainWall.hint.end": "Klicken oder Enter drücken zum Platzieren · das Raster zeigt die Paneele · Esc beginnt von vorn",
  "curtainWall.field.baseOffset": "Fußpunkt",
  "curtainWall.field.panelWidth": "Paneel B",
  "curtainWall.field.panelHeight": "Paneel H",
  "curtainWall.field.mullionWidth": "Pfosten B",
  "curtainWall.field.mullionDepth": "Pfosten T",
  "curtainWall.tooShort": "Die Vorhangfassade ist zu kurz: Klicken Sie weiter vom Startpunkt entfernt",
  "curtainWall.noOpening": "Pfosten und Riegel lassen keine lichte Öffnung: Verbreitern Sie die Paneele oder verschmälern Sie den Pfosten",
  "curtainWall.tooManyPanels": "Diese Paneelgröße erzeugt zu viele Paneele: Wählen Sie größere Paneele",
  "curtainWall.summary": "{bays} × {rows} Paneele",
  "grid.label": "Raster",
  "grid.palette": "Raster platzieren",
  "commands.model.grid": "Ein Planungsraster mit beschrifteten Achsen platzieren (Modellarbeitsbereich)",
  "grid.hint.corner": "Klicken Sie auf die erste Ecke des Rasters. Geben Sie eine Breite ein, um es zu fixieren",
  "grid.hint.opposite": "Gegenüberliegende Ecke anklicken oder Enter drücken · Shift macht das Raster quadratisch · Esc beginnt von vorn",
  "grid.field.spacingU": "U-Abstand",
  "grid.field.spacingV": "V-Abstand",
  "grid.tags.label": "Wie die Achsen markiert sind",
  "grid.tags.numbers": "1, 2, 3",
  "grid.tags.letters": "A, B, C",
  "grid.noArea": "Das Raster hat keine Fläche: Klicken Sie auf eine Ecke, die von der ersten entfernt ist",
  "grid.tooManyAxes": "Dieser Abstand ergibt zu viele Achsen: Erweitern Sie ihn",
  "grid.summary": "{uAxes} × {vAxes} Achsen",
} satisfies Catalogue;
