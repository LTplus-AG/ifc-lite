/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The palette's "Model Tags" command (issue #4215) opens the tag editor for
 * the active model in a ONE-model session — the only tag entry point when
 * the hierarchy has no Models section — and a tag created there lands on
 * that model.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act } from 'react';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { EVENT_EDIT_MODEL_TAGS, ModelTagsCommand } from './ModelTagsCommand.js';

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

const dialog = () => document.querySelector<HTMLElement>('[data-model-tag-editor]');

const fire = () => act(() => { window.dispatchEvent(new CustomEvent(EVENT_EDIT_MODEL_TAGS)); });

describe('ModelTagsCommand (#4215)', () => {
  beforeEach(() => seed('A'));
  afterEach(cleanup);

  it('opens the tag editor for the one loaded model; a tag typed there is assigned to it', () => {
    render(<ModelTagsCommand />);
    assert.equal(dialog(), null, 'nothing until the command fires');
    fire();
    const dlg = dialog();
    assert.ok(dlg, 'the editor opens from the palette event');
    assert.ok(dlg.textContent?.includes('Labels for A.ifc'), 'scoped to the active model, not a bulk edit');
    assert.equal(dlg.querySelector('[role="group"][aria-label="Apply to"]'), null, 'one model: no bulk switch to offer');

    const input = dlg.querySelector<HTMLInputElement>('input[aria-label="Add a tag"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Structure');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    act(() => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    assert.deepEqual(tagsOf('A'), ['Structure']);
  });

  it('with no model loaded it opens nothing, rather than an editor over no model', () => {
    seed();
    render(<ModelTagsCommand />);
    fire();
    assert.equal(dialog(), null);
  });
});
