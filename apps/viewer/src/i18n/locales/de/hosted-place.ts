/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const hostedPlaceDe = {
  "hostedPlace.tool.opening": "Öffnung",
  "hostedPlace.tool.door": "Tür",
  "hostedPlace.tool.window": "Fenster",
  "hostedPlace.hint.opening": "Auf eine Wand zeigen und klicken, um eine Öffnung zu schneiden · Esc beendet",
  "hostedPlace.hint.door": "Auf eine Wand zeigen und klicken, um die Tür zu platzieren · Esc beendet",
  "hostedPlace.hint.window": "Auf eine Wand zeigen und klicken, um das Fenster zu platzieren · Esc beendet",
  "hostedPlace.field.offset": "Versatz",
  "hostedPlace.field.sill": "Brüstungshöhe",
  "hostedPlace.noHost": "Türen, Fenster und Öffnungen gehören in eine Wand: Zeigen Sie auf eine Wand in diesem Geschoss",
  "hostedPlace.outsideHost": "Es passt nicht in diese Wand: Ändern Sie den Abstand, die Brüstung oder die Größe",
  "commandPalette.tool.opening.label": "Öffnungen schneiden",
  "commandPalette.tool.door.label": "Türen platzieren",
  "commandPalette.tool.window.label": "Fenster platzieren",
  "commands.model.opening": "Öffnungen in Wände schneiden (Modellarbeitsbereich)",
  "commands.model.door": "Türen in Wänden platzieren (Modellarbeitsbereich)",
  "commands.model.window": "Fenster in Wänden platzieren (Modellarbeitsbereich)",
  "modelInspector.hosting.host": "Trägerbauteil",
  "modelInspector.hosting.selectHost": "Trägerbauteil auswählen",
  "modelInspector.hosting.offset": "Versatz",
  "modelInspector.hosting.sill": "Brüstungshöhe",
  "modelInspector.hosting.none": "Nicht eingebaut: Dieses Bauteil füllt keine Wandöffnung.",
  "modelInspector.hosting.invalid": "Geben Sie eine Länge in Metern ein",
  "modelInspector.type.noClass": "{schema} hat kein {typeClass}, daher behält dieses Bauteil keinen Typ.",
} satisfies Catalogue;
