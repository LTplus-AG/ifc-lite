/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslationService } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import fr from './locales/fr';
import { activateStartupLocale, createLocaleActivator, createLocaleChoice } from './locale-activation';
import { registerEnglish, setLocale } from './registry';

test('#8891 French Settings choice synchronizes IDS descriptions and later English switching', async () => {
  const html = { lang: 'en' };
  const activator = createLocaleActivator({ fr: async () => fr }, html);
  try {
    const environment = { languages: ['en-US'], storage: null };
    await activateStartupLocale(activator, environment);
    const choice = createLocaleChoice(activator, environment);
    await choice.choose('fr');
    assert.equal(html.lang, 'fr');
    const service = () => createTranslationService(useViewerStore.getState().idsLocale);
    assert.equal(service().t('status.fail'), 'NON CONFORME');
    assert.equal(service().describeFacet({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }, 'requirement'), 'Doit être de type "IFCWALL"');
    // Lazy registration must not reset an explicit IDS locale choice.
    useViewerStore.getState().setIdsLocale('it');
    registerEnglish({});
    assert.equal(service().locale, 'it');
    await choice.choose('en');
    assert.equal(html.lang, 'en');
    assert.equal(service().t('status.fail'), 'FAIL');
    assert.equal(service().describeFacet({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }, 'requirement'), 'Must be of type "IFCWALL"');
  } finally { setLocale('en'); }
});
