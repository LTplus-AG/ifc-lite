/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { TranslationKey, TranslationParameters } from '@/i18n';
import { styleInterpolatedValues } from './richInterpolate.js';

test('rich interpolation styles every exact placeholder occurrence', () => {
  const styled = createElement('strong', null, '⋮');
  const t = (_key: TranslationKey, params?: TranslationParameters) =>
    `Use ${String(params?.menu)} twice: ${String(params?.menu)} (${String(params?.scope)})`;
  const nodes = styleInterpolatedValues(t, 'lists.groupingBar.noGrouping', [['menu', styled]], {
    scope: 'columns',
  });

  assert.equal(nodes.filter((node) => node === styled).length, 2);
  assert.equal(nodes.filter((node) => typeof node === 'string').join(''), 'Use  twice:  (columns)');
});
