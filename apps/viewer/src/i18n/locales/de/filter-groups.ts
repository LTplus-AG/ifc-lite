/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterGroupsDe = {
  'filterGroups.addGroup': 'Gruppe hinzufügen',
  'filterGroups.addGroupTitle': 'Weitere ODER-Gruppe hinzufügen – „+“ im Selektortext',
  'filterGroups.tabsAriaLabel': 'Filtergruppen',
  'filterGroups.groupLabel': 'Gruppe {index}',
  'filterGroups.removeGroupAriaLabel': 'Gruppe {index} entfernen',
  'filterGroups.noRules': 'Keine Regeln – fügen Sie eine hinzu, um den Filter auszuführen.',
  'filterGroups.ruleCount': { one: '{count} Regel', other: '{count} Regeln' },
  'filterGroups.groupCountOr': { one: '{count} Gruppe (ODER)', other: '{count} Gruppen (ODER)' },
  'filterGroups.limit': 'Limit',
  'filterGroups.readbackTitle':
    'Der aktuelle Filter als Selektortext – eine zweite Gruppe (Gruppe hinzufügen, unten) erscheint hier mit „+“ verbunden.',
} satisfies Catalogue;
