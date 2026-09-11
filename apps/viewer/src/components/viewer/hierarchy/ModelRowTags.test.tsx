/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hierarchy model-row tags (issue #4215), mounted: the chips on the row read
 * the store, the editor assigns/creates/renames/deletes through it, and a
 * one-model editor can widen to every model (bulk).
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act } from 'react';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { ModelRowTags } from './ModelRowTags.js';

function model(id: string): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: 0, maxExpressId: 10,
  } as FederatedModel;
}

function seed(...ids: string[]): void {
  federationRegistry.clear();
  for (const id of ids) federationRegistry.registerModel(id, 10);
  useViewerStore.setState({
    models: new Map(ids.map((id) => [id, model(id)])),
    activeModelId: ids[0] ?? null,
    modelTags: new Map(),
    modelTagAssignments: new Map(),
  });
}

const tagsOf = (modelId: string) =>
  [...(useViewerStore.getState().modelTagAssignments.get(modelId) ?? [])]
    .map((id) => useViewerStore.getState().modelTags.get(id)?.name)
    .sort();

function byLabel(root: ParentNode, label: string): HTMLElement {
  const hit = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(hit, `no control labelled "${label}"; have: ${[...root.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' | ')}`);
  return hit;
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function pressEnter(el: Element): void {
  act(() => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
}

/** The editor is a Radix dialog portaled to `document.body`. */
const dialog = () => document.querySelector<HTMLElement>('[data-model-tag-editor]');

describe('ModelRowTags (#4215)', () => {
  beforeEach(() => seed('A', 'B'));
  afterEach(cleanup);

  it('shows the model\'s tags as chips, at most three inline, and none for an untagged model', () => {
    const s = useViewerStore.getState();
    const ids = ['One', 'Two', 'Three', 'Four'].map((n) => s.createModelTag(n)!);
    s.assignModelTags(['A'], ids);
    const container = render(<ModelRowTags modelId="A" modelName="A.ifc" />);
    const chips = container.querySelectorAll('[data-model-tag-chip]');
    assert.equal(chips.length, 3);
    assert.ok(container.textContent?.includes('+1'));

    const untagged = render(<ModelRowTags modelId="B" modelName="B.ifc" />);
    assert.equal(untagged.querySelectorAll('[data-model-tag-chip]').length, 0);
  });

  it('creates and assigns a tag from the editor on Enter; a repeat of the same name assigns, not duplicates', () => {
    const container = render(<ModelRowTags modelId="A" modelName="A.ifc" />);
    click(byLabel(container, 'Edit tags for model A.ifc'));
    const dlg = dialog();
    assert.ok(dlg, 'the editor dialog opens');

    const input = byLabel(dlg, 'Add a tag') as HTMLInputElement;
    typeInto(input, 'Structure');
    pressEnter(input);
    assert.deepEqual(tagsOf('A'), ['Structure']);
    assert.equal(container.querySelectorAll('[data-model-tag-chip]').length, 1, 'the row chip appears');

    typeInto(input, ' structure ');
    pressEnter(input);
    assert.equal(useViewerStore.getState().modelTags.size, 1, 'same name (case/space-insensitive) → the existing tag');
  });

  it('toggles assignment, renames by id (chip follows, assignment survives), refuses a taken name, and deletes', () => {
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    s.createModelTag('Architecture');
    s.assignModelTags(['A'], [structure]);
    const container = render(<ModelRowTags modelId="A" modelName="A.ifc" />);
    click(byLabel(container, 'Edit tags for model A.ifc'));
    const dlg = dialog()!;

    click(byLabel(dlg, 'Remove tag Structure'));
    assert.deepEqual(tagsOf('A'), []);
    click(byLabel(dlg, 'Assign tag Structure'));
    assert.deepEqual(tagsOf('A'), ['Structure']);

    click(byLabel(dlg, 'Rename tag Structure'));
    const rename = byLabel(dlg, 'Rename tag Structure') as HTMLInputElement;
    typeInto(rename, 'architecture');
    pressEnter(rename);
    assert.ok(dlg.querySelector('[role="alert"]')?.textContent?.includes('already used'), 'a taken name is refused visibly');
    typeInto(rename, 'Structural');
    pressEnter(rename);
    assert.equal(useViewerStore.getState().modelTags.get(structure)?.name, 'Structural');
    assert.deepEqual(tagsOf('A'), ['Structural'], 'the assignment followed the id, not the name');
    assert.ok(container.querySelector('[data-model-tag-chip]')?.textContent?.includes('Structural'));

    click(byLabel(dlg, 'Delete tag Structural'));
    assert.equal(useViewerStore.getState().modelTags.has(structure), false);
    assert.deepEqual(tagsOf('A'), []);
  });

  it('bulk: widening the editor to all models assigns and removes on every model at once', () => {
    const container = render(<ModelRowTags modelId="A" modelName="A.ifc" />);
    click(byLabel(container, 'Edit tags for model A.ifc'));
    const dlg = dialog()!;
    const all = [...dlg.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'All 2 models');
    assert.ok(all, 'the scope switch offers every model');
    click(all);

    const input = byLabel(dlg, 'Add a tag') as HTMLInputElement;
    typeInto(input, 'Tender');
    pressEnter(input);
    assert.deepEqual(tagsOf('A'), ['Tender']);
    assert.deepEqual(tagsOf('B'), ['Tender']);

    click(byLabel(dlg, 'Remove tag Tender'));
    assert.deepEqual(tagsOf('A'), []);
    assert.deepEqual(tagsOf('B'), []);
  });
});
