/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const moveRotateIt = {
  'moveRotate.mirror.label': "Specchia",
  'moveRotate.mirror.hintStart': "Fare clic sul primo punto dell’asse di simmetria",
  'moveRotate.mirror.hintEnd': "Fare clic sul secondo punto o digitare un angolo e Invio · Alt conserva l’originale",
  'moveRotate.mirror.keepOriginal': "Mantieni originale",
  'moveRotate.offset.label': "Offset",
  'moveRotate.offset.hint': "Digitare una distanza positiva e fare clic sul lato della copia parallela",
  'moveRotate.offset.wallOnly': "Selezionare una parete diritta da sfalsare",
  'commands.model.mirror': "Specchia la selezione (area Modello)",
  'commands.model.offset': "Sfalsa una parete (area Modello)",
  "moveRotate.move.label": "Sposta",
  "moveRotate.move.hintBase": "Fai clic sul punto da cui spostare, oppure digita una distanza",
  "moveRotate.move.hintTarget": "Fai clic sulla destinazione, oppure digita una distanza e una direzione, poi Invio",
  "moveRotate.rotate.label": "Ruota",
  "moveRotate.rotate.hintStart": "Fai clic sull'anello per iniziare la rotazione, oppure digita un angolo · P sceglie un altro perno",
  "moveRotate.rotate.hintAngle": "Fai clic per terminare la rotazione (passi di 15°, Alt ruota liberamente), oppure digita un angolo",
  "moveRotate.rotate.hintPivot": "Fai clic sul punto attorno a cui ruotare",
  "moveRotate.rotate.pivot": "Perno",
  "moveRotate.rotate.pivotTitle": "Scegli il punto attorno a cui ruotare ({key})",
  "moveRotate.field.distance": "Distanza",
  "moveRotate.field.direction": "Direzione",
  "moveRotate.field.angle": "Angolo",
  "moveRotate.noSelection": "Seleziona prima cosa spostare",
  "moveRotate.refused": "Una parte della selezione non può essere spostata: il suo posizionamento non dipende dal suo piano",
  "moveRotate.tool.move": "Sposta",
  "moveRotate.tool.rotate": "Ruota",
  "moveRotate.handle.move": "Sposta la selezione ({key})",
  "moveRotate.handle.rotate": "Ruota la selezione ({key})",
  "commands.model.move": "Sposta la selezione (area di lavoro Modello)",
  "commands.model.rotate": "Ruota la selezione (area di lavoro Modello)",
  "commands.command.rotatePivot": "Scegli il punto attorno a cui ruotare (rotazione)",
} satisfies Catalogue;
