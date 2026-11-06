/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { getLocale, registerLocale, setLocale } from '@/i18n';
import { resolve as t } from '@/i18n/registry';
import { commandPaletteDe } from '@/i18n/locales/de/command-palette';
import { commandPaletteRu } from '@/i18n/locales/ru/command-palette';
import { paletteSurfaceCommands } from './surface-commands';
import { searchCommands } from './commandPaletteSearch';

const initialLocale = getLocale();
afterEach(() => setLocale(initialLocale));
const cases = [
  ['en', 'saved conversations', 'panel:assistant'],
  ['en', 'project preferences', 'panel:assistant'],
  ['en', 'proposal review', 'panel:assistant'],
  ['en', 'projection mapping', 'panel:semantic'],
  ['en', 'restore workspace', 'panel:semantic'],
  ['en', 'import script', 'panel:script'],
  ['en', 'export script', 'panel:script'],
  ['en', 'promote to tool', 'panel:script'],
  ['de', 'Vorschläge prüfen', 'panel:assistant'],
  ['de', 'Identität', 'panel:semantic'],
  ['de', 'Als Werkzeug bereitstellen', 'panel:script'],
  ['ru', 'Проверка предложений', 'panel:assistant'],
  ['ru', 'Идентификация', 'panel:semantic'],
  ['ru', 'Создать инструмент', 'panel:script'],
] as const;
for (const [locale, query, destination] of cases) {
  it(`#8947 task query ${locale}:${query} finds its real workflow home first`, () => {
    registerLocale('de', commandPaletteDe); registerLocale('ru', commandPaletteRu); setLocale(locale);
    const rows = paletteSurfaceCommands({ canEditInSession: true }, () => {});
    const matches = searchCommands(rows, query, []);
    assert.equal(matches[0]?.id, destination);
    assert.ok(matches[0].detailKey, 'destination explains which child controls it contains');
    assert.notEqual(t(matches[0].detailKey), matches[0].detailKey, 'visible path resolves in the active catalogue');
    // A proposal query still opens the review home, never an unconditional Apply command.
    assert.equal(matches[0].category, 'Panels');
  });
}
