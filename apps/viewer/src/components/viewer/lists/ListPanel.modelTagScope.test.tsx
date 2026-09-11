/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A list's model tag scope through the real panel (issue #4215): clicking
 * Run on a scoped list executes it over the tagged models only, and a scope
 * naming a deleted tag ends in the visible error box instead of a wider run.
 * Same harness as `ListPanel.wiring.test.tsx` (#4317).
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { ListDefinition, ListModelTagScope } from '@/lib/lists';
import { ListPanel } from './ListPanel.js';

/** One real IfcWall named after its model, so a row says where it came from. */
function buildStore(name: string): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(1, strings);
  builder.add(42, 'IFCWALL', '1abcdefghijklmnopqrstu', name, '', '', true, false);
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: 1,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType: new Map([['IFCWALL', [42]]]) },
    strings,
    entities: builder.build(),
    properties: undefined,
    quantities: undefined,
    relationships: { count: 0, getRelated: () => [] },
    spatialHierarchy: undefined,
  } as unknown as IfcDataStore;
}

function definition(modelTagScope: ListModelTagScope | undefined): ListDefinition {
  return {
    id: 'list-scoped',
    name: 'Scoped List',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entityTypes: [],
    conditions: [],
    modelTagScope,
    columns: [
      { id: 'col-1', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'NeverThere', label: 'Missing' },
    ],
  } as unknown as ListDefinition;
}

const STRUCTURE = 'tag-structure';

function seedStore(def: ListDefinition) {
  useViewerStore.setState({
    models: new Map([
      ['model-a', { id: 'model-a', name: 'model-a', visible: true, idOffset: 0, ifcDataStore: buildStore('Wall A') } as never],
      ['model-b', { id: 'model-b', name: 'model-b', visible: true, idOffset: 0, ifcDataStore: buildStore('Wall B') } as never],
    ]),
    activeModelId: 'model-a',
    modelTags: new Map([[STRUCTURE, { id: STRUCTURE, name: 'Structure' }]]),
    modelTagAssignments: new Map([['model-a', new Set([STRUCTURE])]]),
    listDefinitions: [def],
    activeListId: null,
    listResult: null,
    listExecuting: false,
    listError: null,
    listPanelVisible: true,
    pendingListDraft: null,
    zoneSets: [],
    zoneAssignments: {} as never,
    zoneApportionment: undefined,
  } as never);
}

async function run(def: ListDefinition): Promise<HTMLElement> {
  seedStore(def);
  const container = render(<ListPanel />);
  const button = container.querySelector(`button[aria-label="Run list ${def.name}"]`);
  assert.ok(button, 'expected a Run button');
  click(button);
  await advance(60); // handleExecuteList runs inside requestAnimationFrame
  return container;
}

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('ListPanel — model tag scope (#4215)', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => { cleanup(); useViewerStore.setState(initialState, true); });

  it('fixture sanity: without a scope the list runs over both models', async () => {
    await run(definition(undefined));
    const { listResult, listError } = useViewerStore.getState();
    assert.equal(listError, null);
    assert.deepEqual(listResult?.rows.map((r) => r.modelId).sort(), ['model-a', 'model-b']);
  });

  it('"has any of Structure" runs over the tagged model only', async () => {
    await run(definition({ op: 'hasAny', tagIds: [STRUCTURE] }));
    const { listResult, listError } = useViewerStore.getState();
    assert.equal(listError, null);
    assert.deepEqual(listResult?.rows.map((r) => r.modelId), ['model-a']);
  });

  it('"untagged" runs over the other one', async () => {
    await run(definition({ op: 'untagged', tagIds: [] }));
    assert.deepEqual(useViewerStore.getState().listResult?.rows.map((r) => r.modelId), ['model-b']);
  });

  it('a scope naming a deleted tag is refused visibly, not widened to every model', async () => {
    const container = await run(definition({ op: 'hasNone', tagIds: ['tag-gone'] }));
    const state = useViewerStore.getState();
    assert.equal(state.listExecuting, false);
    assert.equal(state.listResult, null, 'no result — running over "every model" would be the silent widening');
    assert.match(state.listError ?? '', /no longer exists/);
    assert.match(container.textContent ?? '', /List failed/, 'the refusal must render');
  });

  it('a scope no loaded model satisfies is reported as such, not as an empty result', async () => {
    const def = definition({ op: 'hasAny', tagIds: [STRUCTURE] });
    seedStore(def);
    useViewerStore.setState({ modelTagAssignments: new Map() }); // the tag exists; no model carries it
    const container = render(<ListPanel />);
    click(container.querySelector('button[aria-label="Run list Scoped List"]')!);
    await advance(60);
    const state = useViewerStore.getState();
    assert.equal(state.listResult, null);
    assert.match(state.listError ?? '', /No loaded model matches.*Structure.*Nothing was run/s);
    assert.match(container.textContent ?? '', /List failed/);
  });
});
