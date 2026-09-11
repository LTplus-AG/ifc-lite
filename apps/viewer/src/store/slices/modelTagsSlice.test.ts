/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model tags (issue #4215): the slice's invariants, through the real store.
 *
 *  - identity is the id: a rename leaves every assignment (and so every saved
 *    rule holding the id) untouched;
 *  - names are unique case-insensitively, both on create and on rename;
 *  - deleting a tag drops its assignments everywhere;
 *  - assignments die with their model (`removeModel`, `clearAllModels`),
 *    definitions do not.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '../index.js';
import type { FederatedModel } from '../types.js';

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

const tagsOf = (modelId: string) => [...(useViewerStore.getState().modelTagAssignments.get(modelId) ?? [])].sort();

describe('modelTagsSlice (#4215)', () => {
  beforeEach(() => seed('A', 'B', 'C'));

  it('creates a tag once per name, case-insensitively, and returns the existing id on a repeat', () => {
    const s = useViewerStore.getState();
    const id = s.createModelTag('Structure');
    assert.ok(id);
    assert.equal(s.createModelTag('  structure '), id, 'same name, different case/whitespace → same tag');
    assert.equal(s.createModelTag('   '), null, 'blank names are refused');
    assert.equal(useViewerStore.getState().modelTags.size, 1);
  });

  it('assigns and unassigns in bulk, deduplicating per model', () => {
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    const tender = s.createModelTag('Tender')!;
    s.assignModelTags(['A', 'B'], [structure, tender]);
    s.assignModelTags(['A'], [structure]); // repeat is a no-op, not a duplicate
    assert.deepEqual(tagsOf('A'), [structure, tender].sort());
    assert.deepEqual(tagsOf('B'), [structure, tender].sort());
    assert.deepEqual(tagsOf('C'), []);

    s.unassignModelTags(['A', 'B', 'C'], [tender]);
    assert.deepEqual(tagsOf('A'), [structure]);
    assert.deepEqual(tagsOf('B'), [structure]);
    s.unassignModelTags(['A'], [structure]);
    assert.equal(useViewerStore.getState().modelTagAssignments.has('A'), false, 'an emptied model leaves the map');
  });

  it('ignores unknown tag ids on assign so a stale id can never be attached', () => {
    useViewerStore.getState().assignModelTags(['A'], ['no-such-tag']);
    assert.deepEqual(tagsOf('A'), []);
    useViewerStore.getState().setModelTags('A', ['no-such-tag']);
    assert.deepEqual(tagsOf('A'), []);
  });

  it('renames by id, so assignments (and rules holding the id) survive; refuses a name another tag holds', () => {
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    const arch = s.createModelTag('Architecture')!;
    s.assignModelTags(['A'], [structure]);

    assert.equal(s.renameModelTag(structure, 'Structural'), true);
    assert.equal(useViewerStore.getState().modelTags.get(structure)?.name, 'Structural');
    assert.deepEqual(tagsOf('A'), [structure], 'the assignment still points at the same id');

    assert.equal(s.renameModelTag(structure, 'ARCHITECTURE'), false, 'taken (case-insensitively) by another tag');
    assert.equal(s.renameModelTag(structure, ''), false);
    assert.equal(s.renameModelTag(arch, 'architecture'), true, 'a tag may re-case its own name');
    assert.equal(useViewerStore.getState().modelTags.get(structure)?.name, 'Structural', 'refused renames change nothing');
  });

  it('deleting a tag removes every assignment of it and leaves other tags alone', () => {
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    const tender = s.createModelTag('Tender')!;
    s.assignModelTags(['A', 'B'], [structure, tender]);
    s.deleteModelTag(structure);
    assert.equal(useViewerStore.getState().modelTags.has(structure), false);
    assert.deepEqual(tagsOf('A'), [tender]);
    assert.deepEqual(tagsOf('B'), [tender]);
  });

  it('upsertModelTagDefinitions keeps ids (so saved rules stay valid) and never duplicates a live name', () => {
    const s = useViewerStore.getState();
    const live = s.createModelTag('Structure')!;
    s.upsertModelTagDefinitions([
      { id: live, name: 'Renamed elsewhere' },      // same id: live definition wins
      { id: 'incoming-1', name: 'STRUCTURE' },      // same name, other id: skipped
      { id: 'incoming-2', name: 'Tender', color: '#abc' },
    ]);
    const tags = useViewerStore.getState().modelTags;
    assert.equal(tags.get(live)?.name, 'Structure');
    assert.equal(tags.has('incoming-1'), false);
    assert.deepEqual(tags.get('incoming-2'), { id: 'incoming-2', name: 'Tender', color: '#abc' });
  });

  it('removeModel purges that model\'s assignments only; clearAllModels purges all; definitions survive both', () => {
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    s.assignModelTags(['A', 'B'], [structure]);

    useViewerStore.getState().removeModel('A');
    assert.equal(useViewerStore.getState().modelTagAssignments.has('A'), false);
    assert.deepEqual(tagsOf('B'), [structure]);

    useViewerStore.getState().clearAllModels();
    assert.equal(useViewerStore.getState().modelTagAssignments.size, 0);
    assert.equal(useViewerStore.getState().modelTags.get(structure)?.name, 'Structure', 'the vocabulary is not scene state');
  });

  it('a model re-added under a new id after a same-named file load inherits nothing', () => {
    const s = useViewerStore.getState();
    const structure = s.createModelTag('Structure')!;
    s.assignModelTags(['A'], [structure]);
    useViewerStore.getState().removeModel('A');
    // Same filename, fresh runtime id — the way `loadFile` mints one.
    const again = model('A2');
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['A2', { ...again, name: 'A.ifc' }]]) });
    assert.deepEqual(tagsOf('A2'), []);
  });
});
