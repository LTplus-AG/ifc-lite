/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_open_model`: the grant, argument checks, the unexported-edits
 * refusal, routing to the registered replace/add/stack loaders, waiting for
 * the load to settle and reporting the new model_id, and load errors. The
 * loaders are faked by functions that drive the store like the real ones do.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { registerAgentModelLoader } from '@/lib/agent-bridge/model-loader-host';
import { modelOpenTools, MODEL_OPEN_SPECS, OPEN_MODEL_WAIT_MS } from './model-open-tools';
import { VIEWER_COMMAND_SPECS } from './viewer-command-tools';
import type { ToolCallContext, ToolHost, ToolOutput } from './types';

const tool = modelOpenTools.viewer_open_model;
const granted: ToolCallContext = { canEdit: () => true };
const run = (args: Record<string, unknown>, ctx: ToolCallContext = granted) =>
  (tool as { run(h: ToolHost, a: Record<string, unknown>, c: ToolCallContext): Promise<ToolOutput> }).run({} as ToolHost, args, ctx);

const realFetch = globalThis.fetch;
let fetched: string[] = [];
let respond: () => Response;
let calls: Array<{ kind: 'replace' | 'add' | 'stack'; names: string[] }> = [];
let behaviour: 'load' | 'error' | 'nothing' | 'hang' | 'closed' | 'unrelated-error' = 'load';
let unregister: () => void = () => {};

function model(id: string, name: string) {
  return { id, name, schemaVersion: 'IFC4' };
}

/** Drives the store the way useIfcLoader / useIfcFederation do. */
async function fakeLoad(kind: 'replace' | 'add' | 'stack', files: File[], onError?: (message: string) => void): Promise<string | null> {
  calls.push({ kind, names: files.map((f) => f.name) });
  // Like useIfcLoader: clearing the previous error bumps loadErrorSeq before the load runs.
  useViewerStore.getState().setError(null);
  useViewerStore.setState({ loading: true });
  if (behaviour === 'hang') return new Promise(() => {});
  await Promise.resolve();
  if (behaviour === 'nothing') { useViewerStore.setState({ loading: false }); return 'none'; }
  const models = new Map(kind === 'add' ? useViewerStore.getState().models : []);
  const id = `m-${calls.length}-${files[0].name}`;
  if (behaviour === 'error') {
    // The primary loader keeps its placeholder record, marked failed; an add reports to its own onError and resolves null.
    if (kind !== 'add') models.set(id, { ...model(id, files[0].name), loadState: 'error', loadError: 'bad STEP' } as never);
    useViewerStore.setState({ models: models as never });
    useViewerStore.getState().setError('bad STEP');
    useViewerStore.setState({ loading: false });
    onError?.('bad STEP');
    return null;
  }
  for (const f of files) models.set(`m-${calls.length}-${f.name}`, model(`m-${calls.length}-${f.name}`, f.name) as never);
  useViewerStore.setState({ loading: false, models: models as never });
  // Another load in the tab closes what this call added.
  if (behaviour === 'closed') useViewerStore.setState({ models: new Map() as never });
  // Something unrelated reports an error after this call's model opened.
  if (behaviour === 'unrelated-error') useViewerStore.getState().setError('another subsystem failed');
  return id;
}

beforeEach(() => {
  fetched = []; calls = []; behaviour = 'load';
  respond = () => new Response(new Uint8Array([73, 83, 79]), { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input));
    if (init?.signal?.aborted) throw init.signal.reason;
    return respond();
  }) as typeof fetch;
  unregister = registerAgentModelLoader({
    loadFile: async (file) => { await fakeLoad('replace', [file]); },
    addModel: (file, onError) => fakeLoad('add', [file], onError),
    loadStack: async (files) => { await fakeLoad('stack', files); },
  });
  useViewerStore.setState({ models: new Map() as never, ifcDataStore: null, loading: false, geometryStreamingActive: false, mutationViews: new Map() as never, georefMutations: new Map() as never });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  unregister();
  useViewerStore.setState({ models: new Map() as never, loading: false });
});

describe('viewer_open_model (#9523 local agent bridge)', () => {
  it('is offered to the bridge as a tool that needs the grant', () => {
    assert.equal(VIEWER_COMMAND_SPECS.viewer_open_model, MODEL_OPEN_SPECS.viewer_open_model);
    assert.equal(MODEL_OPEN_SPECS.viewer_open_model.readOnly, false);
  });

  it('refuses without the commands-and-edits grant', async () => {
    await assert.rejects(run({ sample: 'demo' }, { canEdit: () => false }), { code: 'READ_ONLY' });
    assert.deepEqual(calls, []);
  });

  it('opens a bundled sample into an empty viewer and returns its model_id', async () => {
    const out = await run({ sample: 'demo' });
    assert.deepEqual(calls, [{ kind: 'replace', names: ['building-architecture.ifc'] }]);
    assert.match(fetched[0], /\/samples\/building-architecture\.ifc$/);
    assert.deepEqual(out.structured, { mode: 'replace', state: 'loaded', models: [{ model_id: 'm-1-building-architecture.ifc', name: 'building-architecture.ifc', schema: 'IFC4', new: true }] });
    assert.match(out.text, /model_id m-1-building-architecture\.ifc/);
  });

  it('asks for a mode once models are loaded, and federates with add', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    await assert.rejects(run({ sample: 'hello-wall' }), { code: 'INVALID_INPUT', message: /mode/ });
    const out = await run({ sample: 'hello-wall', mode: 'add' });
    assert.equal(calls[0].kind, 'add');
    assert.deepEqual((out.structured as { models: Array<{ model_id: string; new: boolean }> }).models.map((m) => [m.model_id, m.new]),
      [['old', false], ['m-1-hello-wall.ifc', true]]);
  });

  it('refuses to replace models with unexported edits', async () => {
    useViewerStore.setState({
      models: new Map([['old', model('old', 'a.ifc')]]) as never,
      georefMutations: new Map([['old', { projectedCRS: { Name: 'EPSG:2056' } }]]) as never,
    });
    await assert.rejects(run({ sample: 'demo', mode: 'replace' }), { code: 'STATE_CHANGED', message: /1 unexported change/ });
    assert.deepEqual(calls, []);
  });

  it('fetches an https URL without credentials and rejects other schemes and non-model files', async () => {
    await run({ url: 'https://example.com/files/tower.ifc' });
    assert.deepEqual(calls, [{ kind: 'replace', names: ['tower.ifc'] }]);
    assert.equal(fetched[0], 'https://example.com/files/tower.ifc');
    await assert.rejects(run({ url: 'ftp://example.com/a.ifc', mode: 'add' }), { code: 'INVALID_INPUT' });
    await assert.rejects(run({ url: 'https://user:pw@example.com/a.ifc', mode: 'add' }), { code: 'INVALID_INPUT', message: /credentials/ });
    await assert.rejects(run({ url: 'https://example.com/readme.txt', mode: 'add' }), { code: 'INVALID_INPUT', message: /not a model file/ });
  });

  it('checks its arguments', async () => {
    await assert.rejects(run({}), { code: 'INVALID_INPUT', message: /exactly one/ });
    await assert.rejects(run({ sample: 'demo', url: 'https://x/a.ifc' }), { code: 'INVALID_INPUT' });
    await assert.rejects(run({ sample: 'nope' }), { code: 'INVALID_INPUT', message: /sample must be one of/ });
    await assert.rejects(run({ sample: 'demo', extra: 1 }), { code: 'INVALID_INPUT' });
  });

  it('reports a failed load or add instead of hanging', async () => {
    behaviour = 'error';
    // A failed replace leaves an errored placeholder record: still a failure (#9523 code review).
    await assert.rejects(run({ sample: 'demo' }), { code: 'INTERNAL_ERROR', message: /bad STEP/ });
    await assert.rejects(run({ sample: 'demo', mode: 'add' }), { code: 'INTERNAL_ERROR', message: /bad STEP/ });
  });

  it('refuses when no file loader is mounted', async () => {
    unregister();
    await assert.rejects(run({ sample: 'demo' }), { code: 'UNSUPPORTED_OPERATION', message: /no file loader/ });
  });
  it('refuses an explicit null like any other wrong value', async () => {
    await assert.rejects(run({ sample: null }), { code: 'INVALID_INPUT', message: /sample must be one of/ });
    await assert.rejects(run({ sample: 'demo', mode: null }), { code: 'INVALID_INPUT', message: /mode must be one of/ });
  });

  it('names a download from Content-Disposition and survives a malformed escape', async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-disposition': 'attachment; filename="tower.ifc"' } });
    await run({ url: 'https://example.com/download?id=5' });
    assert.deepEqual(calls, [{ kind: 'replace', names: ['tower.ifc'] }]);
    // RFC 6266: filename* (with its charset and language) wins over filename.
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-disposition': `attachment; filename="export.bin"; filename*=UTF-8'en'Tour%20A.ifc` } });
    await run({ url: 'https://example.com/download?id=6', mode: 'add' });
    assert.equal(calls.at(-1)!.names[0], 'Tour A.ifc');
    respond = () => new Response(new Uint8Array([1]), { status: 200 });
    await run({ url: 'https://example.com/a%E0%A4.ifc', mode: 'add' });
    assert.equal(calls.at(-1)!.names[0], 'a%E0%A4.ifc');
  });

  it('stops reading a body without a length once it passes the limit', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024 * 1024);
    respond = () => new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk); } }), { status: 200 });
    await assert.rejects(run({ url: 'https://example.com/huge.ifc' }), { code: 'INVALID_INPUT', message: /larger than/ });
    assert.ok(pulled <= 10, `read ${pulled} chunks, not the whole stream`);
    assert.deepEqual(calls, []);
  });

  it('reports a load that opened no model as a failure at once, not success', async () => {
    behaviour = 'nothing';
    const started = Date.now();
    await assert.rejects(run({ sample: 'demo' }), { code: 'UNSUPPORTED_OPERATION', message: /did not open/ });
    assert.ok(Date.now() - started < 2000, 'without waiting out the call budget');
  });

  it('answers within the call budget while a long load continues, and says not to retry', async () => {
    behaviour = 'hang';
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const pending = run({ sample: 'demo' });
      while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(OPEN_MODEL_WAIT_MS);
      const out = await pending;
      assert.equal((out.structured as { state: string }).state, 'loading');
      assert.deepEqual((out.structured as { models: unknown[] }).models, [], 'no placeholder model ids (#9523 code review)');
      assert.match(out.text, /Do not retry/);
    } finally {
      mock.timers.reset();
    }
  });
  it('abandons a download that outlasts the call budget, before anything changes', async (t) => {
    t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('signal timed out', 'TimeoutError')));
    await assert.rejects(run({ url: 'https://example.com/slow.ifc' }), { code: 'UNSUPPORTED_OPERATION', message: /did not finish within/ });
    await assert.rejects(run({ sample: 'demo' }), { code: 'UNSUPPORTED_OPERATION', message: /did not finish within/ }, 'samples get the budget too');
    assert.deepEqual(calls, []);
  });

  it('uses the URL path when filename is empty, and never invents a name', async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-disposition': 'attachment; filename=""' } });
    await run({ url: 'https://example.com/scan.glb' });
    assert.equal(calls.at(-1)!.names[0], 'scan.glb');
    respond = () => new Response(new Uint8Array([1]), { status: 200 });
    await assert.rejects(run({ url: 'https://example.com/', mode: 'add' }), { code: 'INVALID_INPUT', message: /not a model file/ });
  });

  it('lists no models while a replace is still loading, and says the old ones are closing', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    behaviour = 'hang';
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const pending = run({ sample: 'demo', mode: 'replace' });
      while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(OPEN_MODEL_WAIT_MS);
      const out = await pending;
      assert.deepEqual((out.structured as { models: unknown[] }).models, []);
      assert.match(out.text, /closes the previous models/);
    } finally {
      mock.timers.reset();
    }
  });

  it('reports an added model that another load closed (#9523 code review)', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    behaviour = 'closed';
    await assert.rejects(run({ sample: 'hello-wall', mode: 'add' }), { code: 'STATE_CHANGED', message: /closed by another load/ });
  });

  it('succeeds when its model opened even if something else then reported an error (#9523 code review)', async () => {
    behaviour = 'unrelated-error';
    const out = await run({ sample: 'demo' });
    assert.equal((out.structured as { state: string }).state, 'loaded');
  });

  it('refuses an empty body before a replace can close the open models (#9523 code review)', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    respond = () => new Response(null, { status: 204 });
    await assert.rejects(run({ url: 'https://example.com/model.ifc', mode: 'replace' }), { code: 'UNSUPPORTED_OPERATION', message: /empty body/ });
    assert.deepEqual(calls, []);
  });

  it('reads Content-Disposition variants: no type, ISO-8859-1, quoted escapes, first value wins (#9523 code review)', async () => {
    const nameFor = async (header: string) => {
      respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-disposition': header } });
      await run({ url: 'https://example.com/download', mode: 'add' });
      return calls.at(-1)!.names[0];
    };
    assert.equal(await nameFor('filename="model.ifc"'), 'model.ifc');
    assert.equal(await nameFor("attachment; filename*=ISO-8859-1''Gr%FCn.ifc"), 'Grün.ifc');
    assert.equal(await nameFor('attachment; filename="a\\"b.ifc"'), 'a"b.ifc');
    assert.equal(await nameFor('attachment; filename="first.ifc"; filename="second.ifc"'), 'first.ifc');
  });
  it('reads only the first of repeated Content-Disposition headers (#9523 code review)', async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: [['content-disposition', 'attachment; filename=a.ifc'], ['content-disposition', 'attachment; filename=b.ifc']] });
    await run({ url: 'https://example.com/download' });
    assert.equal(calls.at(-1)!.names[0], 'a.ifc');
  });
  it('keeps a quoted comma inside a file name (#9523 code review)', async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-disposition': 'attachment; filename="plan, inline view.ifc"' } });
    await run({ url: 'https://example.com/download' });
    assert.equal(calls.at(-1)!.names[0], 'plan, inline view.ifc');
  });

  it('does not claim a model another load opened meanwhile (#9523 code review)', async () => {
    unregister();
    unregister = registerAgentModelLoader({
      loadFile: async () => {
        // The user's own open wins the race: a different file ends up loaded.
        useViewerStore.setState({ models: new Map([['user', model('user', 'theirs.ifc')]]) as never });
      },
      addModel: async () => null,
      loadStack: async () => {},
    });
    await assert.rejects(run({ sample: 'demo' }), { code: 'UNSUPPORTED_OPERATION', message: /did not open/ });
  });
});
