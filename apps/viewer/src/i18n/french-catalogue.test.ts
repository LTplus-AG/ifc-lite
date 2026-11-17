/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredModule } from './__tests__/required-module';
import { registerLocale, setLocale, resolve } from './registry';
import { formatLocaleDate, formatLocaleNumber, parseLocaleNumber } from './intlFormat';
import { catalogueContract } from './__tests__/catalogue-contract';

catalogueContract('French', 'fr', () => import('./locales/fr').then(module => module.default), [0, 0.5, 1, 2, 1.5, 2.5, 1_000_000]);

test('French locale formats real numbers, dates and counted model elements', async () => {
  const fr = await requiredModule(() => import('./locales/fr').then(module => module.default), 'French shipping catalogue must be available');
  registerLocale('fr', fr);
  setLocale('fr');
  try {
    assert.equal(formatLocaleNumber('fr', 1234.5), '1\u202f234,5');
    assert.equal(parseLocaleNumber('fr', '1\u202f234,5'), 1234.5);
    assert.equal(formatLocaleDate('fr', new Date('2026-11-05T12:00:00Z'),
      { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' }), '05/11/2026');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 0 }), '0 élément');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 1 }), '1 élément');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 2 }), '2 éléments');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 1_000_000 }), '1000000 d’éléments'.replace('’', "'"));
    // Parent adversarial review: count means the number of unchecked models.
    assert.match(resolve('semanticAssist.idsSkipsModels', { count: 2 }), /ne vérifie pas 2 modèles chargés/);
  } finally { setLocale('en'); }
});



// FR-ASTRA-001: Undo reverses changes retained by a cancelled bulk operation.
test('French partial cancellation guidance returns to the state before applied edits', async () => {
  const fr = await requiredModule(() => import('./locales/fr').then(module => module.default), 'French shipping catalogue must be available');
  registerLocale('fr', fr);
  setLocale('fr');
  try {
    const warning = resolve('bulkPropertyEditor.cancelledAfter', { done: 500, total: 1000 });
    assert.match(warning, /500 entités sur 1000/);
    assert.match(warning, /revenir à l’état précédant les modifications déjà appliquées/);
  } finally { setLocale('en'); }
});
