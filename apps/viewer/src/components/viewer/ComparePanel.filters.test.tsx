/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import { diffModels, type EntityFingerprint } from '@ifc-lite/diff';
import { render, click, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import type { CompareResult } from '@/store/slices/compareSlice';
import { ComparePanel } from './ComparePanel';

const initial = useViewerStore.getState();
const offset = 1_000_000;
const keys = ['data', 'geometry', 'both', 'removed', 'added', 'old-match', 'new-match', 'type'];
function fp(modelId: string, key: string, dataHash = key, geometryHash = 'g'): EntityFingerprint<CompareRef> {
  const localId = keys.indexOf(key) + 1;
  return { key, dataHash, geometryHash, ifcType: 'IfcWall',
    ref: { modelId, localId, globalId: localId + (modelId === 'B' ? offset : 0) } };
}
function result(): CompareResult {
  const diff = diffModels(
    [fp('A', 'data'), fp('A', 'geometry'), fp('A', 'both'), fp('A', 'removed'), { ...fp('A', 'type'), ifcType: 'IfcWallType' }],
    [fp('B', 'data', 'edited'), fp('B', 'geometry', 'geometry', 'edited'), fp('B', 'both', 'edited', 'edited'), fp('B', 'added'), { ...fp('B', 'type', 'edited', 'edited'), ifcType: 'IfcWallType' }],
    { scope: 'both' },
  );
  // Stated invariant: retiring matches live outside diff.entries, and their
  // drawable base is used if the head lost its representation (#8017).
  diff.contentMatches = [{ kind: 'renamed', dataHash: 'matched', base: [fp('A', 'old-match')],
    head: [{ ...fp('B', 'new-match'), ref: { ...fp('B', 'new-match').ref, meshed: false } }] }];
  return { baseModelId: 'A', headModelId: 'B', baseName: 'A', headName: 'B', scope: 'both',
    geometryUnavailable: false, excludedHiddenIds: new Set(), diff };
}
beforeEach(() => {
  const entities = keys.map((name, i) => ({ expressId: i + 1, type: 'IfcWall', name }));
  useViewerStore.setState({ ...initial,
    ...fixtureModels(fixtureModel('A', { entities }), fixtureModel('B', { entities, idOffset: offset })),
    compareBaseModelId: 'A', compareHeadModelId: 'B', compareResult: result(),
    hiddenEntities: new Set([999]), compareRunCaptures: [], compareReconciliation: null,
  }, true);
});
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

function badge(ui: HTMLElement, label: string): HTMLButtonElement {
  const button = ui.querySelector<HTMLButtonElement>(`button[aria-label="${label}"][aria-pressed]`);
  assert.ok(button, `${label} count is an accessible filter`);
  return button;
}
function rows(ui: HTMLElement): string {
  return ui.querySelector('[data-tour="compare-results"]')?.textContent ?? '';
}

describe('comparison filters (#8017)', () => {
  it('count buttons filter rows and isolate in 3D; toggling restores only Compare-owned visibility', () => {
    const ui = render(<ComparePanel />);
    const allHidden = new Set(useViewerStore.getState().hiddenEntities);
    click(badge(ui, 'Added'));
    assert.equal(badge(ui, 'Added').getAttribute('aria-pressed'), 'true');
    assert.match(rows(ui), /added/);
    assert.doesNotMatch(rows(ui), /removed|old-match/);
    const state = useViewerStore.getState();
    assert.equal(state.hiddenEntities.has(offset + 5), false);
    for (const id of [1, 2, 3, 4, 6, offset + 1, offset + 2, offset + 3, offset + 7]) assert.ok(state.hiddenEntities.has(id), `${id} excluded`);
    click(badge(ui, 'Added'));
    assert.deepEqual(useViewerStore.getState().hiddenEntities, allHidden);
    assert.match(rows(ui), /removed/);
  });

  it('filters changed elements by kind including combined changes; bulk selection follows the filter', () => {
    const ui = render(<ComparePanel />);
    const select = ui.querySelector<HTMLSelectElement>('select[aria-label="Change kind"]')!;
    act(() => { select.value = 'geometry'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(badge(ui, 'Changed').getAttribute('aria-pressed'), 'true');
    assert.match(rows(ui), /geometry/);
    assert.match(rows(ui), /both/);
    assert.doesNotMatch(rows(ui), /removed|added|old-match/);
    const group = [...ui.querySelectorAll('button')].find(b => b.title === 'Select all changed in 3D');
    assert.ok(group);
    assert.match(group.textContent ?? '', /Changed\s*\(2 \+1 type object\)/);
    click(group);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([offset + 2, offset + 3, offset + 8]));
    act(() => { select.value = 'data'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.ok(useViewerStore.getState().hiddenEntities.has(offset + 2));
    assert.equal(useViewerStore.getState().hiddenEntities.has(offset + 1), false);
    assert.equal(useViewerStore.getState().hiddenEntities.has(offset + 3), false);
  });

  it('Matched isolates its separate population and selects the drawable base fallback', () => {
    const ui = render(<ComparePanel />);
    click(badge(ui, 'Matched'));
    assert.match(rows(ui), /old-match|new-match/);
    assert.doesNotMatch(rows(ui), /removed|added/);
    assert.equal(useViewerStore.getState().hiddenEntities.has(6), false);
    assert.ok(useViewerStore.getState().hiddenEntities.has(offset + 5));
    const group = [...ui.querySelectorAll('button')].find(b => b.title === 'Select all content-matched elements in 3D');
    assert.ok(group);
    click(group);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([6]));
    cleanup();
    assert.deepEqual(useViewerStore.getState().hiddenEntities, new Set([999]));
  });

  it('result replacement resets filters and empty kind filters report no matching results', () => {
    const ui = render(<ComparePanel />);
    const select = ui.querySelector<HTMLSelectElement>('select[aria-label="Change kind"]')!;
    act(() => { select.value = 'container'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.match(rows(ui), /No results match these filters/);
    act(() => useViewerStore.getState().setCompareResult(result()));
    assert.equal(badge(ui, 'Changed').getAttribute('aria-pressed'), 'false');
    assert.equal(select.value, '');
    assert.equal(useViewerStore.getState().hiddenEntities.has(offset + 5), false);
  });
});
