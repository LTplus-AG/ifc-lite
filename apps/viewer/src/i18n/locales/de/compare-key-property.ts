/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const compareKeyPropertyDe = {
  "compareKeyProperty.label": "Abgleichen über",
  "compareKeyProperty.placeholder": "Tag oder Pset.Prop",
  "compareKeyProperty.globalId": "GlobalId",
  "compareKeyProperty.invalidNote": "Kein gültiger Schlüssel – verwenden Sie Tag oder Pset.Property. Der Vergleich erfolgt weiterhin über {scheme}.",
  "compareKeyProperty.duplicateNote": {"one": "Bei 1 angegebenen Wert, den mehrere Bauteile teilen, wurde auf GlobalId zurückgegriffen: {values}", "other": "Bei {count} angegebenen Werten, die mehrere Bauteile teilen, wurde auf GlobalId zurückgegriffen: {values}"},
} satisfies Catalogue;
