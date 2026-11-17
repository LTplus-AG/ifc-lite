/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const alignmentSectionFr = {
  "alignmentSection.mode": "Alignement",
  "alignmentSection.model": "Modèle d'alignement",
  "alignmentSection.axis": "Choisir un IfcAlignment",
  "alignmentSection.axisFallback": "IfcAlignment #{id}",
  "alignmentSection.noAxes": "Aucun IfcAlignment",
  "alignmentSection.loading": "Résolution de l'alignement…",
  "alignmentSection.distance": "Distance horizontale depuis le début",
  "alignmentSection.approximate": "Courbe approximative · distance depuis le début",
  "alignmentSection.help": "La distance est mesurée géométriquement en mètres horizontaux depuis le début physique ; ce n'est pas le chaînage saisi. Le plan suit la tangente évaluée. Déplacer le plan le détache de l'alignement ; choisissez à nouveau l'alignement pour reprendre.",
  "alignmentSection.error": "Impossible de couper cet alignement : {detail}",
} satisfies Catalogue;
