/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { toast } from '@/components/ui/toast';
import { registerLocale, resolve, setLocale } from '@/i18n/registry';
import { geometryExportDialogsDe } from '@/i18n/locales/de/geometry-export-dialogs';
import { geometryExportDialogsFr } from '@/i18n/locales/fr/geometry-export-dialogs';
import { geometryExportDialogsIt } from '@/i18n/locales/it/geometry-export-dialogs';
import { geometryExportDialogsRu } from '@/i18n/locales/ru/geometry-export-dialogs';
import { stepExportResult } from './export-step-result';

afterEach(() => { setLocale('en'); mock.restoreAll(); });

function message(locale: 'en' | 'de' | 'fr' | 'it' | 'ru', count: number) {
  if (locale === 'de') registerLocale('de', geometryExportDialogsDe);
  if (locale === 'fr') registerLocale('fr', geometryExportDialogsFr);
  if (locale === 'it') registerLocale('it', geometryExportDialogsIt);
  if (locale === 'ru') registerLocale('ru', geometryExportDialogsRu);
  setLocale(locale);
  const info = mock.method(toast, 'info', () => {});
  const result = stepExportResult('Exported', Array.from({ length: count }, (_, i) => `w${i}`), resolve);
  assert.equal(info.mock.calls[0].arguments[0], result.message);
  info.mock.restore();
  return result.message;
}

const n = (locale: string, value: number) => new Intl.NumberFormat(locale).format(value);

test('#10606 STEP warning toasts join with a period and format the count for the locale', () => {
  assert.equal(message('en', 1), 'Exported. 1 warning');
  assert.equal(message('en', 1_234), 'Exported. 1,234 warnings');
  assert.equal(message('de', 1_234), `Exported. ${n('de', 1_234)} Warnungen`);
  // CLDR: fr and it select `many` for 1 000 000; ru has one/few/many.
  assert.equal(message('fr', 1_000_000), `Exported. ${n('fr', 1_000_000)} avertissements`);
  assert.equal(message('it', 1_000_000), `Exported. ${n('it', 1_000_000)} avvisi`);
  assert.equal(message('ru', 1), 'Exported. 1 предупреждение');
  assert.equal(message('ru', 3), 'Exported. 3 предупреждения');
  assert.equal(message('ru', 5), 'Exported. 5 предупреждений');
  assert.equal(message('ru', 1_234), `Exported. ${n('ru', 1_234)} предупреждения`);
});

test('#10606 every locale spells each CLDR plural category of the warning count', () => {
  const key = 'geometryExport.shell.warningsSummary';
  for (const [locale, catalogue] of [['de', geometryExportDialogsDe], ['fr', geometryExportDialogsFr], ['it', geometryExportDialogsIt], ['ru', geometryExportDialogsRu]] as const) {
    const forms = catalogue[key] as Record<string, string>;
    for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      assert.ok(forms[category], `${locale} ${key} lacks the "${category}" form`);
    }
  }
});
