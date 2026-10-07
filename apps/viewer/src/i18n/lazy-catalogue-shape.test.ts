/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCatalogue } from './catalogue-problems';
import { englishCatalogue } from './en';
import { reviewWorkspaceEn } from './catalogues/review-workspace.en';
import { semanticAssistEn } from './catalogues/semantic-assist.en';
import { lazyMessageParameters } from './lazy-catalogue-shape';

test('#7000 Semantic translations validate at startup before their English panel copy loads', () => {
  assert.equal(Object.hasOwn(englishCatalogue, 'semanticAssist.queryRan'), false);
  const raw = { 'semanticAssist.queryRan': 'Abfrage {source} um {time}',
    'semanticAssist.pickTexts': { one: '{count} Fund', other: '{count} Funde' } };
  assert.deepEqual(checkCatalogue(raw), { catalogue: raw, problems: [] });
  assert.equal(checkCatalogue({ 'semanticAssist.queryRan': 'Abfrage {wrong}' }).catalogue['semanticAssist.queryRan'], undefined);
  assert.match(checkCatalogue({ 'semanticAssist.unknown': 'Unbekannt' }).problems.join(), /not an English catalogue key/);
});

test('#7000 lazy validation metadata matches every real Semantic message and its parameters', () => {
  for (const [key, value] of Object.entries(semanticAssistEn)) {
    const forms = typeof value === 'string' ? [value] : Object.values(value);
    const parameters = [...new Set(forms.flatMap(form => [...form.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1])))].sort();
    assert.deepEqual(lazyMessageParameters(key), parameters, key);
  }
});

test('#7015 Review translations validate at startup before their English panel copy loads', () => {
  assert.equal(Object.hasOwn(englishCatalogue, 'reviewWorkspace.actions.reportName'), false);
  const raw = { 'reviewWorkspace.actions.reportName': 'Besprechung {date}',
    'reviewWorkspace.card.findings': { one: '{count} Fund', other: '{count} Funde' } };
  assert.deepEqual(checkCatalogue(raw), { catalogue: raw, problems: [] });
  assert.equal(checkCatalogue({ 'reviewWorkspace.actions.reportName': 'Besprechung {wrong}' }).catalogue['reviewWorkspace.actions.reportName'], undefined);
  assert.match(checkCatalogue({ 'reviewWorkspace.unknown': 'Unbekannt' }).problems.join(), /not an English catalogue key/);
});

test('#7015 lazy validation metadata matches every real Review message and its parameters', () => {
  for (const [key, value] of Object.entries(reviewWorkspaceEn)) {
    const forms = typeof value === 'string' ? [value] : Object.values(value);
    const parameters = [...new Set(forms.flatMap(form => [...form.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1])))].sort();
    assert.deepEqual(lazyMessageParameters(key), parameters, key);
  }
});
