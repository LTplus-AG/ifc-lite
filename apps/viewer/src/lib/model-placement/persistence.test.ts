/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { saveWorkspacePlacements, restoreWorkspacePlacements, placementFrameKey } from './persistence';
import { emptyPlacementState, importPlacements, beginPlacement, previewPlacement } from './state';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function state(id: string, fingerprint = 'source-a') {
  return { ...useViewerStore.getState(), ...fixtureModels({ ...fixtureModel(id), sourceContentHash: fingerprint }), modelPlacement: emptyPlacementState() };
}

describe('workspace placement persistence (#4226)', () => {
  it('restores by source contents after runtime ids change, preserving fine corrections', () => {
    const disk = storage(), original = state('old');
    original.modelPlacement = importPlacements(original.modelPlacement, new Map([['old', { translation: [10_000_000.001, 2, 3], locked: false }]]));
    saveWorkspacePlacements(disk, original);
    assert.deepEqual(restoreWorkspacePlacements(disk, state('new')).get('new')?.translation, [10_000_000.001, 2, 3]);
    assert.equal(restoreWorkspacePlacements(disk, state('new', 'different-contents')).size, 0);
  });

  it('saves committed positions during a preview and persists reset instead of resurrecting a prior move', () => {
    const disk = storage(), original = state('a');
    original.modelPlacement = importPlacements(original.modelPlacement, new Map([['a', { translation: [2, 0, 0], locked: false }]]));
    original.modelPlacement = previewPlacement(beginPlacement(original.modelPlacement, ['a'], new Set(['a'])), [100, 0, 0]);
    saveWorkspacePlacements(disk, original);
    assert.deepEqual(restoreWorkspacePlacements(disk, state('b')).get('b')?.translation, [2, 0, 0]);
    saveWorkspacePlacements(disk, state('a'));
    assert.deepEqual(restoreWorkspacePlacements(disk, state('b')).get('b')?.translation, [0, 0, 0]);
  });

  it('retains the current model when the saved frame already contains 1000 sources', () => {
    const disk = storage(), old = state('old');
    old.models = new Map(Array.from({ length: 1000 }, (_, index) => {
      const id = `old-${index}`;
      return [id, { ...fixtureModel(id), sourceContentHash: id }];
    }));
    saveWorkspacePlacements(disk, old);
    const current = state('current', 'new-source');
    current.modelPlacement = importPlacements(current.modelPlacement, new Map([['current', { translation: [42.001, 0, 0], locked: false }]]));
    saveWorkspacePlacements(disk, current);
    assert.deepEqual(restoreWorkspacePlacements(disk, state('reloaded', 'new-source')).get('reloaded')?.translation, [42.001, 0, 0]);
    assert.equal(restoreWorkspacePlacements(disk, state('old-again', 'old-0')).size, 1);
  });

  it('does not auto-bind duplicate sources or overwrite an explicit move made during loading', () => {
    const disk = storage(), original = state('a');
    original.modelPlacement = importPlacements(original.modelPlacement, new Map([['a', { translation: [3, 0, 0], locked: false }]]));
    saveWorkspacePlacements(disk, original);
    const duplicate = state('b');
    duplicate.models.set('c', { ...fixtureModel('c'), sourceContentHash: 'source-a' });
    assert.equal(restoreWorkspacePlacements(disk, duplicate).size, 0);
    const edited = state('b');
    edited.modelPlacement = importPlacements(edited.modelPlacement, new Map([['b', { translation: [4, 0, 0], locked: false }]]));
    assert.equal(restoreWorkspacePlacements(disk, edited).size, 0);
  });
});

it('repairs corrupt storage on the next committed save (#4226)', () => {
  const disk = storage(), original = state('a');
  disk.setItem('ifc-lite:placements:v1:' + placementFrameKey(original), '{broken');
  original.modelPlacement = importPlacements(original.modelPlacement, new Map([['a', { translation: [12, 3, 4], locked: false }]]));
  saveWorkspacePlacements(disk, original);
  assert.deepEqual(restoreWorkspacePlacements(disk, state('b')).get('b'), { translation: [12, 3, 4], locked: false });
});
