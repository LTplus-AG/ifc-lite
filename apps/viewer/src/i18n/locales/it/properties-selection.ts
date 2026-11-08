/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const propertiesSelectionIt = {
  "properties.copy.valueLabel": "Copia {name}",
  "properties.copy.valueTooltip": "Copia {name} (Shift o pressione prolungata: copia nome=valore)",
  "properties.copy.copied": "Copiato negli appunti",
  "properties.copy.failed": "Impossibile copiare negli appunti",
  "properties.summary.elementCount": {
    "one": "{countDisplay} elemento",
    "other": "{countDisplay} elementi",
    "many": "{countDisplay} elementi"
  },
  "properties.summary.byClassHeading": "Per classe",
  "properties.summary.byModelHeading": "Per modello",
  "properties.summary.elementsHeading": "Elementi",
  "properties.summary.attributesHeading": "Attributi condivisi",
  "properties.summary.propertiesHeading": "Proprietà condivise",
  "properties.summary.quantitiesHeading": "Quantità condivise",
  "properties.summary.varies": {
    "one": "(varia: {countDisplay} valore)",
    "other": "(varia: {countDisplay} valori)",
    "many": "(varia: {countDisplay} valori)"
  },
  "properties.summary.noShared": "Gli elementi selezionati non condividono proprietà o quantità",
  "properties.summary.selectOnly": "Seleziona solo {name}",
  "properties.summary.moreElements": {
    "one": "{countDisplay} altro elemento",
    "other": "{countDisplay} altri elementi",
    "many": "{countDisplay} altri elementi"
  },
  "properties.summary.valuesCapped": "Valori confrontati sui primi {limit} elementi su {total}"
} satisfies Catalogue;
