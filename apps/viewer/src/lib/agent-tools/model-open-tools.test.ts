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
import { readFileSync } from 'node:fs';
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
let behaviour: 'load' | 'error' | 'nothing' | 'hang' | 'closed' | 'unrelated-error' | 'null-add' = 'load';
let unregister: () => void = () => {};

function model(id: string, name: string) {
  return { id, name, schemaVersion: 'IFC4' };
}

/** Drives the store the way useIfcLoader / useIfcFederation do. */
async function fakeLoad(kind: 'replace' | 'add' | 'stack', files: File[], onError?: (message: string) => void, primaryId?: string): Promise<string | null> {
  calls.push({ kind, names: files.map((f) => f.name) });
  // Like useIfcLoader: clearing the previous error bumps loadErrorSeq before the load runs.
  useViewerStore.getState().setError(null);
  useViewerStore.setState({ loading: true });
  if (behaviour === 'hang') return new Promise(() => {});
  await Promise.resolve();
  if (behaviour === 'nothing') { useViewerStore.setState({ loading: false }); return 'none'; }
  // An add that registered nothing and reported no error of its own (superseded, cancelled, stale deployment).
  if (behaviour === 'null-add') { useViewerStore.setState({ loading: false }); return null; }
  const models = new Map(kind === 'add' ? useViewerStore.getState().models : []);
  const id = primaryId ?? `m-${calls.length}-${files[0].name}`;
  if (behaviour === 'error') {
    // The primary loader keeps its placeholder record, marked failed; an add reports to its own onError and resolves null.
    if (kind !== 'add') models.set(id, { ...model(id, files[0].name), loadState: 'error', loadError: 'bad STEP' } as never);
    useViewerStore.setState({ models: models as never });
    useViewerStore.getState().setError('bad STEP');
    useViewerStore.setState({ loading: false });
    onError?.('bad STEP');
    return null;
  }
  for (const f of files) {
    const fileId = primaryId ?? `m-${calls.length}-${f.name}`;
    models.set(fileId, model(fileId, f.name) as never);
  }
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
    loadFile: async (file, modelId, onError) => { await fakeLoad('replace', [file], onError, modelId); },
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

/** The layer-stack sample the demo builder parses, served from the viewer's public folder. */
const serveStackSample = () => {
  const body = readFileSync(new URL('../../../public/samples/hello-wall.ifcx', import.meta.url), 'utf8');
  respond = () => new Response(body, { status: 200 });
};

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
    // A replace runs under an id the tool chose, so the result names exactly that record.
    const [only] = [...useViewerStore.getState().models.keys()];
    assert.deepEqual(out.structured, { mode: 'replace', state: 'loaded', models: [{ model_id: only, name: 'building-architecture.ifc', schema: 'IFC4', new: true }] });
    assert.match(out.text, new RegExp(`model_id ${only}`));
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
  it('does not claim a same-named model another load opened meanwhile (#9523 code review)', async () => {
    unregister();
    unregister = registerAgentModelLoader({
      // The user's own demo.ifc wins the race; the agent's load (under its own id) never registers.
      loadFile: async (file) => { useViewerStore.setState({ models: new Map([['user', model('user', file.name)]]) as never }); },
      addModel: async () => null,
      loadStack: async () => {},
    });
    await assert.rejects(run({ sample: 'demo' }), { code: 'UNSUPPORTED_OPERATION', message: /did not open/ });
  });

  it('recognises a reopened layer stack, whose layer ids repeat (#9523 code review)', async () => {
    serveStackSample();
    await run({ sample: 'layers-demo' });
    const first = [...useViewerStore.getState().models.keys()];
    unregister();
    unregister = registerAgentModelLoader({
      loadFile: async () => {}, addModel: async () => null,
      // Same deterministic ids as the stack already open.
      loadStack: async (files) => { useViewerStore.setState({ models: new Map(files.map((f, i) => [first[i], model(first[i], f.name)])) as never }); },
    });
    const out = await run({ sample: 'layers-demo', mode: 'replace' });
    assert.equal((out.structured as { state: string }).state, 'loaded');
  });

  it('reports a failed stack load through the store error (#9523 code review)', async () => {
    unregister();
    unregister = registerAgentModelLoader({
      loadFile: async () => {}, addModel: async () => null,
      // Like loadFederatedIfcxFromBuffers: clear every model, then fail through the store.
      loadStack: async () => {
        useViewerStore.setState({ models: new Map() as never });
        useViewerStore.getState().setError('Federated IFCX loading failed: bad layer');
      },
    });
    serveStackSample();
    await assert.rejects(run({ sample: 'layers-demo' }), { code: 'INTERNAL_ERROR', message: /bad layer/ });
  });

  it('never counts an already-open same-named model as a failed add (#9523 code review)', async () => {
    await run({ sample: 'demo' });
    behaviour = 'error';
    await assert.rejects(run({ sample: 'demo', mode: 'add' }), { code: 'INTERNAL_ERROR', message: /bad STEP/ });
    behaviour = 'null-add';
    await assert.rejects(run({ sample: 'demo', mode: 'add' }), { code: 'UNSUPPORTED_OPERATION', message: /did not open/ });
  });

  it('reports a stack that failed before clearing, over an older open stack (#9523 code review)', async () => {
    serveStackSample();
    await run({ sample: 'layers-demo' });
    unregister();
    unregister = registerAgentModelLoader({
      loadFile: async () => {}, addModel: async () => null,
      // Like loadFederatedIfcx's format check: report and return before clearAllModels.
      loadStack: async (files) => { useViewerStore.getState().setError(`File "${files[0].name}" is not an IFCX file. Federated loading only supports IFCX files.`); },
    });
    await assert.rejects(run({ sample: 'layers-demo', mode: 'replace' }), { code: 'INTERNAL_ERROR', message: /not an IFCX file/ });
  });

  it('an unrelated stack-like error after the stack registered does not fail it (#9523 code review)', async () => {
    serveStackSample();
    unregister();
    unregister = registerAgentModelLoader({
      loadFile: async () => {}, addModel: async () => null,
      loadStack: async (files) => {
        useViewerStore.setState({ loading: true, models: new Map(files.map((f, i) => [`layer-${i + 1}`, model(`layer-${i + 1}`, f.name)])) as never });
        // After the loader resolved: an overlay drop elsewhere fails with a similar message.
        setTimeout(() => {
          useViewerStore.getState().setError('File "x.ifc" is not an IFCX file.');
          useViewerStore.setState({ loading: false });
        }, 0);
      },
    });
    const out = await run({ sample: 'layers-demo' });
    assert.equal((out.structured as { state: string }).state, 'loaded');
  });

  it('reports a rejected loader as a typed error (#9523 code review)', async () => {
    unregister();
    unregister = registerAgentModelLoader({ loadFile: async () => { throw new Error('blob revoked'); }, addModel: async () => null, loadStack: async () => {} });
    await assert.rejects(run({ sample: 'demo' }), { code: 'INTERNAL_ERROR', message: /blob revoked/ });
  });

  it('a rejected loader keeps its own reason (#9523 code review)', async () => {
    unregister();
    unregister = registerAgentModelLoader({
      loadFile: async (_file, _id, onError) => { onError('Unsupported IFC schema'); throw new Error('worker exited'); },
      addModel: async () => null, loadStack: async () => {},
    });
    await assert.rejects(run({ sample: 'demo' }), { code: 'INTERNAL_ERROR', message: /Unsupported IFC schema/ });
  });

  it('names a URL download from its path only, and refuses before fetching when the path is not a model (#9523 code review)', async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-disposition': 'attachment; filename="other.glb"' } });
    await run({ url: 'https://example.com/files/Tower%20A.ifc' });
    assert.equal(calls.at(-1)!.names[0], 'Tower A.ifc', 'decoded path name; Content-Disposition is not used');
    await run({ url: 'https://example.com/a%E0%A4.ifc', mode: 'add' });
    assert.equal(calls.at(-1)!.names[0], 'a%E0%A4.ifc', 'a malformed escape is kept as is');
    const before = fetched.length;
    await assert.rejects(run({ url: 'https://example.com/download?id=5', mode: 'add' }), { code: 'INVALID_INPUT', message: /path ends in the file's extension/ });
    assert.equal(fetched.length, before, 'nothing was fetched');
  });

  it('refuses an HTML page served under a model URL before anything changes (#9523 code review)', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    respond = () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    await assert.rejects(run({ url: 'https://example.com/house.ifc', mode: 'replace' }), { code: 'UNSUPPORTED_OPERATION', message: /HTML page/ });
    assert.deepEqual(calls, []);
  });
  it('guards URL names and bodies before a replace can close the open models (#9523 code review)', async () => {
    useViewerStore.setState({ models: new Map([['old', model('old', 'a.ifc')]]) as never });
    // An encoded separator never reaches the model name.
    await run({ url: 'https://example.com/x/..%2F..%2Fetc%2Fhouse.ifc', mode: 'add' });
    assert.equal(calls.at(-1)!.names[0], 'house.ifc');
    // A .gltf cannot bring its external buffers along.
    await assert.rejects(run({ url: 'https://example.com/scene.gltf', mode: 'add' }), { code: 'INVALID_INPUT', message: /\.glb/ });
    // An HTML body under a generic type is still an HTML page.
    respond = () => new Response('<!DOCTYPE html><title>Sign in</title>', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    const before = calls.length;
    await assert.rejects(run({ url: 'https://example.com/house.ifc', mode: 'replace' }), { code: 'UNSUPPORTED_OPERATION', message: /HTML page/ });
    assert.equal(calls.length, before, 'nothing was loaded');
  });
});
