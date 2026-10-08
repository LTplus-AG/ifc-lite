/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCatalogue, isCatalogueRecord } from './catalogue-problems';
import { flowReviewEn } from './catalogues/flow-review.en';
import { registerEnglish } from './registry';
import { lazyMessageParameters } from './lazy-catalogue-shape';

describe('checkCatalogue (#4785)', () => {
  it('accepts a partial catalogue that keeps every placeholder, in any word order', () => {
    const raw = {
      'mergeLayersBanner.reloadButton': 'Neu laden',
      'appearanceAssignmentList.assignmentAriaLabel': '{modelName}: Zuweisung {position} ({sourceName})',
      'appearanceAssignmentList.summaryProducts': { one: 'ein Objekt', other: '{count} Objekte' },
    };
    assert.deepEqual(checkCatalogue(raw), { catalogue: raw, problems: [] });
  });

  it('drops and reports unknown keys, placeholder mismatches and malformed messages', () => {
    const checked = checkCatalogue({
      'mergeLayersBanner.reloadButton': 'Neu laden',
      'ribbon.noSuchKey': 'x',
      'appearanceAssignmentList.assignmentAriaLabel': 'Zuweisung {index}: {sourceName}',
      'appearanceAssignmentList.summaryProducts': { one: '{count} Objekt' },
      'appearanceAssignmentList.summaryExcluded': { one: 1, other: '{count} ausgeschlossen' },
      'appearanceAssignmentList.heading': ['Zuweisungen'],
    });
    assert.deepEqual(checked.catalogue, { 'mergeLayersBanner.reloadButton': 'Neu laden' });
    assert.deepEqual(checked.problems, [
      'ribbon.noSuchKey: not an English catalogue key',
      'appearanceAssignmentList.assignmentAriaLabel: unknown placeholder {index}',
      'appearanceAssignmentList.assignmentAriaLabel: missing placeholder {position}',
      'appearanceAssignmentList.assignmentAriaLabel: missing placeholder {modelName}',
      'appearanceAssignmentList.summaryProducts: plural message has no "other" form',
      'appearanceAssignmentList.summaryExcluded: plural form "one" must be a string',
      'appearanceAssignmentList.heading: must be a string or a plural object',
    ]);
  });
});

describe('lazy English catalogues (#6923)', () => {
  it('accept a locale translation of a lazy key, and compare its placeholders once the catalogue registered', () => {
    assert.deepEqual(checkCatalogue({ 'flowReview.digest': 'Vorschlag' }).problems, ['flowReview.digest: missing placeholder {digest}']);
    assert.deepEqual(checkCatalogue({ 'flowReview.digestt': 'Vorschlag {digest}' }).problems, ['flowReview.digestt: not an English catalogue key']);
    assert.deepEqual(checkCatalogue({ 'flowReview.digest': 'Vorschlag {digest}' }).problems, []);
    registerEnglish(flowReviewEn);
    assert.deepEqual(checkCatalogue({ 'flowReview.digest': 'Vorschlag' }).problems, ['flowReview.digest: missing placeholder {digest}']);
    assert.deepEqual(checkCatalogue({ 'flowReview.digest': 'Vorschlag {digest}', 'flowReviewX.nope': 'x' }).problems,
      ['flowReviewX.nope: not an English catalogue key']);
  });
});

/**
 * Every contributed locale file must load as a catalogue with no problems.
 * With no locale contributed yet this loops over nothing; it exists so the
 * first translator's pull request fails here, not in a user's browser.
 */
describe('contributed locale files (#4785)', () => {
  // Lazy catalogues load with their feature in the viewer; register them all
  // so their keys are compared like eager ones (#6923).
  before(() => registerEnglish(flowReviewEn));
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    : [];

  for (const file of files) {
    it(`locales/${file} is a valid catalogue`, async () => {
      const module: { default?: unknown } = await import(pathToFileURL(path.join(dir, file)).href);
      assert.ok(isCatalogueRecord(module.default), `locales/${file} must default-export a catalogue object`);
      assert.deepEqual(checkCatalogue(module.default).problems, []);
      assert.doesNotThrow(() => Intl.getCanonicalLocales(file.slice(0, -'.ts'.length)));
    });
  }
});


it('#7040 startup metadata matches every lazy Flow review key and placeholder', () => {
  for (const [key, value] of Object.entries(flowReviewEn)) {
    const forms = typeof value === 'string' ? [value] : Object.values(value);
    const parameters = [...new Set(forms.flatMap(form => [...form.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1])))].sort();
    assert.deepEqual(lazyMessageParameters(key), parameters, key);
  }
});
