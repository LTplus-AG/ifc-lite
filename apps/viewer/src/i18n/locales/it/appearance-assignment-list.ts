/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearanceAssignmentListIt = {
  "appearanceAssignmentList.sectionAriaLabel": "Assegnazioni di aspetto",
  "appearanceAssignmentList.heading": "Assegnazioni",
  "appearanceAssignmentList.description": "Le assegnazioni successive sostituiscono quelle precedenti sugli elementi sovrapposti. Escludere un elemento qui mantiene un'eventuale assegnazione precedente.",
  "appearanceAssignmentList.assignmentAriaLabel": "Assegnazione {position}: {sourceName} su {modelName}",
  "appearanceAssignmentList.moveEarlierAriaLabel": "Sposta l'assegnazione {position} prima",
  "appearanceAssignmentList.moveLaterAriaLabel": "Sposta l'assegnazione {position} dopo",
  "appearanceAssignmentList.removeAriaLabel": "Rimuovi l'assegnazione {position}",
  "appearanceAssignmentList.summary": "{products} · {excluded} · {overridden}",
  "appearanceAssignmentList.summaryProducts": { one: "{count} elemento", other: "{count} elementi", many: "{count} elementi" },
  "appearanceAssignmentList.summaryExcluded": { one: "{count} escluso", other: "{count} esclusi", many: "{count} esclusi" },
  "appearanceAssignmentList.summaryOverridden": {
    one: "{count} sostituito da un'assegnazione successiva",
    other: "{count} sostituiti da assegnazioni successive",
    many: "{count} sostituiti da assegnazioni successive",
  },
  "appearanceAssignmentList.reviewAriaLabel": "Controlla gli elementi dell'assegnazione {position}",
  "appearanceAssignmentList.reviewButton": "Controlla elementi ed eccezioni",
} satisfies Catalogue;
