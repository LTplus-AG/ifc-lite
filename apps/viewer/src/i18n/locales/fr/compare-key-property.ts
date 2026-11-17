/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const compareKeyPropertyFr = {
  'compareKeyProperty.label': 'Clé de comparaison',
  'compareKeyProperty.placeholder': 'Tag ou Pset.Prop',
  'compareKeyProperty.globalId': 'GlobalId',
  'compareKeyProperty.invalidNote': 'Clé non valide — utilisez Tag ou Pset.Propriété. La comparaison se fait toujours sur {scheme}.',
  'compareKeyProperty.duplicateNote': {
    one: '{count} valeur saisie partagée par plusieurs éléments a été remplacée par le GlobalId : {values}',
    many: '{count} de valeurs saisies partagées par plusieurs éléments ont été remplacées par le GlobalId : {values}',
    other: '{count} valeurs saisies partagées par plusieurs éléments ont été remplacées par le GlobalId : {values}',
  },
} satisfies Catalogue;
