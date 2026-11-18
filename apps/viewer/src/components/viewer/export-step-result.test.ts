/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { toast } from '@/components/ui/toast';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { registerLocale, resolve, setLocale } from '@/i18n/registry';
import { geometryExportDialogsDe } from '@/i18n/locales/de/geometry-export-dialogs';
import { geometryExportDialogsFr } from '@/i18n/locales/fr/geometry-export-dialogs';
import { geometryExportDialogsIt } from '@/i18n/locales/it/geometry-export-dialogs';
import { geometryExportDialogsRu } from '@/i18n/locales/ru/geometry-export-dialogs';
import { stepExportResult } from './export-step-result';

afterEach(() => { setLocale('en'); mock.restoreAll(); });

const catalogues = { de: geometryExportDialogsDe, fr: geometryExportDialogsFr, it: geometryExportDialogsIt, ru: geometryExportDialogsRu };

function message(locale: 'en' | keyof typeof catalogues, count: number) {
  if (locale !== 'en') registerLocale(locale, catalogues[locale]);
  setLocale(locale);
  const info = mock.method(toast, 'info', () => {});
  const result = stepExportResult('Exported', Array.from({ length: count }, (_, i) => `w${i}`), resolve);
  assert.equal(info.mock.calls[0].arguments[0], result.message);
  info.mock.restore();
  return result.message;
}

const n = formatLocaleNumber;

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

test('#10606 equal warning lines all count and a summary ending in a period gets no second one', () => {
  const info = mock.method(toast, 'info', () => {});
  const result = stepExportResult('Left out: annex.ifc.', ['same', 'same', 'other'], resolve);
  assert.equal(result.message, 'Left out: annex.ifc. 3 warnings');
  assert.deepEqual(result.warnings, ['same', 'same', 'other']);
  assert.equal(info.mock.callCount(), 1);
});

test('#10606 every locale spells each CLDR plural category of the warning count', () => {
  const key = 'geometryExport.shell.warningsSummary';
  for (const [locale, catalogue] of Object.entries(catalogues)) {
    const forms = catalogue[key] as Record<string, string>;
    for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      assert.ok(forms[category], `${locale} ${key} lacks the "${category}" form`);
    }
  }
});
