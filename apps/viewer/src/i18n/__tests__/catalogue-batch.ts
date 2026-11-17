/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalogue, isCatalogueRecord } from '../catalogue-problems';
import { registerEnglish, registerLocale, resolve, setLocale, type Catalogue } from '../registry';
import type { TranslationKey } from '../en';
import { mergeEnglishEntries } from './merge-english';
import { messageParameters } from './message-parameters';
import { requiredModule } from './required-module';

function exportedCatalogue(module: Record<string, unknown>, source: string): Catalogue {
  const catalogue: Catalogue = {};
  for (const value of Object.values(module)) {
    if (isCatalogueRecord(value)) mergeEnglishEntries(catalogue, value, source);
  }
  assert.ok(Object.keys(catalogue).length > 0, `${source}: catalogue must contain messages`);
  return catalogue;
}

/** Validate dormant feature data without installing a startup locale entry. */
export function catalogueBatchContract(locale: string, pr: number, features: readonly string[]): void {
  for (const feature of features) {
    test(`#${pr} ${locale}/${feature} covers English messages and resolves their parameters`, async () => {
      // Import inside the test: reverting an added data file must reach ERR_ASSERTION.
      const catalogue = await requiredModule(async () => exportedCatalogue(
        await import(new URL(`../locales/${locale}/${feature}.ts`, import.meta.url).href), feature),
      `${locale}/${feature}: production catalogue must be available`);
      const english = exportedCatalogue(
        await import(new URL(`../catalogues/${feature}.en.ts`, import.meta.url).href), feature);
      assert.deepEqual(Object.keys(catalogue).sort(), Object.keys(english).sort());
      registerEnglish(english);
      assert.deepEqual(checkCatalogue(catalogue).problems, []);
      registerLocale(locale, catalogue);
      setLocale(locale);
      try {
        for (const [key, source] of Object.entries(english)) {
          const names = messageParameters(source).filter(name => name !== 'count');
          const parameters = Object.fromEntries(names.map(name => [name, `SENTINEL_${name}`]));
          for (const count of [0, 1, 2, 5, 1_000_000]) {
            const rendered = resolve(key as TranslationKey, { ...parameters, count });
            for (const name of names) assert.ok(rendered.includes(`SENTINEL_${name}`), `${key}: ${name}`);
            assert.doesNotMatch(rendered, /\{[A-Za-z][A-Za-z0-9_]*\}/, key);
          }
        }
      } finally { setLocale('en'); }
    });
  }
}
