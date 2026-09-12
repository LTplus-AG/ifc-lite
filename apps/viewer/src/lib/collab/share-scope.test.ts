/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4444 — the share scope decides what the room carries. With several models
 * loaded the dialog used to seed the active one and nothing else; now the
 * scope is explicit and the seed is built per model from each model's OWN
 * record, never from the top-level active-model handles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '../../store/types.js';
import { buildShareSeed, modelsInShareScope, shareScopeIsChoice } from './share-scope.js';

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

function model(id: string, opts: { store?: boolean; idOffset?: number; schema?: 'IFC4' | 'IFC5' } = {}): FederatedModel {
  const idOffset = opts.idOffset ?? 0;
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: opts.store === false ? null : createSyntheticDataStore({
      schemaVersion: opts.schema ?? 'IFC4',
      fileSize: 0,
    }),
    geometryResult: { meshes: [mesh(7 + idOffset)] } as unknown as FederatedModel['geometryResult'],
    visible: true,
    collapsed: false,
    schemaVersion: opts.schema ?? 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset,
    maxExpressId: 10,
    sourceFingerprint: `fp-${id}`,
  } as unknown as FederatedModel;
}

describe('share scope (#4444)', () => {
  it('offers a choice only with more than one model loaded', () => {
    assert.equal(shareScopeIsChoice(new Map([['a', model('a')]])), false);
    assert.equal(shareScopeIsChoice(new Map([['a', model('a')], ['b', model('b', { idOffset: 1_000_000 })]])), true);
  });

  it('"all" shares every loaded model, active first, each from its own record', () => {
    const models = new Map([
      ['a', model('a')],
      ['b', model('b', { idOffset: 1_000_000 })],
    ]);
    assert.deepEqual(modelsInShareScope(models, 'b', 'all').map((m) => m.id), ['b', 'a']);
    const seed = buildShareSeed(models, 'b', 'all');
    assert.ok(seed);
    assert.deepEqual(seed.models.map((m) => m.modelId), ['b', 'a']);
    const b = seed.models[0];
    assert.equal(b.store, models.get('b')?.ifcDataStore, 'copy B seeds from ITS store, not the active-model handle');
    assert.equal(b.idOffset, 1_000_000);
    assert.equal(b.meshes?.[0].expressId, 1_000_007, 'meshes are handed over as the record holds them (global ids)');
    assert.equal(b.isIfcx, false);
    assert.equal(b.name, 'b.ifc');
    assert.equal(b.sourceFingerprint, 'fp-b');
  });

  it('"active" shares the active model only', () => {
    const models = new Map([
      ['a', model('a')],
      ['b', model('b', { idOffset: 1_000_000 })],
    ]);
    const seed = buildShareSeed(models, 'b', 'active');
    assert.deepEqual(seed?.models.map((m) => m.modelId), ['b']);
    // No active model: the first loaded one, as the dialog title does.
    assert.deepEqual(buildShareSeed(models, null, 'active')?.models.map((m) => m.modelId), ['a']);
  });

  it('IFC5 models seed from their bytes, not from tessellated meshes', () => {
    const models = new Map([['x', model('x', { schema: 'IFC5' })]]);
    const seed = buildShareSeed(models, 'x', 'all');
    assert.equal(seed?.models[0].isIfcx, true);
    assert.equal(seed?.models[0].meshes, null);
  });

  it('leaves out models with nothing to seed, and yields an EMPTY seed (never none) when none remains', () => {
    const models = new Map([
      ['a', model('a', { store: false })],
      ['b', model('b', { idOffset: 1_000_000 })],
    ]);
    assert.deepEqual(buildShareSeed(models, 'a', 'all')?.models.map((m) => m.modelId), ['b']);
    // An owner with nothing seedable still takes the owner path in
    // `startCollab` (which keys owner vs recipient on `seed` presence).
    assert.deepEqual(buildShareSeed(new Map([['a', model('a', { store: false })]]), 'a', 'all'), { models: [] });
    assert.deepEqual(buildShareSeed(new Map(), null, 'active'), { models: [] });
  });
});
