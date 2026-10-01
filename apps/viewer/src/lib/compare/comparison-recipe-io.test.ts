/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readComparisonRecipe, serializeComparisonRecipe } from './comparison-recipe-io';
import type { ComparisonRecipe } from './comparison-recipe';

const recipe: ComparisonRecipe = {
  kind: 'ifc-lite-comparison-recipe', version: 1, id: 'revision-review', name: 'Revision review',
  base: { kind: 'filename', filename: 'original.ifc' }, head: { kind: 'tagName', tagName: 'Current' },
  options: { scope: 'geometry', excludedTypes: ['IfcOpeningElement'], matchByContent: false,
    keyProperty: 'Pset_Asset.AssetId' },
};

describe('comparison recipe boundary (#6612)', () => {
  it('round trips A/B direction and every explicit effective option', () => {
    const read = readComparisonRecipe(serializeComparisonRecipe(recipe));
    assert.deepEqual(read, recipe);
    read.options.excludedTypes.push('IfcWall');
    assert.deepEqual(recipe.options.excludedTypes, ['IfcOpeningElement']);
  });
  it('preserves qualified workflow slot selectors', () => {
    const slotted = { ...recipe, base: { kind: 'slot' as const, slotId: 'load:models:A' } };
    assert.deepEqual(readComparisonRecipe(serializeComparisonRecipe(slotted)), slotted);
  });
  it('refuses reports, unknown versions, unknown options and incomplete scopes', () => {
    for (const value of [
      { scope: 'both', rows: [], counts: {} },
      { ...recipe, version: 2 },
      { ...recipe, options: { ...recipe.options, acceptedIdentity: [] } },
      { ...recipe, options: { ...recipe.options, scope: 'everything' } },
      { ...recipe, base: { kind: 'filename', filename: '' } },
    ]) assert.throws(() => readComparisonRecipe(JSON.stringify(value)));
  });
  it('bounds untrusted JSON before parsing', () => {
    assert.throws(() => readComparisonRecipe(' '.repeat(1_000_001)), /exceeds 1 MB/);
    assert.throws(() => readComparisonRecipe('{'), /not valid JSON/);
  });
});
