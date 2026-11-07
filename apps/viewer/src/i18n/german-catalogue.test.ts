/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredModule } from './__tests__/required-module';
import { registerLocale, setLocale, resolve } from './registry';
import { formatLocaleDate, formatLocaleNumber, parseLocaleNumber } from './intlFormat';
import { catalogueContract } from './__tests__/catalogue-contract';

catalogueContract('German', 'de', () => import('./locales/de').then(module => module.default), [1, 2]);

test('German locale formats real numbers, dates and counted model elements', async () => {
  const de = await requiredModule(() => import('./locales/de').then(module => module.default), 'German shipping catalogue must be available');
  registerLocale('de', de);
  setLocale('de');
  try {
    assert.equal(formatLocaleNumber('de', 1234.5), '1.234,5');
    assert.equal(parseLocaleNumber('de', '1.234,5'), 1234.5);
    assert.equal(formatLocaleDate('de', new Date('2026-11-05T12:00:00Z'),
      { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' }), '5.11.2026');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 1 }), '1 Bauteil');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 2 }), '2 Bauteile');
    // DE-ASTRA-001: the warning counts unchecked models, never identifies model 1.
    assert.match(resolve('semanticAssist.idsSkipsModels', { count: 1 }), /prüft 1 geladenes Modell nicht/);
    assert.match(resolve('semanticAssist.idsSkipsModels', { count: 2 }), /prüft 2 geladene Modelle nicht/);
  } finally { setLocale('en'); }
});
