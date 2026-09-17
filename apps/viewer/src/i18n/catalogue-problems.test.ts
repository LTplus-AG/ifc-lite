/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCatalogue, isCatalogueRecord } from './catalogue-problems';

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

/**
 * Every contributed locale file must load as a catalogue with no problems.
 * With no locale contributed yet this loops over nothing; it exists so the
 * first translator's pull request fails here, not in a user's browser.
 */
describe('contributed locale files (#4785)', () => {
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
