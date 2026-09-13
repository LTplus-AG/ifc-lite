/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The federated hierarchy's Models section with model tags (issue #4215),
 * mounted: the "By tag" grouping lists one header per tag plus Untagged with
 * deduplicated counts, the tag chips FILTER the rows without touching
 * visibility, "Isolate matching models" is the one action that does, and a
 * group's eye flips every member in one write.
 *
 * Three models: m1 tagged Structure + Architecture, m2 Structure, m3 untagged.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { DEFAULT_MODEL_TAG_VIEW } from '@/store/slices/modelTagsSlice.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from './HierarchyPanel.js';

/** Just what `buildUnifiedStoreys` and the MODELS section read: one storey. */
function makeStore(storeyId: number, elevation: number, name: string): IfcDataStore {
  return {
    entityCount: 1,
    spatialHierarchy: {
      project: undefined,
      byStorey: new Map([[storeyId, []]]),
      storeyElevations: new Map([[storeyId, elevation]]),
    },
    entities: { getName: (id: number) => (id === storeyId ? name : undefined) },
  } as unknown as IfcDataStore;
}

function federatedModel(id: string): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: makeStore(5, 0, 'Level 1'), geometryResult: null, visible: true,
    collapsed: false, schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: 0, maxExpressId: 100,
  } as FederatedModel;
}

let structure = '';
let architecture = '';

function seed(): void {
  federationRegistry.clear();
  for (const id of ['m1', 'm2', 'm3']) federationRegistry.registerModel(id, 100);
  useViewerStore.setState({
    models: new Map(['m1', 'm2', 'm3'].map((id) => [id, federatedModel(id)])),
    ifcDataStore: null,
    activeModelId: 'm1',
    selectedStoreys: new Set<number>(),
    hierarchyMode: 'spatial',
    modelTags: new Map(),
    modelTagAssignments: new Map(),
    modelTagView: DEFAULT_MODEL_TAG_VIEW,
  });
  const s = useViewerStore.getState();
  structure = s.createModelTag('Structure')!;
  architecture = s.createModelTag('Architecture')!;
  s.assignModelTags(['m1'], [structure, architecture]);
  s.assignModelTags(['m2'], [structure]);
}

const renderPanel = () => render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);

const visibility = () =>
  Object.fromEntries([...useViewerStore.getState().models].map(([id, m]) => [id, m.visible]));

/** Every model row carries its eye toggle; a model listed twice has two. */
const modelRowsOf = (root: ParentNode, modelId: string) =>
  root.querySelectorAll(`button[aria-label^="Hide model ${modelId}.ifc"], button[aria-label^="Show model ${modelId}.ifc"]`).length;

function byLabel(root: ParentNode, label: string): HTMLElement {
  const hit = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(hit, `no control labelled "${label}"; have: ${[...root.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' | ')}`);
  return hit;
}

function byText(root: ParentNode, text: string): HTMLElement {
  const hit = [...root.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(hit, `no button reading "${text}"`);
  return hit;
}

describe('HierarchyPanel — model tags in the Models section (#4215)', () => {
  beforeEach(seed);
  afterEach(cleanup);

  it('flat by default: one row per model, no group headers, and the tag controls are offered', () => {
    const c = renderPanel();
    assert.equal(c.querySelectorAll('[data-model-tag-group]').length, 0);
    for (const id of ['m1', 'm2', 'm3']) assert.equal(modelRowsOf(c, id), 1, `${id} listed once`);
    assert.ok(c.querySelector('[data-model-tag-controls]'), 'the federation carries tags, so the controls show');
  });

  it('"By tag" lists one header per tag plus Untagged; a two-tag model is under both, counts are distinct models', () => {
    const c = renderPanel();
    click(byText(c, 'By tag'));
    const headers = [...c.querySelectorAll<HTMLElement>('[data-model-tag-group]')];
    // Name then the distinct-model count (the two spans render with no whitespace between).
    assert.deepEqual(headers.map((h) => h.textContent?.trim()), ['Architecture1', 'Structure2', 'Untagged1']);
    assert.equal(modelRowsOf(c, 'm1'), 2, 'm1 is listed under Architecture and under Structure');
    assert.equal(modelRowsOf(c, 'm2'), 1);
    assert.equal(modelRowsOf(c, 'm3'), 1);
    assert.equal(useViewerStore.getState().models.size, 3, 'listing a model twice does not make it two models');
    assert.deepEqual(visibility(), { m1: true, m2: true, m3: true }, 'grouping changes no visibility');
  });

  it('a tag chip FILTERS the rows and hides nothing; "Isolate matching models" is what hides', () => {
    const c = renderPanel();
    click(byLabel(c, 'List models tagged Structure'));
    assert.equal(modelRowsOf(c, 'm1'), 1);
    assert.equal(modelRowsOf(c, 'm2'), 1);
    assert.equal(modelRowsOf(c, 'm3'), 0, 'the untagged model is not listed');
    assert.deepEqual(visibility(), { m1: true, m2: true, m3: true }, 'filtering rows must not touch the viewport');
    assert.equal(c.querySelector('[data-model-tag-filter-count]')?.textContent, '2 of 3');

    click(byText(c, 'Isolate matching models'));
    assert.deepEqual(visibility(), { m1: true, m2: true, m3: false }, 'the explicit action hides the rest');

    click(byLabel(c, 'List untagged models'));
    assert.equal(modelRowsOf(c, 'm3'), 1, 'Structure OR untagged lists all three');
    click(byText(c, 'Isolate matching models'));
    assert.deepEqual(visibility(), { m1: true, m2: true, m3: true }, 'isolate is absolute: a listed model is shown again');

    click(byLabel(c, 'Clear model tag filter'));
    assert.equal(c.querySelector('[data-model-tag-filter-count]'), null);
    assert.equal(modelRowsOf(c, 'm3'), 1);
  });

  it('a group header\'s eye shows or hides every member of that group in one write, and only them', () => {
    const c = renderPanel();
    click(byText(c, 'By tag'));
    click(byLabel(c, 'Hide models tagged Structure'));
    assert.deepEqual(visibility(), { m1: false, m2: false, m3: true });
    // m1 is also under Architecture: its ONE model is hidden there too.
    assert.equal(modelRowsOf(c, 'm1'), 2);
    assert.equal(c.querySelectorAll('button[aria-label="Show model m1.ifc"]').length, 2, 'both rows of m1 read hidden');
    click(byLabel(c, 'Show models tagged Structure'));
    assert.deepEqual(visibility(), { m1: true, m2: true, m3: true });
  });

  it('a filter outlives the last model carrying its tag: Clear is still offered and lists every model again', () => {
    const c = renderPanel();
    click(byLabel(c, 'List models tagged Structure'));
    act(() => { useViewerStore.getState().unassignModelTags(['m1', 'm2'], [structure]); });
    assert.equal(c.querySelector('[data-model-tag-filter-count]')?.textContent, '0 of 3', 'the filter now lists nothing');
    for (const id of ['m1', 'm2', 'm3']) assert.equal(modelRowsOf(c, id), 0);
    assert.ok(c.querySelector('[aria-label="Stop listing models tagged Structure"]'), 'the filtering chip stays visible');
    click(byLabel(c, 'Clear model tag filter'));
    for (const id of ['m1', 'm2', 'm3']) assert.equal(modelRowsOf(c, id), 1, `${id} listed again`);
    assert.equal(c.querySelector('[data-model-tag-filter-count]')?.textContent ?? null, null);
    // Cleared and no longer carried by any model: Structure has no chip; Architecture (still on m1) has.
    assert.equal(c.querySelector('[aria-label="List models tagged Structure"]') !== null, false);
    assert.ok(c.querySelector('[aria-label="List models tagged Architecture"]'));
  });

  it('the view is torn down with the federation, so a fresh session never opens pre-filtered', () => {
    useViewerStore.setState({ modelTagView: { groupByTag: true, filterTagIds: [structure], filterUntagged: false } });
    useViewerStore.getState().clearAllModels();
    assert.deepEqual(useViewerStore.getState().modelTagView, DEFAULT_MODEL_TAG_VIEW);
    assert.equal(useViewerStore.getState().modelTags.size, 2, 'the vocabulary survives');
  });

  it('deleting a tag drops it from the row filter so the list does not silently go empty', () => {
    const c = renderPanel();
    click(byLabel(c, 'List models tagged Architecture'));
    assert.equal(modelRowsOf(c, 'm2'), 0);
    act(() => { useViewerStore.getState().deleteModelTag(architecture); });
    assert.deepEqual(useViewerStore.getState().modelTagView.filterTagIds, []);
    assert.equal(modelRowsOf(c, 'm2'), 1, 'no filter left → every model listed again');
  });
});
