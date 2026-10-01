/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, advance } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { CompareSetupControls } from './CompareSetupControls';
import type { ComparisonRecipe } from '@/lib/compare/comparison-recipe';

const recipe: ComparisonRecipe = {
  kind: 'ifc-lite-comparison-recipe', version: 1, id: 'review', name: 'Review',
  base: { kind: 'filename', filename: 'base.ifc' }, head: { kind: 'filename', filename: 'head.ifc' },
  options: { scope: 'geometry', excludedTypes: ['IfcOpeningElement'], matchByContent: false, keyProperty: 'Tag' },
};
afterEach(cleanup);

async function upload(container: HTMLElement, contents: unknown): Promise<void> {
  const input = container.querySelector('input[type="file"]');
  assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true,
    value: [new File([JSON.stringify(contents)], 'review.comparison.json', { type: 'application/json' })] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await advance(20);
}

describe('native comparison setups (#6612)', () => {
  it('opens portable A/B setup without executing a comparison', async () => {
    const base = fixtureModel('base'), head = fixtureModel('head');
    base.name = 'base.ifc'; head.name = 'head.ifc';
    useViewerStore.setState({ models: new Map([[base.id, base], [head.id, head]]),
      compareBaseModelId: head.id, compareHeadModelId: base.id, compareScope: 'both',
      compareMatchByContent: true, compareExcludedTypes: [], compareKeyProperty: undefined,
      compareRunning: false, compareResult: null });
    const ui = render(<CompareSetupControls />);
    await upload(ui, recipe);
    const state = useViewerStore.getState();
    assert.equal(state.compareBaseModelId, base.id);
    assert.equal(state.compareHeadModelId, head.id);
    assert.equal(state.compareScope, 'geometry');
    assert.equal(state.compareMatchByContent, false);
    assert.deepEqual(state.compareExcludedTypes, ['IfcOpeningElement']);
    assert.equal(state.compareKeyProperty, 'Tag');
    assert.equal(state.compareResult, null);
    assert.equal(state.compareRunning, false);
    assert.match(ui.textContent ?? '', /Click Run comparison/);
  });
  it('reports invalid evidence import without changing options or selection', async () => {
    useViewerStore.setState({ compareBaseModelId: 'before', compareScope: 'data', compareRunning: false });
    const ui = render(<CompareSetupControls />);
    await upload(ui, { rows: [], generatedAt: '2026-10-01T00:00:00Z' });
    assert.equal(useViewerStore.getState().compareBaseModelId, 'before');
    assert.equal(useViewerStore.getState().compareScope, 'data');
    assert.match(ui.textContent ?? '', /not a completed report/);
  });
});
