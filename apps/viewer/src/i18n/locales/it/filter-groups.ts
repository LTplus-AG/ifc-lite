/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const filterGroupsIt = {
  "filterGroups.addGroup": "Aggiungi gruppo",
  "filterGroups.addGroupTitle": "Aggiungi un altro gruppo OR: \"+\" nel testo del selettore",
  "filterGroups.tabsAriaLabel": "Gruppi di filtri",
  "filterGroups.groupLabel": "Gruppo {index}",
  "filterGroups.removeGroupAriaLabel": "Rimuovi il gruppo {index}",
  "filterGroups.noRules": "Nessuna regola: aggiungine una per eseguire.",
  "filterGroups.ruleCount": { one: "{count} regola", other: "{count} regole", many: "{count} regole" },
  "filterGroups.groupCountOr": { one: "{count} gruppo (OR)", other: "{count} gruppi (OR)", many: "{count} gruppi (OR)" },
  "filterGroups.limit": "limite",
  "filterGroups.readbackTitle": "Il filtro attuale come testo del selettore: un secondo gruppo (Aggiungi gruppo, sotto) compare qui unito con \"+\".",
} satisfies Catalogue;
