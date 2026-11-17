/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearanceAssignmentListDe = {
  'appearanceAssignmentList.sectionAriaLabel': 'Darstellungszuweisungen',
  'appearanceAssignmentList.heading': 'Zuweisungen',
  'appearanceAssignmentList.description':
    'Spätere Zuweisungen ersetzen frühere bei überlappenden Bauteilen. Wird ein Bauteil hier ausgeschlossen, bleibt eine frühere Zuweisung erhalten.',
  'appearanceAssignmentList.assignmentAriaLabel': 'Zuweisung {position}: {sourceName} auf {modelName}',
  'appearanceAssignmentList.moveEarlierAriaLabel': 'Zuweisung {position} nach vorne verschieben',
  'appearanceAssignmentList.moveLaterAriaLabel': 'Zuweisung {position} nach hinten verschieben',
  'appearanceAssignmentList.removeAriaLabel': 'Zuweisung {position} entfernen',
  'appearanceAssignmentList.summary': '{products} · {excluded} · {overridden}',
  'appearanceAssignmentList.summaryProducts': { one: '{count} Bauteil', other: '{count} Bauteile' },
  'appearanceAssignmentList.summaryExcluded': { one: '{count} ausgeschlossen', other: '{count} ausgeschlossen' },
  'appearanceAssignmentList.summaryOverridden': {
    one: '{count} durch eine spätere Zuweisung ersetzt',
    other: '{count} durch spätere Zuweisungen ersetzt',
  },
  'appearanceAssignmentList.reviewAriaLabel': 'Bauteile für Zuweisung {position} prüfen',
  'appearanceAssignmentList.reviewButton': 'Bauteile und Ausnahmen prüfen',
} satisfies Catalogue;
