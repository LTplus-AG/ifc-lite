/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Federation on the main viewer's agent tool host (#9523): STEP models never
 * mix in one answer, and an IFCX composition (every layer published as a
 * model over ONE composed store, `federatedIfcxComposition.ts`) answers once,
 * under the layer the viewer resolves selections and edits to.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { useViewerStore, type FederatedModel } from '@/store';
import {
  HELLO_WALL_IFCX, WALL_GID, call, fileBytes, model, ok, parseHelloWall, parseOther, seed, status,
} from '@/test/agent-tools-fixture';

type Rows<K extends string> = { [key in K]: Array<{ key?: string; name?: string; count: number }> };
const keys = (rows: Array<{ key?: string; name?: string }>) => rows.map((row) => row.key ?? row.name);

describe('main viewer host keeps federated STEP models apart (#9523)', () => {
  beforeEach(async () => seed([model('hello', await parseHelloWall()), model('other', await parseOther())]));

  it('lists both models and scopes a query to the one model_id names', async () => {
    const list = ok(await call('model_list')).structured as { models: Array<{ id: string; entityCount: number }> };
    assert.deepEqual(list.models.map((m) => m.id), ['hello', 'other']);
    assert.ok(list.models.every((m) => m.entityCount > 0));

    const other = ok(await call('query_entities', { model_id: 'other', type: 'IfcWall' })).structured as {
      entities: Array<{ modelId: string; name: string }>;
    };
    assert.deepEqual(other.entities.map((e) => [e.modelId, e.name]), [['other', 'Other wall']]);
    const hello = ok(await call('query_entities', { model_id: 'hello' })).structured as { entities: Array<{ modelId: string }> };
    assert.ok(hello.entities.length > 0 && hello.entities.every((e) => e.modelId === 'hello'));

    assert.equal((await call('get_entity', { model_id: 'other', global_id: WALL_GID })).errorCode, 'ENTITY_NOT_FOUND');
    assert.equal((ok(await call('units', { model_id: 'other' })).structured as { lengthUnitScale: number }).lengthUnitScale, 0.001);
  });

  it('materials, classifications and storey/material counts come from the named model only', async () => {
    const materials = async (id: string) => keys((ok(await call('materials_list', { model_id: id })).structured as Rows<'materials'>).materials);
    assert.deepEqual(await materials('other'), ['STEEL']);
    const helloMaterials = await materials('hello');
    assert.ok(helloMaterials.length > 0 && !helloMaterials.includes('STEEL'), helloMaterials.join());

    const classes = async (id: string) => keys((ok(await call('classifications_list', { model_id: id })).structured as Rows<'classifications'>).classifications);
    assert.deepEqual(await classes('other'), ['Uniclass:EF_25_10']);
    assert.ok(!(await classes('hello')).includes('Uniclass:EF_25_10'));

    const groups = async (id: string, by: string) => keys((ok(await call('count_entities', { model_id: id, group_by: by, type: 'IfcWall' })).structured as Rows<'groups'>).groups);
    assert.deepEqual(await groups('other', 'storey'), ['L0']);
    assert.ok(!(await groups('hello', 'storey')).includes('L0'));
    assert.deepEqual(await groups('other', 'material'), ['STEEL']);
    assert.ok(!(await groups('hello', 'material')).includes('STEEL'));
  });

  it('refuses to guess a model when model_id is omitted, naming the ids', async () => {
    const result = await call('query_entities', { type: 'IfcWall' });
    assert.equal(result.errorCode, 'MODEL_REQUIRED');
    assert.deepEqual((result.structured as { modelIds: string[] }).modelIds, ['hello', 'other']);
    assert.equal((await call('get_entity', { model_id: 'missing', express_id: 1 })).errorCode, 'MODEL_NOT_FOUND');
  });
});

async function ifcxStore() {
  const bytes = await fileBytes(HELLO_WALL_IFCX);
  const payload = await parseIfcxViewerModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.equal(payload.dataStore.schemaVersion, 'IFC5');
  assert.ok(payload.dataStore.source.byteLength > 0, 'IFCX keeps its JSON in source, which is what made it look like STEP');
  return payload.dataStore;
}

describe('IFCX on the main viewer host (#9523)', () => {
  it('a single IFCX model is no-step-source: its summary reads, STEP tools refuse instead of reporting default units', async () => {
    seed([model('ifcx', await ifcxStore(), { schemaVersion: 'IFC5' })]);
    const info = ok(await call('model_info')).structured as { schema: string; entityCount: number };
    assert.deepEqual([info.schema, info.entityCount > 0], ['IFC5', true]);
    for (const tool of ['units', 'query_entities', 'materials_list']) {
      const refused = await call(tool);
      assert.equal(refused.errorCode, 'UNSUPPORTED_OPERATION', tool);
      assert.equal(status(refused), 'no-step-source', tool);
    }
  });

  it('a federated IFCX composition answers once, under the base layer edits are keyed to', async () => {
    const store = await ifcxStore();
    // The shape `publishFederatedIfcxComposition` writes: layers in order, one
    // shared store, idOffset 0, and only the base (last) layer with a parse range.
    const layer = (id: string, base: boolean): FederatedModel => model(id, store, {
      schemaVersion: 'IFC5', idOffset: 0, maxExpressId: base ? 5_000 : 0,
      ...({ _isOverlay: !base } as Partial<FederatedModel>),
    });
    seed([layer('overlay', false), layer('base', true)]);

    const list = ok(await call('model_list')).structured as { models: Array<{ id: string; status?: string; entityCount: number | null; composedInto?: string }> };
    assert.deepEqual(list.models.map((m) => [m.id, m.status, m.composedInto]), [['overlay', 'composed-layer', 'base'], ['base', 'no-step-source', undefined]]);
    assert.equal(list.models[0].entityCount, null, 'a layer does not count the whole composition as its own');
    assert.ok((list.models[1].entityCount ?? 0) > 0);

    const layerInfo = await call('model_info', { model_id: 'overlay' });
    assert.equal(layerInfo.errorCode, 'UNSUPPORTED_OPERATION');
    assert.deepEqual(layerInfo.structured, { modelId: 'overlay', status: 'composed-layer', composedInto: 'base' });
    assert.equal((ok(await call('model_info')).structured as { id: string }).id, 'base', 'a composition alone in the viewer is the only model');
    // The viewer resolves a selection in the composition to the base layer, so that is where edits are keyed.
    assert.equal(useViewerStore.getState().resolveGlobalIdFromModels(1)?.modelId, 'base');
  });
});
