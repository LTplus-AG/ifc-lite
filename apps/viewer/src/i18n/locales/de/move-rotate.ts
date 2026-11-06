/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const moveRotateDe = {
  'moveRotate.move.label': 'Verschieben',
  'moveRotate.move.hintBase': 'Klicken Sie auf den Ausgangspunkt oder geben Sie einen Abstand ein',
  'moveRotate.move.hintTarget': 'Klicken Sie auf das Ziel oder geben Sie Abstand und Richtung ein und drücken Sie dann Enter',
  'moveRotate.rotate.label': 'Drehen',
  'moveRotate.rotate.hintStart': 'Klicken Sie auf den Ring, um die Drehung zu beginnen, oder geben Sie einen Winkel ein · P wählt einen anderen Drehpunkt',
  'moveRotate.rotate.hintAngle': 'Klicken Sie, um die Drehung abzuschließen (15°-Schritte, Alt dreht frei), oder geben Sie einen Winkel ein',
  'moveRotate.rotate.hintPivot': 'Klicken Sie auf den Drehpunkt',
  'moveRotate.rotate.pivot': 'Drehpunkt',
  'moveRotate.rotate.pivotTitle': 'Drehpunkt wählen ({key})',
  'moveRotate.field.distance': 'Abstand',
  'moveRotate.field.direction': 'Richtung',
  'moveRotate.field.angle': 'Winkel',
  'moveRotate.noSelection': 'Wählen Sie zuerst aus, was verschoben werden soll',
  'moveRotate.refused': 'Ein Teil der Auswahl kann nicht verschoben werden: Seine Platzierung hängt nicht an seinem Geschoss',
  'moveRotate.tool.move': 'Verschieben',
  'moveRotate.tool.rotate': 'Drehen',
  'moveRotate.handle.move': 'Auswahl verschieben ({key})',
  'moveRotate.handle.rotate': 'Auswahl drehen ({key})',
  'commands.model.move': 'Auswahl verschieben (Modell-Arbeitsbereich)',
  'commands.model.rotate': 'Auswahl drehen (Modell-Arbeitsbereich)',
  'commands.command.rotatePivot': 'Drehpunkt wählen (beim Drehen)',
} satisfies Catalogue;
