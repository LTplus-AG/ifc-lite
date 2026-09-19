/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const compareKeyPropertyEn = {
  'compareKeyProperty.label': 'Key on',
  'compareKeyProperty.placeholder': 'Tag or Pset.Prop',
  'compareKeyProperty.globalId': 'GlobalId',
  'compareKeyProperty.invalidNote': 'Not a valid key — use Tag or Pset.Property. Still comparing on {scheme}.',
  'compareKeyProperty.duplicateNote': {
    one: '1 authored value shared by several elements fell back to GlobalId: {values}',
    other: '{count} authored values shared by several elements fell back to GlobalId: {values}',
  },
} as const satisfies Record<string, TranslationValue>;
