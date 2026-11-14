/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the main viewer's agent surface admits (#9523): only `read` catalog
 * tools, every other implemented tool refused before it runs, and the same
 * answers as the playground for the same unedited file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore, type FederatedModel } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { fixtureModel } from '@/test/store-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { CATALOG } from '@/components/mcp/data';
import { dispatch, parsePlaygroundModel, supportedToolNames } from '@/components/mcp/playground-dispatcher';
import { createMainViewerToolHost } from './main-viewer-host.js';
import { MAIN_VIEWER_EDIT_TOOLS, MAIN_VIEWER_TOOL_ALLOWLIST, dispatchMainViewerTool, mainViewerTool } from './main-viewer-dispatch.js';
import { mainViewerToolDefinitions } from './main-viewer-tool-definitions.js';

const HELLO_WALL = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
/** The id `parsePlaygroundModel` derives from the file name, so refs compare equal across hosts. */
const MODEL_ID = 'hello-wall';
const WALL_GID = '2JUHrTM_j3UxZiBnyBfByx';
const WALL_ID = 1222;

async function seedMainViewer(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
  store.fileSize = bytes.byteLength;
  const view = new MutablePropertyView(store.properties || null, MODEL_ID);
  configureMutationView(view, store);
  const model = { ...fixtureModel(MODEL_ID), name: 'hello-wall.ifc', fileSize: bytes.byteLength, ifcDataStore: store, loadState: 'complete' } as FederatedModel;
  useViewerStore.setState({
    models: new Map([[MODEL_ID, model]]),
    activeModelId: MODEL_ID,
    ifcDataStore: null,
    editEnabled: true,
    mutationViews: new Map([[MODEL_ID, view]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    mutationVersion: 0,
  });
  return createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
}

describe('main viewer tool allowlist (#9523)', () => {
  it('admits only read-scope catalog tools, each with a shared implementation', () => {
    const scopes = new Map(CATALOG.tools.map((tool) => [tool.name, tool.scope]));
    for (const name of MAIN_VIEWER_TOOL_ALLOWLIST) {
      assert.equal(scopes.get(name), 'read', `${name} must be a read-scope catalog tool to be served from the viewer`);
      assert.ok(mainViewerTool(name), `${name} has no shared implementation`);
    }
  });

  it('refuses every other tool the playground implements, before it runs', async () => {
    const host = await seedMainViewer(new Uint8Array(await readFile(HELLO_WALL)));
    // The edit tools are served, but only with a grant: main-viewer-edits.test.ts covers them.
    const allowed = new Set<string>([...MAIN_VIEWER_TOOL_ALLOWLIST, ...MAIN_VIEWER_EDIT_TOOLS]);
    const refused = supportedToolNames().filter((name) => !allowed.has(name));
    assert.ok(refused.includes('entity_delete') && refused.includes('clash_check') && refused.includes('viewer_open'));
    for (const name of refused) {
      assert.equal(mainViewerTool(name), undefined, name);
      const args = { express_id: WALL_ID, pset: 'Pset_WallCommon', name: 'IsExternal', value: false, attribute: 'Name', type: 'IfcWall', title: 't' };
      const result = await dispatchMainViewerTool(host, name, args);
      assert.equal(result.isError, true, name);
      const scope = CATALOG.tools.find((tool) => tool.name === name)?.scope;
      assert.equal(result.errorCode, scope === 'mutate' ? 'READ_ONLY' : 'UNSUPPORTED_OPERATION', name);
    }
    assert.equal(useViewerStore.getState().mutationViews.get(MODEL_ID)?.hasPendingChanges(), false, 'no refused call reached the model');
    assert.equal((await dispatchMainViewerTool(host, 'no_such_tool', {})).errorCode, 'INVALID_INPUT');
  });

  it('advertises exactly the allowlist (read-only) and the edit tools, with model_id on model tools and inline IDS', () => {
    const definitions = mainViewerToolDefinitions();
    assert.deepEqual(new Set(definitions.map((d) => d.name)), new Set([...MAIN_VIEWER_TOOL_ALLOWLIST, ...MAIN_VIEWER_EDIT_TOOLS]));
    const edits = new Set<string>(MAIN_VIEWER_EDIT_TOOLS);
    for (const definition of definitions) {
      assert.equal(definition.readOnly, !edits.has(definition.name), definition.name);
      assert.equal(definition.inputSchema.type, 'object', definition.name);
      if (mainViewerTool(definition.name)?.needs !== 'none') assert.ok(definition.inputSchema.properties.model_id, `${definition.name} takes model_id`);
    }
    const ids = definitions.find((d) => d.name === 'ids_validate');
    assert.ok(ids?.inputSchema.required?.includes('ids_xml'));
    assert.equal(ids?.inputSchema.properties.ids_path, undefined);
  });
});

describe('main viewer and playground answer alike for the same unedited file (#9523)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['model_info', {}],
    ['model_list', {}],
    ['query_entities', { type: 'IfcWall' }],
    ['count_entities', { group_by: 'type' }],
    ['count_entities', { group_by: 'storey' }],
    ['get_entity', { express_id: WALL_ID }],
    ['spatial_hierarchy', {}],
    ['containment_chain', { express_id: WALL_ID }],
    ['properties_unique', { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'IsExternal' }],
    ['materials_list', {}],
    ['units', {}],
    ['georeferencing', {}],
    ['model_audit', {}],
  ];

  it(`${cases.length} read calls give equal text and structured results`, async () => {
    const bytes = new Uint8Array(await readFile(HELLO_WALL));
    const playground = await parsePlaygroundModel(bytes.slice().buffer, 'hello-wall.ifc');
    assert.equal(playground.id, MODEL_ID);
    const host = await seedMainViewer(bytes);
    for (const [tool, args] of cases) {
      const fromPlayground = await dispatch(playground, tool, args);
      const fromViewer = await dispatchMainViewerTool(host, tool, args);
      assert.equal(fromPlayground.isError, false, `${tool}: ${fromPlayground.text}`);
      assert.equal(fromViewer.isError, false, `${tool}: ${fromViewer.text}`);
      assert.equal(fromViewer.text, fromPlayground.text, tool);
      assert.deepEqual(fromViewer.structured, fromPlayground.structured, tool);
    }
  });
});

describe('main viewer tools leave the viewer\'s state alone (#9523)', () => {
  /** A real specification that applies to the fixture's wall and reads its Pset_WallCommon. */
  const IDS = `<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>External walls</title></info><specifications><specification name="wall is external" ifcVersion="IFC4"><applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability><requirements><property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>IsExternal</simpleValue></baseName></property></requirements></specification></specifications></ids>`;
  /** Arguments that reach each tool's implementation on hello-wall (tools absent here take none). */
  const ARGS: Record<string, Record<string, unknown>> = {
    schema_describe: { type: 'IfcWall' },
    query_entities: { type: 'IfcWall' },
    count_entities: { group_by: 'storey' },
    get_entity: { global_id: WALL_GID },
    get_entities_bulk: { global_ids: [WALL_GID] },
    containment_chain: { express_id: WALL_ID },
    relationships: { express_id: WALL_ID },
    properties_unique: { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'IsExternal' },
    geometry_bbox: { express_id: WALL_ID },
    geometry_volume: { express_id: WALL_ID },
    geometry_area: { express_id: WALL_ID },
    ids_explain: { ids_xml: IDS },
    ids_validate: { ids_xml: IDS },
    bsdd_search: { query: 'wall' },
    bsdd_class: { ifc_type: 'IfcWall' },
    bsdd_property_sets: { ifc_type: 'IfcWall' },
    bsdd_match: { global_id: WALL_GID },
    cost_evaluate: { express_id: WALL_ID, target: 'item' },
  };
  /** What each tool must show it read, so an early return cannot pass as having run. */
  const READ: Record<string, (structured: unknown) => boolean> = {
    query_entities: (r) => (r as { count: number }).count === 1,
    get_entity: (r) => (r as { ref: { expressId: number } }).ref.expressId === WALL_ID,
    get_entities_bulk: (r) => (r as { entities: unknown[] }).entities[0] != null,
    properties_unique: (r) => (r as { total: number }).total === 1,
    materials_list: (r) => (r as { materials: unknown[] }).materials.length > 0,
    ids_validate: (r) => (r as { summary: { totalSpecifications: number } }).summary.totalSpecifications === 1,
    bsdd_match: (r) => (r as { ifcType: string }).ifcType === 'IfcWall',
    bsdd_class: (r) => (r as { code: string }).code === 'IfcWall',
  };

  it('all 27 allowlisted tools succeed without changing history, dirtiness, selection, visibility or the overlay', async () => {
    await seedMainViewer(new Uint8Array(await readFile(HELLO_WALL)));
    const bsddCalls: string[] = [];
    const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }), { bsdd: {
      search: async (query: string) => { bsddCalls.push('search'); return [{ code: 'IfcWall', name: query, uri: 'u', dictionaryUri: 'd' }] as never; },
      fetchClassInfo: async (type: string) => { bsddCalls.push('class'); return { code: type, name: type, classProperties: [] } as never; },
      getPropertySets: async () => { bsddCalls.push('psets'); return new Map([['Pset_WallCommon', []]]) as never; },
      searchRelatedClasses: async () => { bsddCalls.push('related'); return []; },
    } });
    const KEYS = ['mutationVersion', 'undoStacks', 'redoStacks', 'dirtyModels', 'selectedEntityId', 'selectedEntityIds', 'selectedEntity',
      'hiddenEntities', 'isolatedEntities', 'mutationViews', 'models'] as const;
    const pick = () => {
      const state = useViewerStore.getState() as unknown as Record<string, unknown>;
      return Object.fromEntries(KEYS.map((key) => [key, state[key]]));
    };
    const before = pick();
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view);
    const mutationsBefore = view.getMutationCount();
    const succeeded: string[] = [];
    for (const name of MAIN_VIEWER_TOOL_ALLOWLIST) {
      const result = await dispatchMainViewerTool(host, name, ARGS[name] ?? {});
      // No expected refusals: every tool must reach and complete its implementation.
      assert.equal(result.isError, false, `${name}: ${result.errorCode} ${result.text}`);
      if (READ[name]) assert.ok(READ[name](result.structured), `${name} answered without reading the model: ${JSON.stringify(result.structured).slice(0, 200)}`);
      succeeded.push(name);
    }
    assert.deepEqual(succeeded, [...MAIN_VIEWER_TOOL_ALLOWLIST]);
    assert.deepEqual(bsddCalls, ['search', 'class', 'psets', 'related'], 'each bSDD tool reached the client');
    const after = pick();
    for (const key of KEYS) assert.equal(after[key], before[key], `${key} was replaced by a read tool`);
    assert.equal(view.getMutationCount(), mutationsBefore);
    assert.equal(view.hasPendingChanges(), false);
  });
});

describe('cost tools on the main viewer host match the playground (#9523)', () => {
  const path = fileURLToPath(new URL('../../../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
  const available = existsSync(path);
  if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

  it('cost_data and cost_evaluate read the same values through both hosts', { skip: !available }, async () => {
    const bytes = new Uint8Array(await readFile(path));
    const playground = await parsePlaygroundModel(bytes.slice().buffer, 'cost.ifc');
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(store.properties || null, 'cost');
    configureMutationView(view, store);
    useViewerStore.setState({
      models: new Map([['cost', { ...fixtureModel('cost'), name: 'cost.ifc', fileSize: bytes.byteLength, ifcDataStore: store, loadState: 'complete' } as FederatedModel]]),
      ifcDataStore: null, mutationViews: new Map([['cost', view]]),
    });
    const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    for (const [tool, args] of [['cost_data', {}], ['cost_evaluate', { target: 'item', express_id: 42 }]] as const) {
      const fromViewer = await dispatchMainViewerTool(host, tool, args);
      const fromPlayground = await dispatch(playground, tool, args);
      assert.equal(fromViewer.isError, false, `${tool}: ${fromViewer.text}`);
      assert.deepEqual(fromViewer.structured, fromPlayground.structured, tool);
    }
    const evaluated = (await dispatchMainViewerTool(host, 'cost_evaluate', { target: 'item', express_id: 42 })).structured as { evaluation: { Amount: string } };
    assert.equal(evaluated.evaluation.Amount, '2250');
  });
});
