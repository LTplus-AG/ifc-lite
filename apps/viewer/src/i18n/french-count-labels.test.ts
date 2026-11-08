/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerLocale, resolve, setLocale } from './registry';
import { propertiesPanelFr } from './locales/fr/properties-panel';
import { sectionPlanesFr } from './locales/fr/section-planes';
import { shellChromeFr } from './locales/fr/shell-chrome';
import { sheetsPdfFr } from './locales/fr/sheets-pdf';

test('#8904 French property, quantity and section counts distinguish one from multiple', () => {
  registerLocale('fr', { ...propertiesPanelFr, ...sectionPlanesFr, ...shellChromeFr, ...sheetsPdfFr });
  setLocale('fr');
  try {
    for (const key of ['properties.panel.multiEntity.propertySetsCount', 'properties.panel.multiEntity.quantitySetsCount'] as const) {
      assert.equal(resolve(key, { count: 1 }), '1 jeu');
      assert.equal(resolve(key, { count: 2 }), '2 jeux');
      assert.equal(resolve(key, { count: 1_000_000 }), '1000000 jeux');
    }
    assert.equal(resolve('sectionPlanes.views.planeCount', { count: 1 }), '1 plan');
    assert.equal(resolve('sectionPlanes.views.planeCount', { count: 2 }), '2 plans');
    assert.equal(resolve('sectionPlanes.parked.count', { count: 1 }), '1 coupe');
    assert.equal(resolve('sectionPlanes.parked.count', { count: 2 }), '2 coupes');
    assert.equal(resolve('shellChrome.activityBar.showAllPanels', { count: 1 }), 'Afficher tous les panneaux (1 masqué)');
    assert.equal(resolve('shellChrome.activityBar.showAllPanels', { count: 2 }), 'Afficher tous les panneaux (2 masqués)');
    assert.equal(resolve('shellChrome.statusBar.hiddenCount', { count: 1 }), '1 masqué');
    assert.equal(resolve('shellChrome.statusBar.hiddenCount', { count: 2 }), '2 masqués');
    assert.equal(resolve('sheetsPdf.sheetSetup.fieldsConfigured', { count: 1 }), '1 champ configuré');
    assert.equal(resolve('sheetsPdf.sheetSetup.fieldsConfigured', { count: 2 }), '2 champs configurés');
  } finally { setLocale('en'); }
});
