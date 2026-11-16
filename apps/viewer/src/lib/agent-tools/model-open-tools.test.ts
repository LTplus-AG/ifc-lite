/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_open_model`: the grant, argument checks, the unexported-edits
 * refusal, routing to the replace/add bus events, waiting for the load to
 * settle and reporting the new model_id, and load errors. The loaders behind
 * the bus events are faked by listeners that drive the store like they do.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { EVENT_ADD_MODEL, EVENT_LOAD_FILE } from '@/lib/tours/events';
import { modelOpenTools, MODEL_OPEN_SPECS } from './model-open-tools';
import { VIEWER_COMMAND_SPECS } from './viewer-command-tools';
import type { ToolCallContext, ToolHost, ToolOutput } from './types';

const tool = modelOpenTools.viewer_open_model;
const granted: ToolCallContext = { canEdit: () => true };
const run = (args: Record<string, unknown>, ctx: ToolCallContext = granted) =>
  (tool as { run(h: ToolHost, a: Record<string, unknown>, c: ToolCallContext): Promise<ToolOutput> }).run({} as ToolHost, args, ctx);

const realFetch = globalThis.fetch;
let fetched: string[] = [];
let events: Array<{ type: string; name: string }> = [];
let behaviour: 'load' | 'error' = 'load';

function model(id: string, name: string) {
  return { id, name, schemaVersion: 'IFC4' };
}

function onLoad(replace: boolean) {
  return (e: Event) => {
    const file = (e as CustomEvent<File>).detail;
    events.push({ type: e.type, name: file.name });
    // Like useIfcLoader: clearing the previous error bumps loadErrorSeq before the load runs.
    useViewerStore.getState().setError(null);
    useViewerStore.setState({ loading: true });
    queueMicrotask(() => {
      if (behaviour === 'error') {
        useViewerStore.setState((s) => ({ loading: false, error: 'bad STEP', loadErrorSeq: s.loadErrorSeq + 1 }));
        return;
      }
      const models = new Map(replace ? [] : useViewerStore.getState().models);
      models.set(`m-${events.length}`, model(`m-${events.length}`, file.name) as never);
      useViewerStore.setState({ loading: false, models: models as never });
    });
  };
}
const replaceListener = onLoad(true);
const addListener = onLoad(false);

beforeEach(() => {
  fetched = []; events = []; behaviour = 'load';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(new Uint8Array([73, 83, 79]), { status: 200 });
  }) as typeof fetch;
  window.addEventListener(EVENT_LOAD_FILE, replaceListener);
  window.addEventListener(EVENT_ADD_MODEL, addListener);
  useViewerStore.setState({ models: new Map() as never, ifcDataStore: null, loading: false, geometryStreamingActive: false, mutationViews: new Map() as never, georefMutations: new Map() as never });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.removeEventListener(EVENT_LOAD_FILE, replaceListener);
  window.removeEventListener(EVENT_ADD_MODEL, addListener);
  useViewerStore.setState({ models: new Map() as never, loading: false });
});

describe('viewer_open_model', () => {
  it('is offered to the bridge as a tool that needs the grant', () => {
    assert.equal(VIEWER_COMMAND_SPECS.viewer_open_model, MODEL_OPEN_SPECS.viewer_open_model);
    assert.equal(MODEL_OPEN_SPECS.viewer_open_model.readOnly, false);
  });

  it('refuses without the commands-and-edits grant', async () => {
    await assert.rejects(run({ sample: 'demo' }, { canEdit: () => false }), { code: 'READ_ONLY' });
    assert.deepEqual(events, []);
  });

  it('opens a bundled sample into an empty viewer and returns its model_id', async () => {
    const out = await run({ sample: 'demo' });
    assert.deepEqual(events, [{ type: EVENT_LOAD_FILE, name: 'building-architecture.ifc' }]);
    assert.match(fetched[0], /\/samples\/building-architecture\.ifc$/);
    assert.deepEqual(out.structured, { mode: 'replace', models: [{ model_id: 'm-1', name: 'building-architecture.ifc', schema: 'IFC4', new: true }] });
    assert.match(out.text, /model_id m-1/);
  });

  it('asks for a mode once models are loaded, and federates with add', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    await assert.rejects(run({ sample: 'hello-wall' }), { code: 'INVALID_INPUT', message: /mode/ });
    const out = await run({ sample: 'hello-wall', mode: 'add' });
    assert.equal(events[0].type, EVENT_ADD_MODEL);
    assert.deepEqual((out.structured as { models: Array<{ model_id: string; new: boolean }> }).models.map((m) => [m.model_id, m.new]),
      [['old', false], ['m-1', true]]);
  });

  it('refuses to replace models with unexported edits', async () => {
    useViewerStore.setState({
      models: new Map([['old', model('old', 'a.ifc')]]) as never,
      georefMutations: new Map([['old', { projectedCRS: { Name: 'EPSG:2056' } }]]) as never,
    });
    await assert.rejects(run({ sample: 'demo', mode: 'replace' }), { code: 'STATE_CHANGED', message: /1 unexported change/ });
    assert.deepEqual(events, []);
  });

  it('fetches an https URL without credentials and rejects other schemes and non-model files', async () => {
    await run({ url: 'https://example.com/files/tower.ifc' });
    assert.deepEqual(events, [{ type: EVENT_LOAD_FILE, name: 'tower.ifc' }]);
    assert.equal(fetched[0], 'https://example.com/files/tower.ifc');
    await assert.rejects(run({ url: 'ftp://example.com/a.ifc', mode: 'add' }), { code: 'INVALID_INPUT' });
    await assert.rejects(run({ url: 'https://user:pw@example.com/a.ifc', mode: 'add' }), { code: 'INVALID_INPUT', message: /credentials/ });
    await assert.rejects(run({ url: 'https://example.com/readme.txt', mode: 'add' }), { code: 'INVALID_INPUT', message: /not a model file/ });
  });

  it('checks its arguments', async () => {
    await assert.rejects(run({}), { code: 'INVALID_INPUT', message: /exactly one/ });
    await assert.rejects(run({ sample: 'demo', url: 'https://x/a.ifc' }), { code: 'INVALID_INPUT' });
    await assert.rejects(run({ sample: 'nope' }), { code: 'INVALID_INPUT', message: /Unknown sample/ });
    await assert.rejects(run({ sample: 'demo', extra: 1 }), { code: 'INVALID_INPUT' });
  });

  it('reports a failed load instead of hanging', async () => {
    behaviour = 'error';
    await assert.rejects(run({ sample: 'demo' }), { code: 'INTERNAL_ERROR', message: /bad STEP/ });
  });
});
