/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearanceAssignmentListFr = {
  "appearanceAssignmentList.sectionAriaLabel": "Affectations d'apparence",
  "appearanceAssignmentList.heading": "Affectations",
  "appearanceAssignmentList.description": "Les affectations ultérieures remplacent les précédentes pour les éléments communs à plusieurs affectations. Exclure un élément ici conserve toute affectation précédente.",
  "appearanceAssignmentList.assignmentAriaLabel": "Affectation {position} : {sourceName} sur {modelName}",
  "appearanceAssignmentList.moveEarlierAriaLabel": "Avancer l'affectation {position}",
  "appearanceAssignmentList.moveLaterAriaLabel": "Reculer l'affectation {position}",
  "appearanceAssignmentList.removeAriaLabel": "Supprimer l'affectation {position}",
  "appearanceAssignmentList.summary": "{products} · {excluded} · {overridden}",
  "appearanceAssignmentList.summaryProducts": { one: "{count} élément", other: "{count} éléments", many: "{count} d'éléments" },
  "appearanceAssignmentList.summaryExcluded": { one: "{count} exclu", other: "{count} exclus" },
  "appearanceAssignmentList.summaryOverridden": { one: "{count} remplacé par une affectation ultérieure", other: "{count} remplacés par des affectations ultérieures" },
  "appearanceAssignmentList.reviewAriaLabel": "Examiner les éléments de l'affectation {position}",
  "appearanceAssignmentList.reviewButton": "Examiner les éléments et les exceptions",
} satisfies Catalogue;
