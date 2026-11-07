/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, setLocale } from '@/i18n';
import { commandPaletteDe } from '@/i18n/locales/de/command-palette';
import { commandPaletteRu } from '@/i18n/locales/ru/command-palette';
import { paletteSurfaceCommands } from './surface-commands';
import { searchCommands } from './commandPaletteSearch';

for (const [locale, cases] of [
  ['en', [['report error', 'panel:error-report'], ['failed load report', 'panel:error-report'], ['resume recent report', 'panel:error-report'],
    ['location zones', 'panel:properties'], ['tag grouping', 'panel:tree'], ['exploded gap', 'panel:tree'], ['source sync', 'panel:tree'], ['hide others', 'vis:isolate']]],
  ['de', [['Fehler melden', 'panel:error-report'], ['Lagezonen', 'panel:properties'], ['Tag-Gruppierung', 'panel:tree']]],
  ['ru', [['сообщить об ошибке', 'panel:error-report'], ['Зоны расположения', 'panel:properties'], ['синхронизация источника', 'panel:tree']]],
] as const) test(`#8947 ${locale} task phrases rank the canonical report and discovery destinations`, () => {
  try {
    registerLocale('de', commandPaletteDe); registerLocale('ru', commandPaletteRu);
    setLocale(locale);
    const commands = paletteSurfaceCommands({ canEditInSession: true, cesiumAvailable: false }, () => {});
    for (const [query, id] of cases) {
      assert.equal(searchCommands(commands, query, [])[0]?.id, id, query);
    }
  } finally { setLocale('en'); }
});
