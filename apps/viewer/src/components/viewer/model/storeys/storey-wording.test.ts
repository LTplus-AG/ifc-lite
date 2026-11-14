/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getLocale, registerLocale, resolve, setLocale } from '@/i18n/registry';
import { storeyManagerRu } from '@/i18n/locales/ru/storey-manager';

it('#9389 the Russian copy range ends at До этажа', () => {
  const previous = getLocale();
  registerLocale('ru', storeyManagerRu);
  try {
    setLocale('ru');
    assert.equal(resolve('storeyManager.copy.to'), 'До этажа');
  } finally { setLocale(previous); }
});
