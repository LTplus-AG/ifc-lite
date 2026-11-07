/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCatalogueRecord } from './catalogue-problems';
import { registerEnglish, registerLocale, resolve, setLocale, type Catalogue } from './registry';
import { requiredModule } from './__tests__/required-module';
import type { TranslationKey } from './en';

// #8908: users must not receive contradictory Safari minimums across failure surfaces.
test('#8908 Safari WebGPU minimum agrees across source and translated failure guidance', async () => {
  const keys: TranslationKey[] = [
    'viewportLighting.container.emptyState.webgpuBanner.supportedBrowsers',
    'viewportLighting.viewport.renderFailed.browserHint',
    'webgpuTroubleshooting.noApi.olderBrowser',
  ];
  try {
    for (const locale of ['en', 'de', 'fr', 'it', 'ru']) {
      const catalogue: Catalogue = {};
      for (const feature of ['viewport-lighting', 'webgpu-troubleshooting']) {
        const source = locale === 'en' ? `./catalogues/${feature}.en.ts` : `./locales/${locale}/${feature}.ts`;
        const module: Record<string, unknown> = await requiredModule(
          () => import(new URL(source, import.meta.url).href), `${locale}/${feature}: browser guidance required`);
        for (const value of Object.values(module)) {
          if (isCatalogueRecord(value)) Object.assign(catalogue, value);
        }
      }
      if (locale === 'en') registerEnglish(catalogue);
      else registerLocale(locale, catalogue);
      setLocale(locale);
      for (const key of keys) {
        assert.equal(resolve(key).match(/Safari\s+(\d+)/)?.[1], '26', `${locale}: ${key}`);
      }
    }
  } finally { setLocale('en'); }
});
