/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const customGroupingDe = {
  "customGrouping.pickGroupingAriaLabel": "Benutzerdefinierte Gruppierung wählen",
  "customGrouping.pickGroupingPlaceholder": "Gruppierung wählen…",
  "customGrouping.noGroupingsYet": "Noch keine benutzerdefinierten Gruppierungen. Erstellen Sie zuerst eine Linse mit benannten Regeln.",
  "customGrouping.unresolvedGrouping": "Die Gruppierung „{name}“ ist hier nicht vorhanden. Die Regel findet keine Treffer, bis Sie eine andere wählen oder sie importieren.",
  "customGrouping.unresolvedGroups": {
    "one": "Die Gruppe {names} ist nicht in dieser Gruppierung enthalten. Die Regel findet bis zur Korrektur keine Treffer.",
    "other": "Die Gruppen {names} sind nicht in dieser Gruppierung enthalten. Die Regel findet bis zur Korrektur keine Treffer."
  }
} satisfies Catalogue;
