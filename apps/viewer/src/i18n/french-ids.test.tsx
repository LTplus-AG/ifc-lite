/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslationService } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import fr from './locales/fr';
import { activateStartupLocale, createLocaleActivator } from './locale-activation';
import { registerEnglish, setLocale } from './registry';

test('French startup synchronizes IDS descriptions and later English switching', async () => {
  const html = { lang: 'en' };
  const activator = createLocaleActivator({ fr: async () => fr }, html);
  try {
    await activateStartupLocale(activator, { search: '?lang=fr', languages: [], storage: null });
    const service = () => createTranslationService(useViewerStore.getState().idsLocale);
    assert.equal(service().t('status.fail'), 'NON CONFORME');
    assert.match(service().describeFacet({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }, 'requirement'), /IFCWALL/);
    // Lazy registration must not reset an explicit IDS locale choice.
    useViewerStore.getState().setIdsLocale('it');
    registerEnglish({});
    assert.equal(service().locale, 'it');
    await activator.activate(['en']);
    assert.equal(service().t('status.fail'), 'FAIL');
  } finally { setLocale('en'); }
});
