/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const pushPullAlignFr = {
  "commands.model.pushPull": "Pousser ou tirer une face de l'élément sélectionné (espace de travail Modèle)",
  "commands.model.align": "Aligner des éléments sur une arête d'une référence (espace de travail Modèle)",
  "modelWorkspace.tool.pushPull": "Pousser / Tirer",
  "modelWorkspace.tool.align": "Aligner",
  "modelWorkspace.blocked.pushPull": "Sélectionnez un mur, une dalle, un poteau ou une poutre à pousser ou tirer",
  "commandPalette.tool.pushPull.label": "Pousser / Tirer une face",
  "commandPalette.tool.align.label": "Aligner des éléments",
  "pushPull.label": "Pousser / Tirer",
  "pushPull.field.size": "Taille",
  "pushPull.hint.noTarget": "Sélectionnez un mur, une dalle, un poteau ou une poutre pour pousser ou tirer ses faces.",
  "pushPull.hint.pick": "Saisissez une poignée de face, puis faites glisser ou tapez une taille",
  "pushPull.hint.drag": "Faites glisser ou tapez la taille · un clic ou Entrée applique · Échap annule",
  "pushPull.unchanged": "La taille n'a pas changé.",
  "pushPull.face.wallHeight": "Hauteur du mur",
  "pushPull.face.wallThickness": "Épaisseur du mur",
  "pushPull.face.slabThickness": "Épaisseur de la dalle",
  "pushPull.face.length": "Longueur",
  "pushPull.handleAria": "Tirer : {face}",
  "pushPull.bar.readout": "{face} {delta} m",
  "pushPull.bar.snapLevel": "Accroché au niveau d'un plancher",
  "pushPull.bar.snapStep": "Accroché à un pas",
  "align.label": "Aligner",
  "align.hint.reference": "Cliquez sur l'élément sur lequel les autres s'alignent",
  "align.hint.targets": "Cliquez sur les éléments à aligner sur celui-ci",
  "align.hint.commit": "Entrée les aligne · cliquez sur un élément pour l'ajouter ou le retirer · Échap recommence",
  "align.alreadyAligned": "Ils sont déjà alignés sur cette arête.",
  "align.mode.aria": "Arête d'alignement",
  "align.mode.left": "Gauche",
  "align.mode.centre": "Centre",
  "align.mode.right": "Droite",
  "align.mode.top": "Haut",
  "align.mode.middle": "Milieu",
  "align.mode.bottom": "Bas",
  "align.bar.count": "{targets} choisis · {moving} à déplacer",
} satisfies Catalogue;
