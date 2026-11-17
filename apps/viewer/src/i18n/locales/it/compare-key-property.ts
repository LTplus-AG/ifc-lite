/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const compareKeyPropertyIt = {
  'compareKeyProperty.label': 'Chiave su',
  'compareKeyProperty.placeholder': 'Tag o Pset.Prop',
  'compareKeyProperty.globalId': 'GlobalId',
  'compareKeyProperty.invalidNote': 'Chiave non valida: usa Tag o Pset.Property. Il confronto continua su {scheme}.',
  'compareKeyProperty.duplicateNote': {
    one: '1 valore inserito, condiviso da più elementi, è ripiegato su GlobalId: {values}',
    many: '{count} valori inseriti, condivisi da più elementi, sono ripiegati su GlobalId: {values}',
    other: '{count} valori inseriti, condivisi da più elementi, sono ripiegati su GlobalId: {values}',
  },
} satisfies Catalogue;
