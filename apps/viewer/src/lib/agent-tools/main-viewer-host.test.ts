/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main viewer's read-only agent tool host (#9523), against a seeded
 * `useViewerStore` holding real parsed models: unsaved edits made through the
 * store are what the tools read, federated models never mix, and every model
 * the tools cannot read gets a specific refusal rather than an empty answer.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore, type FederatedModel } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { fixtureModel } from '@/test/store-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { createMainViewerToolHost } from './main-viewer-host.js';
import { dispatchMainViewerTool, type AgentToolResult } from './main-viewer-dispatch.js';

const HELLO_WALL = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WALL_ID = 1222;
const WALL_GID = '2JUHrTM_j3UxZiBnyBfByx';

/** A second, unrelated model for federation: one wall named 'Other wall'. */
const OTHER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('other.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#50=IFCWALL('1wall00000000000000000',$,'Other wall',$,$,#41,$,$,.SOLIDWALL.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont00000000000000000',$,$,$,(#50),#40);
ENDSEC;
END-ISO-10303-21;
`;

async function helloWallBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(HELLO_WALL));
}

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
  store.fileSize = bytes.byteLength;
  return store;
}

function model(id: string, store: IfcDataStore | null, extra: Partial<FederatedModel> = {}): FederatedModel {
  return {
    ...fixtureModel(id),
    name: `${id}.ifc`,
    fileSize: store?.fileSize ?? 0,
    ifcDataStore: store,
    loadState: 'complete',
    ...extra,
  } as FederatedModel;
}

/** Seed the store the way the viewer wires a loaded model: one configured overlay per IFC store. */
function seed(models: FederatedModel[]): void {
  const views = new Map<string, MutablePropertyView>();
  for (const m of models) {
    if (!m.ifcDataStore) continue;
    const view = new MutablePropertyView(m.ifcDataStore.properties || null, m.id);
    configureMutationView(view, m.ifcDataStore);
    views.set(m.id, view);
  }
  useViewerStore.setState({
    models: new Map(models.map((m) => [m.id, m])),
    activeModelId: models[0]?.id ?? null,
    ifcDataStore: null,
    editEnabled: true,
    mutationViews: views,
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    mutationVersion: 0,
  });
}

function host() {
  return createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
}

async function call(tool: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> {
  return dispatchMainViewerTool(host(), tool, args);
}

function ok(result: AgentToolResult): AgentToolResult {
  assert.equal(result.isError, false, `${result.errorCode ?? ''} ${result.text}`);
  return result;
}

describe('main viewer host reads the user\'s unsaved edits (#9523)', () => {
  beforeEach(async () => seed([model('hello', await parse(await helloWallBytes()))]));

  it('a property and a Name set through the store are what get_entity, query_entities and properties_unique return', async () => {
    const state = useViewerStore.getState();
    assert.ok(state.setProperty('hello', WALL_ID, 'Pset_WallCommon', 'FireRating', 'REI60'), 'the store accepted the edit');
    state.setAttribute('hello', WALL_ID, 'Name', 'Edited wall');

    const entity = ok(await call('get_entity', { global_id: WALL_GID })).structured as { name: string };
    assert.equal(entity.name, 'Edited wall');

    const walls = ok(await call('query_entities', { type: 'IfcWall' })).structured as { entities: Array<{ expressId: number; name: string }> };
    assert.deepEqual(walls.entities.map((e) => [e.expressId, e.name]), [[WALL_ID, 'Edited wall']]);

    const unique = ok(await call('properties_unique', { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'FireRating' })).structured as {
      values: Array<{ value: string; count: number }>;
    };
    assert.deepEqual(unique.values, [{ value: 'REI60', count: 1 }]);
  });

  it('resolves an edited GlobalId, refuses the old one, and counts a removed entity out', async () => {
    const before = (ok(await call('model_info')).structured as { entityCount: number }).entityCount;
    const state = useViewerStore.getState();
    state.setAttribute('hello', WALL_ID, 'GlobalId', '3newGlobalId0000000000');
    assert.equal((ok(await call('get_entity', { global_id: '3newGlobalId0000000000' })).structured as { ref: { expressId: number } }).ref.expressId, WALL_ID);
    assert.equal((await call('get_entity', { global_id: WALL_GID })).errorCode, 'ENTITY_NOT_FOUND');

    assert.equal(state.removeEntity('hello', WALL_ID), true, 'the store removed the wall');
    const after = (ok(await call('model_info')).structured as { entityCount: number }).entityCount;
    assert.equal(after, before - 1);
    assert.equal((ok(await call('query_entities', { type: 'IfcWall' })).structured as { count: number }).count, 0);
  });

  it('validates inline IDS against the edited model and refuses an IDS path', async () => {
    const ids = `<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>Fire rating</title></info><specifications><specification name="wall fire rating" ifcVersion="IFC4"><applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability><requirements><property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName><value><simpleValue>REI60</simpleValue></value></property></requirements></specification></specifications></ids>`;
    const passed = async () => (ok(await call('ids_validate', { ids_xml: ids })).structured as { summary: { passedSpecifications: number } }).summary.passedSpecifications;
    assert.equal(await passed(), 0, 'the parsed file has no FireRating');
    useViewerStore.getState().setProperty('hello', WALL_ID, 'Pset_WallCommon', 'FireRating', 'REI60');
    assert.equal(await passed(), 1, 'the unsaved property edit satisfies the spec');
    const path = await call('ids_validate', { ids_path: 'spec.ids' });
    assert.equal(path.errorCode, 'INVALID_INPUT');
    assert.match(path.text, /ids_xml/);
  });
});

describe('main viewer host keeps federated models apart (#9523)', () => {
  beforeEach(async () => seed([
    model('hello', await parse(await helloWallBytes())),
    model('other', await parse(new TextEncoder().encode(OTHER))),
  ]));

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

  it('refuses to guess a model when model_id is omitted, naming the ids', async () => {
    const result = await call('query_entities', { type: 'IfcWall' });
    assert.equal(result.errorCode, 'MODEL_REQUIRED');
    assert.deepEqual((result.structured as { modelIds: string[] }).modelIds, ['hello', 'other']);
    assert.equal((await call('get_entity', { model_id: 'missing', express_id: 1 })).errorCode, 'MODEL_NOT_FOUND');
  });

  it('serves the legacy single-model store under its own id and the legacy aliases', async () => {
    const store = await parse(await helloWallBytes());
    useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map() });
    const list = ok(await call('model_list')).structured as { models: Array<{ id: string }> };
    assert.deepEqual(list.models.map((m) => m.id), ['default']);
    for (const modelId of [undefined, 'default', 'legacy', '__legacy__']) {
      const walls = ok(await call('query_entities', { type: 'IfcWall', ...(modelId ? { model_id: modelId } : {}) })).structured as { count: number };
      assert.equal(walls.count, 1, `model_id=${modelId}`);
    }
  });
});

describe('main viewer host refuses models it cannot read (#9523)', () => {
  it('no model at all', async () => {
    seed([]);
    assert.equal((await call('query_entities')).errorCode, 'MODEL_NOT_FOUND');
    assert.equal(ok(await call('model_list')).text, 'No model loaded.');
  });

  it('a model still loading, and one loaded without IFC data', async () => {
    seed([
      model('streaming', null, { loadState: 'streaming-geometry' }),
      model('glb', null, { loadState: 'complete' }),
    ]);
    const loading = await call('get_entity', { model_id: 'streaming', express_id: 1 });
    assert.equal(loading.errorCode, 'UNSUPPORTED_OPERATION');
    assert.equal((loading.structured as { status: string }).status, 'loading');
    assert.match(loading.hint ?? '', /Retry/);
    const glb = await call('model_info', { model_id: 'glb' });
    assert.equal((glb.structured as { status: string }).status, 'no-data');
    const list = ok(await call('model_list')).structured as { models: Array<{ id: string; status?: string; entityCount: number | null }> };
    assert.deepEqual(list.models.map((m) => [m.id, m.status, m.entityCount]), [['streaming', 'loading', null], ['glb', 'no-data', null]]);
  });

  it('a server-processed model: its summary reads, its entity tools refuse', async () => {
    const store = await parse(await helloWallBytes());
    seed([model('server', { ...store, source: EMPTY_SOURCE_BYTES } as IfcDataStore, { loadPath: 'server' })]);
    ok(await call('model_info'));
    const query = await call('query_entities', { type: 'IfcWall' });
    assert.equal(query.errorCode, 'UNSUPPORTED_OPERATION');
    assert.equal((query.structured as { status: string }).status, 'server-partial');
  });

  it('a store without STEP source: units and quantity measures refuse instead of assuming metres', async () => {
    const store = await parse(await helloWallBytes());
    seed([model('synthetic', { ...store, source: EMPTY_SOURCE_BYTES } as IfcDataStore)]);
    for (const tool of ['units', 'geometry_volume', 'geometry_area']) {
      const result = await call(tool, { express_id: WALL_ID });
      assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION', tool);
      assert.equal((result.structured as { status: string }).status, 'no-step-source', tool);
    }
  });
});

describe('main viewer host settles every call (#9523)', () => {
  beforeEach(async () => seed([model('hello', await parse(await helloWallBytes()))]));

  it('a lookup that never answers settles as cancelled when the call is aborted', async () => {
    const never = new Promise<never>(() => undefined);
    const stalled = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }), {
      bsdd: { search: () => never, fetchClassInfo: () => never, getPropertySets: () => never, searchRelatedClasses: () => never },
    });
    const controller = new AbortController();
    const pending = dispatchMainViewerTool(stalled, 'bsdd_search', { query: 'wall' }, { signal: controller.signal });
    controller.abort();
    assert.equal((await pending).errorCode, 'CANCELLED');
  });

  it('non-object arguments are an input error, not a throw', async () => {
    assert.equal((await dispatchMainViewerTool(host(), 'model_info', 'IfcWall')).errorCode, 'INVALID_INPUT');
    assert.equal((await dispatchMainViewerTool(host(), 'model_info', [1])).errorCode, 'INVALID_INPUT');
  });
});
