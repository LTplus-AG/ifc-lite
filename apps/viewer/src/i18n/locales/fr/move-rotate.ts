/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const moveRotateFr = {
  'moveRotate.mirror.label': "Symétrie",
  'moveRotate.mirror.hintStart': "Cliquer le premier point de l’axe de symétrie",
  'moveRotate.mirror.hintEnd': "Cliquer le second point ou saisir un angle et Entrée · Alt conserve l’original",
  'moveRotate.mirror.keepOriginal': "Conserver l’original",
  'moveRotate.offset.label': "Décalage",
  'moveRotate.offset.hint': "Saisir une distance positive et cliquer le côté de la copie parallèle",
  'moveRotate.offset.wallOnly': "Sélectionner un mur droit à décaler",
  'commands.model.mirror': "Symétrie de la sélection (espace Modèle)",
  'commands.model.offset': "Décaler un mur (espace Modèle)",
  "moveRotate.move.label": "Déplacer",
  "moveRotate.move.hintBase": "Cliquez sur le point de départ du déplacement, ou saisissez une distance",
  "moveRotate.move.hintTarget": "Cliquez sur la destination, ou saisissez une distance et une direction, puis Entrée",
  "moveRotate.rotate.label": "Faire pivoter",
  "moveRotate.rotate.hintStart": "Cliquez sur l'anneau pour commencer la rotation, ou saisissez un angle · P choisit un autre pivot",
  "moveRotate.rotate.hintAngle": "Cliquez pour terminer la rotation (pas de 15°, Alt pour une rotation libre), ou saisissez un angle",
  "moveRotate.rotate.hintPivot": "Cliquez sur le point autour duquel pivoter",
  "moveRotate.rotate.pivot": "Pivot",
  "moveRotate.rotate.pivotTitle": "Choisir le point autour duquel pivoter ({key})",
  "moveRotate.field.distance": "Distance",
  "moveRotate.field.direction": "Direction",
  "moveRotate.field.angle": "Angle",
  "moveRotate.noSelection": "Sélectionnez d'abord ce qu'il faut déplacer",
  "moveRotate.refused": "Une partie de la sélection ne peut pas être déplacée : son placement ne dépend pas de son étage",
  "moveRotate.tool.move": "Déplacer",
  "moveRotate.tool.rotate": "Faire pivoter",
  "moveRotate.handle.move": "Déplacer la sélection ({key})",
  "moveRotate.handle.rotate": "Faire pivoter la sélection ({key})",
  "commands.model.move": "Déplacer la sélection (espace de travail Modèle)",
  "commands.model.rotate": "Faire pivoter la sélection (espace de travail Modèle)",
  "commands.command.rotatePivot": "Choisir le point autour duquel pivoter (rotation)",
} satisfies Catalogue;
