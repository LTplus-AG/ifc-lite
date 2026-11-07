/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredModule } from '@/i18n/__tests__/required-module';
import { checkAuthoringEn } from '@/i18n/catalogues/check-authoring.en';
import { documentEn } from '@/i18n/catalogues/document.en';
import { registerEnglish, registerLocale, resolve, setLocale } from '@/i18n/registry';

test('#8890 report previews translate all row modes with one and multiple rows', async () => {
  const { liveRowsText } = await requiredModule(() => import('./live-rows-text'), '#8890 translated preview formatter');
  const de = await requiredModule(() => import('@/i18n/locales/de').then(module => module.default), '#8890 German catalogue');
  registerEnglish({ ...checkAuthoringEn, ...documentEn });
  setLocale('en');
  for (const count of [1, 2]) {
    assert.equal(liveRowsText(resolve, 'failed', count, 'spec-0'),
      `live: ${count} ${count === 1 ? 'row' : 'rows'} now for spec-0 (selection: Failed entities)`);
  }
  registerLocale('de', de);
  setLocale('de');
  try {
    const modes = { failed: 'Fehlgeschlagene Entitäten', passed: 'Bestandene Entitäten',
      all: 'Alle Entitäten', sets: 'Mengen (Einzigartigkeit / Aggregat)' } as const;
    for (const [mode, label] of Object.entries(modes)) {
      for (const count of [1, 2]) {
        assert.equal(liveRowsText(resolve, mode as keyof typeof modes, count, 'jede Prüfung'),
          `aktuell: ${count} ${count === 1 ? 'Zeile' : 'Zeilen'} für jede Prüfung (Auswahl: ${label})`);
      }
    }
  } finally { setLocale('en'); }
});
