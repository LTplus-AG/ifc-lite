/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end over the real wire (#9523): the REAL `ifc-lite-mcp --bridge`
 * server from `packages/mcp` (stdio MCP plus its loopback WebSocket, port 0)
 * against the REAL tab client and main-viewer tool host, over Node's own
 * WebSocket. An MCP client speaks JSON-RPC to the bridge's stdio; the call
 * travels to this "tab", runs against a store seeded with a real IFC file
 * (with an unsaved edit), and comes back.
 *
 * The bridge is imported from source so the test follows the branch, not a
 * stale `dist/`. It lives in the viewer's suite because the viewer side (the
 * store, the tool host) is what needs a real model; `packages/mcp` has its
 * own fake-tab tests for the bridge's half.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore, type FederatedModel } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { fixtureModel } from '@/test/store-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { MAIN_VIEWER_TOOL_ALLOWLIST } from '@/lib/agent-tools/main-viewer';
import type { WebSocketConstructor, WebSocketLike } from './client';
import { connectAgentBridge, disconnectAgentBridge } from './session';
import { getAgentBridgeState, resetAgentBridgeStateForTests } from './state';

const HELLO_WALL = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WALL_ID = 1222;
const WALL_GID = '2JUHrTM_j3UxZiBnyBfByx';
const VIEWER_ORIGIN = 'http://localhost:5173';

// The bridge's own modules, by path: they are not part of @ifc-lite/mcp's
// published exports, and a typed import would pull its sources into the
// viewer's typecheck program.
interface RunningBridge {
  server: unknown;
  bridge: { port: number; pairingCode(): string };
  close(): Promise<void>;
}
interface BridgeRun { startBridgeServer(opts: { version: string; port: number; readOnly: boolean; viewerUrl: string; log?: (line: string) => void }): Promise<RunningBridge> }
interface StdioModule { StdioTransport: new (opts: { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }) => { connect(server: unknown): Promise<void>; close(): void } }
const MCP_SRC = new URL('../../../../../packages/mcp/src/', import.meta.url);

/** Node's WebSocket, sending the Origin a browser on the dev viewer would send. */
function originWebSocket(origin: string): WebSocketConstructor {
  const NodeWebSocket = globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocketLike;
  return class extends NodeWebSocket {
    constructor(url: string) {
      super(url, { headers: { origin } });
    }
  } as unknown as WebSocketConstructor;
}

type Line = { id?: number; method?: string; result?: Record<string, unknown>; error?: unknown };

function stdioClient(stdin: PassThrough, stdout: PassThrough) {
  let buffer = '';
  const lines: Line[] = [];
  stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line) lines.push(JSON.parse(line) as Line);
    }
  });
  let nextId = 1;
  return {
    lines,
    notify(method: string) { stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); },
    async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const id = nextId++;
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const found = lines.find((l) => l.id === id);
        if (found) {
          assert.equal(found.error, undefined, `${method} failed: ${JSON.stringify(found.error)}`);
          return found.result ?? {};
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no reply to ${method}`);
    },
  };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function seedHelloWall(): Promise<void> {
  const bytes = new Uint8Array(await readFile(HELLO_WALL));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  store.fileSize = bytes.byteLength;
  const model = { ...fixtureModel('hello'), name: 'hello-wall.ifc', fileSize: bytes.byteLength, ifcDataStore: store, loadState: 'complete' } as FederatedModel;
  const view = new MutablePropertyView(store.properties || null, model.id);
  configureMutationView(view, store);
  useViewerStore.setState({
    models: new Map([[model.id, model]]), activeModelId: model.id, ifcDataStore: null, editEnabled: true,
    mutationViews: new Map([[model.id, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), mutationVersion: 0,
  });
}

describe('viewer tab <-> real MCP bridge, end to end (#9523)', () => {
  let running: RunningBridge;
  let closed = false;
  let transport: { close(): void };
  let mcp: ReturnType<typeof stdioClient>;
  const bridgeLog: string[] = [];

  before(async () => {
    await seedHelloWall();
    resetAgentBridgeStateForTests();
    const { startBridgeServer } = await import(new URL('bridge/run.ts', MCP_SRC).href) as BridgeRun;
    const { StdioTransport } = await import(new URL('transport/stdio.ts', MCP_SRC).href) as StdioModule;
    running = await startBridgeServer({ version: '0.0.0-test', port: 0, readOnly: false, viewerUrl: VIEWER_ORIGIN, log: (line) => bridgeLog.push(line) });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdio = new StdioTransport({ stdin, stdout, stderr: new PassThrough() });
    await stdio.connect(running.server);
    transport = stdio;
    mcp = stdioClient(stdin, stdout);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration', version: '1' } });
    mcp.notify('notifications/initialized');
  });

  after(async () => {
    disconnectAgentBridge();
    transport?.close();
    if (!closed) await running?.close();
    resetAgentBridgeStateForTests();
  });

  it('pairs, lists the 27 read-only tools, and answers real calls from the live store including unsaved edits', async () => {
    const before = (await mcp.request('tools/list')).tools as { name: string }[];
    assert.deepEqual(before.map((tool) => tool.name), ['bridge_status'], 'no tab yet: only bridge_status');

    const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
    connectAgentBridge({ port: running.bridge.port, code: running.bridge.pairingCode(), bim, WebSocket: originWebSocket(VIEWER_ORIGIN) });
    await until(() => getAgentBridgeState().status.kind === 'connected', `paired (${JSON.stringify(getAgentBridgeState().status)}; bridge: ${bridgeLog.join(' | ')})`);
    await until(() => mcp.lines.some((line) => line.method === 'notifications/tools/list_changed'), 'tools/list_changed');

    const listed = (await mcp.request('tools/list')).tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    assert.deepEqual(listed.map((tool) => tool.name), ['bridge_status', ...MAIN_VIEWER_TOOL_ALLOWLIST]);
    assert.ok(listed.slice(1).every((tool) => tool.annotations?.readOnlyHint === true));

    // An unsaved edit in the viewer is what the agent reads.
    useViewerStore.getState().setAttribute('hello', WALL_ID, 'Name', 'Edited over the bridge');
    const entity = await mcp.request('tools/call', { name: 'get_entity', arguments: { global_id: WALL_GID } });
    assert.equal(entity.isError, undefined, JSON.stringify(entity));
    assert.equal((entity.structuredContent as { name: string }).name, 'Edited over the bridge');

    const count = await mcp.request('tools/call', { name: 'count_entities', arguments: { type: 'IfcWall' } });
    assert.equal(count.isError, undefined, JSON.stringify(count));
    assert.match(String((count.content as { text: string }[])[0].text), /IfcWall/);

    // A tool failure arrives in the stdio server's error envelope.
    const missing = await mcp.request('tools/call', { name: 'get_entity', arguments: { global_id: '0000000000000000000000' } });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as { code: string }).code, 'ENTITY_NOT_FOUND');
    assert.equal((missing.structuredContent as { message: string }).message, (missing.content as { text: string }[])[0].text);

    // A mutation the tab never offered is refused, not forwarded.
    const mutate = await mcp.request('tools/call', { name: 'entity_set_attribute', arguments: { global_id: WALL_GID, attribute: 'Name', value: 'x' } });
    assert.equal(mutate.isError, true);

    const activity = getAgentBridgeState().activity;
    assert.deepEqual(activity.map((row) => [row.tool, row.modelId, row.outcome]).reverse(), [
      ['get_entity', 'hello', 'ok'], ['count_entities', 'hello', 'ok'], ['get_entity', 'hello', 'error'],
    ], 'one row per served call; the refused mutation never reached the tab');
  });

  it('the bridge shutting down ends the tab\'s session as bridge-shutdown', async () => {
    closed = true;
    await running.close();
    await until(() => getAgentBridgeState().status.kind === 'disconnected', 'the tab saw the shutdown');
    assert.deepEqual(getAgentBridgeState().status, { kind: 'disconnected', reason: 'bridge-shutdown' });
  });
});
