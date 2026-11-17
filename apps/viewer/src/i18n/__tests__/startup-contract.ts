/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { requiredModule } from './required-module';
import { test } from 'node:test';
import type { Catalogue } from '../registry';
import { retainedGeometryEn } from '../catalogues/retained-geometry.en';
import { checkCatalogue } from '../catalogue-problems';
import { activateStartupLocale, createLocaleActivator, LOCALE_STORAGE_KEY } from '../locale-activation';
import { englishCatalogue } from '../en';
import { hasActiveTranslation, registerEnglish, resolve, setLocale } from '../registry';
import type { TranslationKey } from '../en';
import { messageParameters } from './message-parameters';
import { lazyMessageParameters } from '../lazy-catalogue-shape';

export function startupContract(name: string, locale: string, loadCatalogue: () => Promise<Catalogue>): void {
  test(`${name} startup retains lazy translations before and after English feature registration`, async () => {
    const catalogue = await requiredModule(loadCatalogue, `${name} shipping catalogue must be available`);
    // Regression coverage inherited from German integration: preregistration masked 98 drops.
    assert.equal(Object.hasOwn(englishCatalogue, 'retainedGeometry.shapeOnlyReason'), false);
    assert.deepEqual(checkCatalogue(catalogue).problems, []);
    const html = { lang: 'en' };
    try {
      const storage = new Map<string, string>([[LOCALE_STORAGE_KEY, locale]]);
      await activateStartupLocale(createLocaleActivator({ [locale]: async () => catalogue }, html), {
        languages: [],
        storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: (key) => { storage.delete(key); } },
      });
      assert.equal(html.lang, locale);
      for (const key of Object.keys(catalogue)) assert.ok(hasActiveTranslation(key as TranslationKey), key);
      for (const [key, message] of Object.entries(retainedGeometryEn)) {
        const parameters = messageParameters(message);
        assert.deepEqual(lazyMessageParameters(key), parameters, key);
        assert.ok(hasActiveTranslation(key as keyof typeof retainedGeometryEn), key);
      }
      const before = resolve('retainedGeometry.shapeOnlyReason');
      assert.equal(before, catalogue['retainedGeometry.shapeOnlyReason']);
      assert.notEqual(before, retainedGeometryEn['retainedGeometry.shapeOnlyReason']);
      registerEnglish(retainedGeometryEn);
      assert.equal(resolve('retainedGeometry.shapeOnlyReason'), before);
    } finally { setLocale('en'); }
  });
}
