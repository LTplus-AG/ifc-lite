/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main viewer's read-only agent tool host (#9523), against a seeded
 * `useViewerStore` holding real parsed models: unsaved edits made through the
 * store are what the tools read, GlobalIds resolve without walking the model,
 * and every model the tools cannot read gets a specific refusal rather than an
 * empty answer.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SOURCE_BYTES, type IfcDataStore } from '@ifc-lite/parser';
import { createMinimalGlbDataStore } from '@/hooks/ingest/viewerModelIngest';
import { useViewerStore } from '@/store';
import { modelGlobalIdOwner } from '@/components/viewer/properties/global-id-check';
import {
  WALL_GID, WALL_ID, call, configuredView, model, ok, parseHelloWall, parseStep, seed, status, viewerBim, viewerHost,
} from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from './main-viewer-dispatch.js';

const view = (id = 'hello') => {
  const found = useViewerStore.getState().mutationViews.get(id);
  assert.ok(found, `a mutation view is registered for ${id}`);
  return found;
};

describe('main viewer host reads the user\'s unsaved edits (#9523)', () => {
  beforeEach(async () => seed([model('hello', await parseHelloWall())]));

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

  it('an entity created this session resolves by its GlobalId, a deleted source entity does not', async () => {
    const created = view().createEntity('IfcBuildingElementProxy', ['3crtd000000000000000000', null, 'Created proxy']);
    const found = ok(await call('get_entity', { global_id: '3crtd000000000000000000' })).structured as { ref: { expressId: number }; type: string; name: string };
    assert.deepEqual([found.ref.expressId, found.type, found.name], [created.expressId, 'IfcBuildingElementProxy', 'Created proxy']);

    assert.equal(useViewerStore.getState().removeEntity('hello', WALL_ID), true);
    const gone = await call('get_entity', { global_id: WALL_GID });
    assert.equal(gone.errorCode, 'ENTITY_NOT_FOUND', 'the entity table still indexes it; the overlay tombstone must win');
    const bulk = ok(await call('get_entities_bulk', { global_ids: [WALL_GID, '3crtd000000000000000000'] })).structured as { entities: unknown[] };
    assert.equal(bulk.entities[0], null);
    assert.ok(bulk.entities[1]);
  });

  it('GlobalId lookups read only the overlay\'s own entities, never every entity in the model', async (t) => {
    // Two edited entities make the overlay's candidate set K = 2.
    const state = useViewerStore.getState();
    state.setAttribute('hello', WALL_ID, 'Name', 'Edited wall');
    state.setAttribute('hello', 1, 'Name', 'Edited project');
    const bim = viewerBim();
    const entity = t.mock.method(bim, 'entity');
    const host = viewerHost({}, bim);

    ok(await call('get_entity', { global_id: WALL_GID }, host));
    assert.ok(entity.mock.callCount() <= 2 + 1, `one lookup: K overlay reads + the answer, got ${entity.mock.callCount()}`);

    entity.mock.resetCalls();
    const ids = Array.from({ length: 200 }, () => WALL_GID);
    ok(await call('get_entities_bulk', { global_ids: ids }, host));
    assert.ok(entity.mock.callCount() <= 2 + ids.length, `200 lookups: K overlay reads once + one read per answer, got ${entity.mock.callCount()}`);
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

  it('bsdd_match asks bSDD about the effective class and refuses a deleted entity without asking', async () => {
    const asked: string[] = [];
    const host = viewerHost({ bsdd: {
      search: async () => [], fetchClassInfo: async () => null, getPropertySets: async () => new Map(),
      searchRelatedClasses: async (type: string) => { asked.push(type); return []; },
    } });
    const created = view().createEntity('IfcBuildingElementProxy', ['3crtd000000000000000000', null, 'Created proxy']);
    ok(await call('bsdd_match', { express_id: created.expressId }, host));
    ok(await call('bsdd_match', { global_id: '3crtd000000000000000000' }, host));
    assert.ok(useViewerStore.getState().setEntityType('hello', WALL_ID, 'IfcCovering'), 'the store accepted the retype');
    ok(await call('bsdd_match', { express_id: WALL_ID }, host));
    assert.deepEqual(asked, ['IfcBuildingElementProxy', 'IfcBuildingElementProxy', 'IfcCovering']);

    useViewerStore.getState().removeEntity('hello', created.expressId);
    const deleted = await call('bsdd_match', { express_id: created.expressId }, host);
    assert.equal(deleted.errorCode, 'ENTITY_NOT_FOUND');
    assert.equal((await call('bsdd_match', { express_id: 999_999 }, host)).errorCode, 'ENTITY_NOT_FOUND');
    assert.equal(asked.length, 3, 'no bSDD query for an entity that is not there');
  });
});

/** Two walls carrying one GlobalId, as real exports often do. */
const DUPLICATES = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('dup.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('2dupGlobalId0000000000',$,'First',$,$,$,$,$,.SOLIDWALL.);
#20=IFCWALL('2dupGlobalId0000000000',$,'Second',$,$,$,$,$,.SOLIDWALL.);
ENDSEC;
END-ISO-10303-21;
`;
const DUP = '2dupGlobalId0000000000';
const resolvesTo = async (globalId: string) => (ok(await call('get_entity', { global_id: globalId })).structured as { ref: { expressId: number } }).ref.expressId;

describe('main viewer host resolves duplicated GlobalIds (#9523)', () => {
  beforeEach(async () => seed([model('dup', await parseStep(new TextEncoder().encode(DUPLICATES)))]));

  it('unedited, a duplicated GlobalId resolves to the row the entity table indexes (the last)', async () => {
    assert.equal(await resolvesTo(DUP), 20);
  });

  it('deleting the indexed duplicate leaves the other one resolving', async () => {
    assert.equal(useViewerStore.getState().removeEntity('dup', 20), true);
    assert.equal(await resolvesTo(DUP), 10);
  });

  it('editing the indexed duplicate\'s GlobalId away: the old id resolves to the other row, the new id to the edited one', async () => {
    useViewerStore.getState().setAttribute('dup', 20, 'GlobalId', '3movedGlobalId00000000');
    assert.equal(await resolvesTo(DUP), 10);
    assert.equal(await resolvesTo('3movedGlobalId00000000'), 20);
  });

  it('an edit that leaves the GlobalId alone does not change which duplicate answers (review: a Name edit on #10 flipped G to #10)', async () => {
    const state = useViewerStore.getState();
    state.setAttribute('dup', 10, 'Name', 'Renamed first');
    assert.equal(await resolvesTo(DUP), 20, 'editing the other duplicate leaves the indexed row answering');
    state.setAttribute('dup', 20, 'Name', 'Renamed second');
    assert.equal(await resolvesTo(DUP), 20, 'editing the indexed duplicate leaves it answering');
    useViewerStore.getState().undo('dup');
    useViewerStore.getState().undo('dup');
    assert.equal(view('dup').hasPendingChanges(), false, 'both edits undone');
    assert.equal(await resolvesTo(DUP), 20);
  });

  it('an entity created with, or edited to, G outranks a parsed row still carrying G, as in modelGlobalIdOwner', async () => {
    const created = view('dup').createEntity('IfcWall', [DUP, null, 'Created']);
    assert.equal(await resolvesTo(DUP), created.expressId, 'rule 1: a session claimant wins over the parsed rows');
    assert.equal(modelGlobalIdOwner('dup')(DUP), created.expressId, 'the viewer\'s GlobalId owner agrees');
    // Edited away and back: the effective GlobalId equals the parsed one, so #10 is an ordinary row again.
    useViewerStore.getState().setAttribute('dup', 10, 'GlobalId', '3otherGlobalId00000000');
    useViewerStore.getState().setAttribute('dup', 10, 'GlobalId', DUP);
    assert.equal(await resolvesTo(DUP), created.expressId, 'an edit back to the parsed value is no claim');
    const second = view('dup').createEntity('IfcWall', [DUP, null, 'Created again']);
    assert.ok(second.expressId > created.expressId);
    assert.equal(await resolvesTo(DUP), created.expressId, 'two claimants: the lowest expressId');
  });

  it('with both duplicates gone, the GlobalId resolves to nothing', async () => {
    const state = useViewerStore.getState();
    state.removeEntity('dup', 20);
    state.setAttribute('dup', 10, 'GlobalId', '3movedGlobalId00000000');
    assert.equal((await call('get_entity', { global_id: DUP })).errorCode, 'ENTITY_NOT_FOUND');
  });
});

describe('main viewer host in legacy single-model mode (#9523)', () => {
  it('an edit keyed under __legacy__ is what default, legacy and __legacy__ read', async () => {
    const store = await parseHelloWall();
    useViewerStore.setState({
      models: new Map(), ifcDataStore: store, editEnabled: true,
      mutationViews: new Map([['__legacy__', configuredView(store, '__legacy__')]]),
      storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), mutationVersion: 0,
    });
    assert.ok(useViewerStore.getState().setProperty('__legacy__', WALL_ID, 'Pset_WallCommon', 'FireRating', 'REI60'), 'the store accepted the edit');
    const list = ok(await call('model_list')).structured as { models: Array<{ id: string }> };
    assert.deepEqual(list.models.map((m) => m.id), ['default']);
    for (const modelId of [undefined, 'default', 'legacy', '__legacy__']) {
      const unique = ok(await call('properties_unique', {
        type: 'IfcWall', pset: 'Pset_WallCommon', property: 'FireRating', ...(modelId ? { model_id: modelId } : {}),
      })).structured as { values: Array<{ value: string }> };
      assert.deepEqual(unique.values.map((v) => v.value), ['REI60'], `model_id=${modelId}`);
    }
  });
});

describe('main viewer host refuses models it cannot read (#9523)', () => {
  it('no model at all', async () => {
    seed([]);
    assert.equal((await call('query_entities')).errorCode, 'MODEL_NOT_FOUND');
    assert.equal(ok(await call('model_list')).text, 'No model loaded.');
  });

  it('a model still loading, one without IFC data, and synthetic point-cloud / LandXML stores', async () => {
    const synthetic = async () => ({ ...(await parseHelloWall()), source: EMPTY_SOURCE_BYTES } as IfcDataStore);
    seed([
      model('streaming', null, { loadState: 'streaming-geometry' }),
      model('glb', null),
      model('scan', await synthetic(), { loadPath: 'point-cloud' }),
      model('terrain', await synthetic(), { loadPath: 'landxml' }),
    ]);
    const loading = await call('get_entity', { model_id: 'streaming', express_id: 1 });
    assert.equal(loading.errorCode, 'UNSUPPORTED_OPERATION');
    assert.equal(status(loading), 'loading');
    assert.match(loading.hint ?? '', /Retry/);
    for (const id of ['glb', 'scan', 'terrain']) assert.equal(status(await call('model_info', { model_id: id })), 'no-data', id);
    const list = ok(await call('model_list')).structured as { models: Array<{ id: string; status?: string }> };
    assert.deepEqual(list.models.map((m) => [m.id, m.status]), [
      ['streaming', 'loading'], ['glb', 'no-data'], ['scan', 'no-data'], ['terrain', 'no-data'],
    ]);
  });

  it('a GLB added to a federation (minimal synthetic store, loadPath wasm) is no-data, not an empty IFC4 model', async () => {
    const glbBytes = new ArrayBuffer(2048);
    seed([
      model('hello', await parseHelloWall()),
      model('glb', createMinimalGlbDataStore(glbBytes, 3), { loadPath: 'wasm', loadFormat: 'glb', schemaVersion: 'IFC4' }),
    ]);
    const list = ok(await call('model_list')).structured as { models: Array<{ id: string; status?: string }> };
    assert.deepEqual(list.models.map((m) => [m.id, m.status]), [['hello', undefined], ['glb', 'no-data']]);
    for (const tool of ['model_info', 'units', 'query_entities']) {
      const refused = await call(tool, { model_id: 'glb' });
      assert.equal(refused.errorCode, 'UNSUPPORTED_OPERATION', tool);
      assert.equal(status(refused), 'no-data', tool);
    }
  });

  it('a server-processed model: model_info answers from its tables like the full parse; its entity tools refuse', async () => {
    const full = await parseHelloWall();
    seed([model('full', full), model('server', { ...(await parseHelloWall()), source: EMPTY_SOURCE_BYTES } as IfcDataStore, { loadPath: 'server' })]);
    const fromServer = ok(await call('model_info', { model_id: 'server' })).structured as { schema: string; entityCount: number; typeCountsTop20: unknown };
    const fromFull = ok(await call('model_info', { model_id: 'full' })).structured as { schema: string; entityCount: number; typeCountsTop20: unknown };
    assert.equal(fromServer.schema, 'IFC4');
    assert.ok(fromServer.entityCount > 0);
    assert.equal(fromServer.entityCount, fromFull.entityCount);
    assert.deepEqual(fromServer.typeCountsTop20, fromFull.typeCountsTop20);
    const query = await call('query_entities', { model_id: 'server', type: 'IfcWall' });
    assert.equal(query.errorCode, 'UNSUPPORTED_OPERATION');
    assert.equal(status(query), 'server-partial');
  });

  it('a store without STEP source: units and quantity measures refuse instead of assuming metres', async () => {
    seed([model('synthetic', { ...(await parseHelloWall()), source: EMPTY_SOURCE_BYTES } as IfcDataStore)]);
    for (const tool of ['units', 'geometry_volume', 'geometry_area']) {
      const result = await call(tool, { express_id: WALL_ID });
      assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION', tool);
      assert.equal(status(result), 'no-step-source', tool);
    }
  });
});

describe('main viewer host settles every call (#9523)', () => {
  beforeEach(async () => seed([model('hello', await parseHelloWall())]));

  it('a lookup that never answers settles as cancelled when the call is aborted', async () => {
    const never = new Promise<never>(() => undefined);
    const stalled = viewerHost({ bsdd: { search: () => never, fetchClassInfo: () => never, getPropertySets: () => never, searchRelatedClasses: () => never } });
    const controller = new AbortController();
    const pending = dispatchMainViewerTool(stalled, 'bsdd_search', { query: 'wall' }, { signal: controller.signal });
    controller.abort();
    assert.equal((await pending).errorCode, 'CANCELLED');
  });

  for (const change of ['closed', 'replaced'] as const) it(`a model ${change} during the call is an error, not an empty success`, async () => {
    const replacement = await parseHelloWall();
    const host = viewerHost({ bsdd: {
      search: async () => [], fetchClassInfo: async () => null, getPropertySets: async () => new Map(),
      searchRelatedClasses: async () => {
        const models = new Map(useViewerStore.getState().models);
        if (change === 'closed') models.delete('hello');
        else models.set('hello', model('hello', replacement));
        useViewerStore.setState({ models });
        return [];
      },
    } });
    const result = await call('bsdd_match', { express_id: WALL_ID }, host);
    assert.equal(result.errorCode, 'STATE_CHANGED');
    assert.equal((result.structured as { reason: string }).reason, change);
  });

  it('non-object arguments are an input error, not a throw', async () => {
    assert.equal((await dispatchMainViewerTool(viewerHost(), 'model_info', 'IfcWall')).errorCode, 'INVALID_INPUT');
    assert.equal((await dispatchMainViewerTool(viewerHost(), 'model_info', [1])).errorCode, 'INVALID_INPUT');
  });
});
