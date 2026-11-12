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
import { readFile } from 'node:fs/promises';
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
import { MAIN_VIEWER_TOOL_ALLOWLIST, dispatchMainViewerTool, mainViewerTool } from './main-viewer-dispatch.js';
import { mainViewerToolDefinitions } from './main-viewer-tool-definitions.js';

const HELLO_WALL = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
/** The id `parsePlaygroundModel` derives from the file name, so refs compare equal across hosts. */
const MODEL_ID = 'hello-wall';
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
    const allowed = new Set<string>(MAIN_VIEWER_TOOL_ALLOWLIST);
    const refused = supportedToolNames().filter((name) => !allowed.has(name));
    assert.ok(refused.includes('entity_set_property') && refused.includes('clash_check') && refused.includes('viewer_open'));
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

  it('advertises exactly the allowlist, read-only, with model_id on model tools and inline IDS', () => {
    const definitions = mainViewerToolDefinitions();
    assert.deepEqual(new Set(definitions.map((d) => d.name)), new Set(MAIN_VIEWER_TOOL_ALLOWLIST));
    for (const definition of definitions) {
      assert.equal(definition.readOnly, true, definition.name);
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
