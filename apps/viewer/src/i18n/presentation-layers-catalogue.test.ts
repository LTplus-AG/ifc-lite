/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredModule } from './__tests__/required-module';
import { isCatalogueRecord, checkCatalogue } from './catalogue-problems';

for (const [locale, expected] of [['en', 'Presentation layers'], ['de', 'Darstellungsebenen'],
  ['fr', 'Calques de présentation'], ['it', 'Layer di presentazione'], ['ru', 'Слои представления']]) {
  test(`#9273 ${locale} owns the inspector presentation-layers heading`, async () => {
    const path = locale === 'en' ? './catalogues/properties-panel.en.ts' : `./locales/${locale}/properties-panel.ts`;
    const module = await requiredModule(() => import(new URL(path, import.meta.url).href), `${locale} inspector catalogue exists`);
    const catalogues = Object.values(module).filter(isCatalogueRecord);
    const value = catalogues.map(catalogue => catalogue['properties.panel.presentationLayersHeading']).find(Boolean);
    assert.equal(value, expected);
    for (const key of ['properties.panel.presentationLayersLoadError', 'properties.panel.presentationLayersRetry']) {
      assert.ok(catalogues.some(catalogue => typeof catalogue[key] === 'string' && String(catalogue[key]).length > 0), key);
    }
    for (const catalogue of catalogues) assert.deepEqual(checkCatalogue(catalogue).problems, []);
  });
}
