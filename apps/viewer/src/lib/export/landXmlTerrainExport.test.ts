/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer half of the IFC terrain → LandXML export (#7600): selection
 * narrowing and preflight classification. The producer itself is Rust and is
 * covered there; here it is a stub so the classification of its outcomes
 * (accepted, refused with a reason, engine missing, crash) is what is tested.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LandXmlTerrainExport } from '@ifc-lite/geometry';
import { fixtureDataStore, fixtureModel } from '@/test/store-fixture';
import {
  landXmlTerrainFilename,
  resolveTerrainSelection,
  runLandXmlTerrainExport,
  type LandXmlTerrainProcessor,
} from './landXmlTerrainExport';

const TERRAIN_ENTITIES = [
  { expressId: 10, type: 'IfcGeographicElement', name: 'Terrain' },
  { expressId: 11, type: 'IfcSite', name: 'Site' },
  { expressId: 12, type: 'IfcWall', name: 'Wall' },
  { expressId: 13, type: 'IfcSlab', name: 'Slab' },
];

function models(...ids: string[]) {
  return new Map(ids.map((id) => [id, fixtureModel(id, { entities: TERRAIN_ENTITIES })]));
}

describe('resolveTerrainSelection (#7600)', () => {
  it('keeps IfcGeographicElement and IfcSite and counts the rest as left out', () => {
    const selection = resolveTerrainSelection({
      refs: [
        { modelId: 'site.ifc', expressId: 12 },
        { modelId: 'site.ifc', expressId: 10 },
        { modelId: 'site.ifc', expressId: 11 },
        { modelId: 'site.ifc', expressId: 10 },
        { modelId: 'site.ifc', expressId: 13 },
      ],
      models: models('site.ifc'),
      legacyStore: null,
    });
    assert.equal(selection.kind, 'ready');
    if (selection.kind !== 'ready') return;
    assert.deepEqual(selection.productIds, [10, 11], 'candidates in selection order, deduplicated');
    assert.equal(selection.skipped, 2, 'the wall and the slab are left out');
    assert.equal(selection.modelId, 'site.ifc');
    assert.equal(selection.modelName, 'site.ifc');
  });

  it('reports no candidate when nothing selected is a terrain', () => {
    assert.deepEqual(
      resolveTerrainSelection({ refs: [], models: models('a'), legacyStore: null }),
      { kind: 'none', skipped: 0 },
    );
    assert.deepEqual(
      resolveTerrainSelection({ refs: [{ modelId: 'a', expressId: 12 }], models: models('a'), legacyStore: null }),
      { kind: 'none', skipped: 1 },
    );
  });

  it('refuses candidates that span several models', () => {
    const selection = resolveTerrainSelection({
      refs: [
        { modelId: 'a', expressId: 10 },
        { modelId: 'b', expressId: 10 },
        { modelId: 'b', expressId: 12 },
      ],
      models: models('a', 'b'),
      legacyStore: null,
    });
    assert.deepEqual(selection, { kind: 'multiple-models', skipped: 1, modelCount: 2 });
  });

  it('resolves a legacy ref to the single-model store when no model is federated', () => {
    const legacyStore = fixtureDataStore(TERRAIN_ENTITIES);
    const selection = resolveTerrainSelection({
      refs: [{ modelId: 'legacy', expressId: 10 }],
      models: new Map(),
      legacyStore,
    });
    assert.equal(selection.kind, 'ready');
    if (selection.kind !== 'ready') return;
    assert.equal(selection.store, legacyStore);
    assert.equal(selection.modelId, 'legacy', 'the legacy mutation view key');
    assert.equal(landXmlTerrainFilename(selection.modelName), 'model_terrain.xml');
  });

  it('resolves a legacy ref to the sole federated model, and drops it when several are loaded', () => {
    const sole = resolveTerrainSelection({
      refs: [{ modelId: 'legacy', expressId: 11 }],
      models: models('only.ifc'),
      legacyStore: null,
    });
    assert.equal(sole.kind, 'ready');
    if (sole.kind === 'ready') assert.equal(sole.modelId, 'only.ifc');

    const ambiguous = resolveTerrainSelection({
      refs: [{ modelId: 'legacy', expressId: 11 }],
      models: models('a', 'b'),
      legacyStore: null,
    });
    assert.deepEqual(ambiguous, { kind: 'none', skipped: 1 });
  });

  it('counts a ref to an unloaded model as left out', () => {
    const selection = resolveTerrainSelection({
      refs: [{ modelId: 'gone', expressId: 10 }],
      models: models('a'),
      legacyStore: null,
    });
    assert.deepEqual(selection, { kind: 'none', skipped: 1 });
  });
});

const DOCUMENT: LandXmlTerrainExport = {
  xml: '<LandXML/>',
  crsName: 'EPSG:2056',
  surfaces: [{ productId: 10, globalId: null, name: 'Terrain', points: 4, faces: 2 }],
};

function stubProcessor(exportImpl: LandXmlTerrainProcessor['exportLandXmlTerrain']) {
  const calls = { init: 0, dispose: 0, ids: [] as number[][] };
  const processor: LandXmlTerrainProcessor = {
    init: async () => {
      calls.init += 1;
    },
    exportLandXmlTerrain: (bytes, ids, options) => {
      calls.ids.push([...ids]);
      return exportImpl(bytes, ids, options);
    },
    dispose: () => {
      calls.dispose += 1;
    },
  };
  return { processor, calls };
}

describe('runLandXmlTerrainExport (#7600)', () => {
  it('returns the document when the producer accepts, passing the ids and disposing', async () => {
    const { processor, calls } = stubProcessor(() => DOCUMENT);
    const outcome = await runLandXmlTerrainExport(new Uint8Array([1]), [10, 11], () => processor);
    assert.deepEqual(outcome, { status: 'ready', result: DOCUMENT });
    assert.deepEqual(calls.ids, [[10, 11]]);
    assert.equal(calls.dispose, 1);
  });

  it('surfaces a TERRAIN_REFUSED reason verbatim and still disposes', async () => {
    const reason = '#10 IfcGeographicElement has 2 body representations; expected exactly one IfcTriangulatedFaceSet';
    const { processor, calls } = stubProcessor(() => {
      throw new Error(`TERRAIN_REFUSED: ${reason}`);
    });
    const outcome = await runLandXmlTerrainExport(new Uint8Array([1]), [10], () => processor);
    assert.deepEqual(outcome, { status: 'refused', reason });
    assert.equal(calls.dispose, 1);
  });

  it('keeps a crash apart from a refusal', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const { processor, calls } = stubProcessor(() => {
      throw new Error('unreachable');
    });
    const outcome = await runLandXmlTerrainExport(new Uint8Array([1]), [10], () => processor);
    assert.deepEqual(outcome, { status: 'failed', message: 'unreachable' });
    assert.equal(calls.dispose, 1);
  });

  it('reports an uninitialised engine as unavailable', async () => {
    const { processor } = stubProcessor(() => null);
    assert.deepEqual(await runLandXmlTerrainExport(new Uint8Array([1]), [10], () => processor), {
      status: 'unavailable',
    });
  });
});

describe('landXmlTerrainFilename (#7600)', () => {
  it('names the file after the model with a _terrain suffix', () => {
    assert.equal(landXmlTerrainFilename('Haus.ifc'), 'Haus_terrain.xml');
  });
});
