/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const customGroupingIt = {
  "customGrouping.pickGroupingAriaLabel": "Scegli un raggruppamento personalizzato",
  "customGrouping.pickGroupingPlaceholder": "Scegli raggruppamento…",
  "customGrouping.noGroupingsYet": "Nessun raggruppamento personalizzato finora. Crea prima una Lens con regole denominate.",
  "customGrouping.unresolvedGrouping": "Il raggruppamento \"{name}\" non esiste qui. La regola non corrisponde a nulla finché non ne scegli un altro o lo importi.",
  "customGrouping.unresolvedGroups": {
    "one": "Il gruppo {names} non è in questo raggruppamento. La regola non corrisponde a nulla finché il problema non viene corretto.",
    "other": "I gruppi {names} non sono in questo raggruppamento. La regola non corrisponde a nulla finché il problema non viene corretto.",
    "many": "I gruppi {names} non sono in questo raggruppamento. La regola non corrisponde a nulla finché il problema non viene corretto."
  }
} satisfies Catalogue;
