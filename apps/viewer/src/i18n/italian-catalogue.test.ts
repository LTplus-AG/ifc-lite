/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredModule } from './__tests__/required-module';
import { registerLocale, setLocale, resolve } from './registry';
import { formatLocaleDate, formatLocaleNumber, parseLocaleNumber } from './intlFormat';
import { catalogueContract } from './__tests__/catalogue-contract';

catalogueContract('Italian', 'it', () => import('./locales/it').then(module => module.default), [0, 0.5, 1, 2, 1.5, 2.5, 1_000_000], true);

test('Italian locale formats real numbers, dates and counted model elements', async () => {
  const it = await requiredModule(() => import('./locales/it').then(module => module.default), 'Italian shipping catalogue must be available');
  registerLocale('it', it);
  setLocale('it');
  try {
    assert.equal(formatLocaleNumber('it', 1234.5), '1234,5');
    assert.equal(parseLocaleNumber('it', '1.234,5'), 1234.5);
    assert.equal(formatLocaleDate('it', new Date('2026-11-05T12:00:00Z'),
      { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' }), '05/11/2026');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 1 }), '1 elemento');
    assert.equal(resolve('appearanceAssignmentList.summaryProducts', { count: 2 }), '2 elementi');
  } finally { setLocale('en'); }
});



// IT-S2-ASTRA-001: Undo reverses changes retained by a cancelled bulk operation.
test('Italian partial cancellation guidance returns to the state before applied edits', async () => {
  const it = await requiredModule(() => import('./locales/it').then(module => module.default), 'Italian shipping catalogue must be available');
  registerLocale('it', it);
  setLocale('it');
  try {
    const warning = resolve('bulkPropertyEditor.cancelledAfter', { done: 500, total: 1000 });
    assert.match(warning, /500 di 1000 entità/);
    assert.match(warning, /Annulla annulla le modifiche già applicate/);
    assert.doesNotMatch(warning, /ripristina le modifiche già applicate/i);
  } finally { setLocale('en'); }
});

// IT-S3-ASTRA-003: count-safe composition with a real runtime storey name or fallback.
test('Italian copy summary composes counts and untouched model names without su il', async () => {
  const it = await requiredModule(() => import('./locales/it').then(module => module.default), 'Italian shipping catalogue must be available');
  registerLocale('it', it); setLocale('it');
  try {
    for (const count of [1, 3]) {
      for (const storey of ['00 groundfloor', resolve('modelAuthoring.sourceStorey')]) {
        const text = resolve('modelAuthoring.copied', { count, placement: '0,5 m', storey });
        assert.ok(text.startsWith(`Nuove copie radice: ${count} · 0,5 m · piano: ${storey};`));
        assert.doesNotMatch(text, /su il|1 nuove copie/);
      }
    }
    assert.equal(resolve('changesPanel.revert'), 'Annulla modifica');
    assert.equal(resolve('flowAssistant.openFlow'), `Apri in ${resolve('flowPanel.title')}`);
    assert.equal(resolve('assistantReuse.openGraph'), `Apri in ${resolve('flowPanel.title')}`);
  } finally { setLocale('en'); }
});
