/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local agent bridge client (#9523) against a fake WebSocket that plays
 * the bridge's side of the protocol, plus the real main-viewer tool list.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_LIMITS, BRIDGE_PROTOCOL_VERSION, BridgeCloseCode, parseTabMessage, validateToolDescriptors,
  type BridgeHelloMessage, type BridgeResultMessage,
} from '@ifc-lite/mcp/bridge-protocol';
import { MAIN_VIEWER_TOOL_ALLOWLIST } from '@/lib/agent-tools/main-viewer';
import { BridgeClient, type BridgeClientOptions, type WebSocketLike } from './client';
import type { AgentBridgeActivity, AgentBridgeStatus } from './state';
import type { ToolOutcome } from './result-frame';
import { mainViewerBridgeTools } from './session';

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | null = null;
  static count = 0;
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.count++;
  }
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  // ── the bridge's side ──
  open(): void { this.readyState = 1; this.onopen?.({}); }
  frame(msg: unknown): void { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  drop(code: number): void { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
  hello(): BridgeHelloMessage {
    const parsed = parseTabMessage(this.sent[0]);
    assert.ok(parsed.ok && parsed.value.type === 'hello', 'the first frame is a valid hello');
    return parsed.value as BridgeHelloMessage;
  }
  results(): BridgeResultMessage[] {
    return this.sent.slice(1).map((text) => {
      const parsed = parseTabMessage(text);
      assert.ok(parsed.ok && parsed.value.type === 'result', `a valid result frame: ${text.slice(0, 200)}`);
      return parsed.value as BridgeResultMessage;
    });
  }
  welcome(sessionId = 'session-1'): void {
    this.frame({ type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, sessionId, permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'ifc-lite-mcp', version: 't' } });
  }
}

class FakeLifecycle extends EventTarget {}

interface Harness {
  client: BridgeClient;
  statuses: AgentBridgeStatus[];
  activity: AgentBridgeActivity[];
  lifecycle: FakeLifecycle;
  socket(): FakeSocket;
}

const SECRET_ARG = 'secret-argument-value';
const SECRET_RESULT = 'secret-result-text';

function harness(overrides: Partial<BridgeClientOptions> = {}): Harness {
  FakeSocket.last = null;
  FakeSocket.count = 0;
  const statuses: AgentBridgeStatus[] = [];
  const activity: AgentBridgeActivity[] = [];
  const lifecycle = new FakeLifecycle();
  const client = new BridgeClient({
    port: 21517,
    pairingCode: 'abcde-fghjk mnpqr-stvwx',
    tools: mainViewerBridgeTools(),
    dispatch: async () => ({ text: SECRET_RESULT, structured: { count: 2, note: SECRET_RESULT }, isError: false }),
    modelIdFor: (args) => (typeof args.model_id === 'string' ? args.model_id : null),
    onStatus: (status) => statuses.push(status),
    onActivity: (entry) => activity.push(entry),
    clientInfo: { name: 'ifc-lite viewer', version: 'test' },
    WebSocket: FakeSocket,
    lifecycle,
    ...overrides,
  });
  return { client, statuses, activity, lifecycle, socket: () => { assert.ok(FakeSocket.last); return FakeSocket.last; } };
}

/** Connected and welcomed. */
function paired(overrides: Partial<BridgeClientOptions> = {}): Harness {
  const h = harness(overrides);
  h.client.connect();
  h.socket().open();
  h.socket().welcome();
  return h;
}

function call(socket: FakeSocket, id: string, name = 'count_entities', args: Record<string, unknown> = { type: 'IfcWall' }, sessionId = 'session-1'): void {
  socket.frame({ type: 'call', sessionId, id, name, arguments: args });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A dispatch that waits for its signal, recording what it saw. */
function blockingDispatch() {
  const seen: { name: string; signal: AbortSignal; resolve: (outcome: ToolOutcome) => void }[] = [];
  const dispatch = (name: string, _args: Record<string, unknown>, signal: AbortSignal) =>
    new Promise<ToolOutcome>((resolve) => { seen.push({ name, signal, resolve }); });
  return { seen, dispatch };
}

afterEach(() => { FakeSocket.last = null; });

describe('local agent bridge client: handshake (#9523)', () => {
  it('connects to 127.0.0.1 only when asked, and its hello is read-only with the 27 main-viewer tools', () => {
    const h = harness();
    assert.equal(FakeSocket.count, 0, 'constructing a client opens nothing');
    h.client.connect();
    assert.equal(h.socket().url, 'ws://127.0.0.1:21517/');
    assert.deepEqual(h.statuses, [{ kind: 'connecting', port: 21517 }]);
    assert.equal(h.socket().sent.length, 0, 'nothing is sent before the socket opens');
    h.socket().open();
    const hello = h.socket().hello();
    assert.equal(hello.protocol, BRIDGE_PROTOCOL_VERSION);
    assert.equal(hello.permission, 'read-only');
    assert.equal(hello.pairingCode, 'ABCDEFGHJKMNPQRSTVWX', 'the code is sent in canonical form');
    assert.deepEqual(hello.tools.map((tool) => tool.name).sort(), [...MAIN_VIEWER_TOOL_ALLOWLIST].sort());
    assert.equal(hello.tools.length, 27);
    assert.ok(hello.tools.every((tool) => tool.readOnly), 'every announced tool is read-only');
    const checked = validateToolDescriptors(hello.tools);
    assert.ok(checked.ok, `the bridge accepts the tool list as sent: ${checked.ok ? '' : checked.error}`);
    // The limits validateToolDescriptors applies, stated so a limit change shows up here by name.
    assert.ok(new TextEncoder().encode(JSON.stringify(hello.tools)).byteLength <= BRIDGE_LIMITS.maxDescriptorBytes);
    assert.ok(hello.tools.every((tool) => tool.description.length <= BRIDGE_LIMITS.maxDescriptionLength));
    assert.deepEqual(hello.client, { name: 'ifc-lite viewer', version: 'test' });
  });

  it('is connected on welcome, read-only whatever the welcome claims', () => {
    const h = harness({ now: () => 1234 });
    h.client.connect();
    h.socket().open();
    h.socket().frame({ type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, sessionId: 's', permission: 'read-write', readOnlyCeiling: false, bridge: { name: 'b', version: '1' } });
    assert.deepEqual(h.client.status, { kind: 'connected', port: 21517, permission: 'read-only', since: 1234 });
  });

  it('gives up with handshake-timeout when no welcome arrives', async () => {
    const h = harness({ welcomeTimeoutMs: 5 });
    h.client.connect();
    h.socket().open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(h.client.status, { kind: 'error', code: 'handshake-timeout', port: 21517 });
    assert.ok(h.socket().closedWith, 'the socket is closed');
  });

  it('a welcome for another protocol version is a protocol mismatch', () => {
    const h = harness();
    h.client.connect();
    h.socket().open();
    h.socket().frame({ type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION + 1, sessionId: 's', permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'b', version: '1' } });
    assert.deepEqual(h.client.status, { kind: 'error', code: 'protocol-mismatch', port: 21517 });
  });
});

describe('local agent bridge client: calls (#9523)', () => {
  it('dispatches a call and answers with the same session and id, shaped like the stdio server', async () => {
    const seen: unknown[] = [];
    const h = paired({
      dispatch: async (name, args) => { seen.push([name, args]); return { text: '2 walls', structured: { count: 2 }, isError: false }; },
    });
    call(h.socket(), 'c7', 'count_entities', { type: 'IfcWall' });
    await flush();
    assert.deepEqual(seen, [['count_entities', { type: 'IfcWall' }]]);
    assert.deepEqual(h.socket().results(), [{
      type: 'result', sessionId: 'session-1', id: 'c7',
      result: { content: [{ type: 'text', text: '2 walls' }], structuredContent: { count: 2 } },
    }]);
  });

  it('an error outcome carries code and hint where toolError puts them', async () => {
    const h = paired({
      dispatch: async () => ({ text: 'No model is loaded in the viewer.', structured: null, isError: true, errorCode: 'MODEL_NOT_FOUND', hint: 'Open a model.' }),
    });
    call(h.socket(), 'c1');
    await flush();
    assert.deepEqual(h.socket().results()[0].result, {
      content: [{ type: 'text', text: 'No model is loaded in the viewer.' }],
      structuredContent: { code: 'MODEL_NOT_FOUND', message: 'No model is loaded in the viewer.', details: {}, hint: 'Open a model.' },
      isError: true,
    });
  });

  it('a dispatch that throws is answered as INTERNAL_ERROR instead of escaping', async () => {
    const h = paired({ dispatch: async () => { throw new Error('boom'); } });
    call(h.socket(), 'c1');
    await flush();
    const result = h.socket().results()[0].result;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { code: string }).code, 'INTERNAL_ERROR');
  });

  it('cancel aborts the in-flight call and its late result is not sent', async () => {
    const { seen, dispatch } = blockingDispatch();
    const h = paired({ dispatch });
    call(h.socket(), 'c1');
    await flush();
    assert.equal(seen.length, 1);
    h.socket().frame({ type: 'cancel', sessionId: 'session-1', id: 'c1', reason: 'cancelled' });
    assert.equal(seen[0].signal.aborted, true, 'the dispatch signal aborted');
    seen[0].resolve({ text: 'late', structured: null, isError: false });
    await flush();
    assert.equal(h.socket().sent.length, 1, 'only the hello was ever sent');
    assert.equal(h.activity[0].outcome, 'cancelled');
    assert.equal(h.client.status.kind, 'connected', 'a cancel does not end the session');
  });

  it('ignores calls and cancels naming another session, calls before welcome and invalid frames, without closing', async () => {
    const { seen, dispatch } = blockingDispatch();
    const h = harness({ dispatch });
    h.client.connect();
    h.socket().open();
    call(h.socket(), 'early');
    h.socket().welcome('session-1');
    call(h.socket(), 'foreign', 'count_entities', {}, 'session-0');
    h.socket().frame('not json');
    h.socket().frame({ type: 'call', sessionId: 'session-1', id: 'c1', name: 'count_entities' });
    h.socket().frame({ type: 'mystery' });
    call(h.socket(), 'c2');
    await flush();
    assert.deepEqual(seen.map((s) => s.name), ['count_entities'], 'only the valid call for this session ran');
    h.socket().frame({ type: 'cancel', sessionId: 'session-0', id: 'c2', reason: 'cancelled' });
    assert.equal(seen[0].signal.aborted, false, 'a foreign cancel does not abort');
    assert.equal(h.socket().closedWith, null, 'the socket stays open');
    assert.equal(h.client.status.kind, 'connected');
    seen[0].resolve({ text: 'ok', structured: null, isError: false });
    await flush();
    assert.deepEqual(h.socket().results().map((r) => r.id), ['c2']);
  });

  it('a duplicate call id is not served twice', async () => {
    const { seen, dispatch } = blockingDispatch();
    const h = paired({ dispatch });
    call(h.socket(), 'c1');
    call(h.socket(), 'c1');
    await flush();
    assert.equal(seen.length, 1);
  });

  it('truncates an oversize result with a note instead of sending one the bridge would refuse', async () => {
    const big = 'x'.repeat(200_000);
    const h = paired({ maxResultBytes: 50_000, dispatch: async () => ({ text: big, structured: { rows: [big] }, isError: false }) });
    call(h.socket(), 'c1');
    await flush();
    const result = h.socket().results()[0].result;
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 50_000, 'the result fits the limit');
    const text = String(result.content[0].text);
    assert.match(text, /\[Truncated by the viewer: the full result \(\d+ bytes\) is more than the bridge accepts/);
    assert.ok(text.startsWith('xxxx'), 'it keeps the start of the text');
    assert.equal((result.structuredContent as { truncated: boolean }).truncated, true);
    assert.equal(h.client.status.kind, 'connected');
  });

  it('a result over the bridge\'s real limits (bytes, nesting) is cut to one the bridge validator accepts', async () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 80; i++) deep = { child: deep };
    const outcomes: ToolOutcome[] = [
      { text: 'y'.repeat(BRIDGE_LIMITS.maxResultBytes + 1000), structured: null, isError: false },
      { text: 'deep', structured: { tree: deep }, isError: false },
    ];
    const h = paired({ dispatch: async () => outcomes.shift() as ToolOutcome });
    call(h.socket(), 'big');
    call(h.socket(), 'deep');
    await flush();
    const results = h.socket().results();
    assert.deepEqual(results.map((r) => r.id), ['big', 'deep'], 'both frames pass parseTabMessage');
    assert.match(String(results[0].result.content[0].text), /result is \d+ bytes; the limit is 4194304/);
    assert.match(String(results[1].result.content[0].text), /^deep\n\n\[Truncated by the viewer/);
  });

  it('the activity log has tool, model, duration and outcome, never arguments or results', async () => {
    let clock = 100;
    const h = paired({
      now: () => clock,
      dispatch: async (name) => {
        clock += 25;
        return name === 'get_entity'
          ? { text: `missing ${SECRET_RESULT}`, structured: null, isError: true, errorCode: 'ENTITY_NOT_FOUND' }
          : { text: SECRET_RESULT, structured: { value: SECRET_RESULT }, isError: false };
      },
    });
    call(h.socket(), 'c1', 'count_entities', { type: SECRET_ARG, model_id: 'model-a' });
    await flush();
    call(h.socket(), 'c2', 'get_entity', { global_id: SECRET_ARG });
    await flush();
    assert.deepEqual(h.activity.map(({ tool, modelId, durationMs, outcome, errorCode }) => ({ tool, modelId, durationMs, outcome, errorCode })), [
      { tool: 'count_entities', modelId: 'model-a', durationMs: 25, outcome: 'ok', errorCode: undefined },
      { tool: 'get_entity', modelId: null, durationMs: 25, outcome: 'error', errorCode: 'ENTITY_NOT_FOUND' },
    ]);
    const logged = JSON.stringify(h.activity);
    assert.ok(!logged.includes(SECRET_ARG), 'no argument value in the log');
    assert.ok(!logged.includes(SECRET_RESULT), 'no result text in the log');
  });
});

describe('local agent bridge client: read-only obligation (#9523)', () => {
  it('a call naming a model-changing tool is answered isError by the real dispatch and never touches a model', async () => {
    const { dispatchMainViewerTool } = await import('@/lib/agent-tools/main-viewer');
    let modelReads = 0;
    const host = { models: () => { modelReads++; return []; }, bsdd: {} } as unknown as Parameters<typeof dispatchMainViewerTool>[0];
    const h = paired({ dispatch: (name, args, signal) => dispatchMainViewerTool(host, name, args, { signal }) });
    for (const [id, name] of [['m1', 'entity_set_attribute'], ['m2', 'viewer_colorize'], ['m3', 'not_a_tool']]) {
      call(h.socket(), id, name, { global_id: '2JUHrTM_j3UxZiBnyBfByx', attribute: 'Name', value: 'x' });
    }
    await flush();
    const results = h.socket().results();
    assert.deepEqual(results.map((r) => r.id), ['m1', 'm2', 'm3']);
    assert.deepEqual(results.map((r) => [r.result.isError, (r.result.structuredContent as { code: string }).code]),
      [[true, 'READ_ONLY'], [true, 'UNSUPPORTED_OPERATION'], [true, 'INVALID_INPUT']]);
    assert.equal(modelReads, 0, 'no refused call reached a model, let alone a mutation path');
  });
});

describe('local agent bridge client: endings (#9523)', () => {
  it('a socket close aborts in-flight calls, sends nothing late and ends disconnected', async () => {
    const { seen, dispatch } = blockingDispatch();
    const h = paired({ dispatch });
    call(h.socket(), 'c1');
    await flush();
    h.socket().drop(1006);
    assert.equal(seen[0].signal.aborted, true);
    assert.deepEqual(h.client.status, { kind: 'disconnected', reason: 'connection-lost' });
    seen[0].resolve({ text: 'late', structured: null, isError: false });
    await flush();
    assert.equal(h.socket().sent.length, 1);
  });

  const fatal: [string, number, AgentBridgeStatus][] = [
    ['wrong or used code', BridgeCloseCode.PAIRING_FAILED, { kind: 'error', code: 'pairing-failed', port: 21517 }],
    ['protocol mismatch', BridgeCloseCode.PROTOCOL_VERSION_MISMATCH, { kind: 'error', code: 'protocol-mismatch', port: 21517 }],
    ['handshake timeout', BridgeCloseCode.HANDSHAKE_TIMEOUT, { kind: 'error', code: 'handshake-timeout', port: 21517 }],
    ['invalid message', BridgeCloseCode.INVALID_MESSAGE, { kind: 'error', code: 'invalid-message', port: 21517 }],
    ['busy', BridgeCloseCode.BUSY, { kind: 'error', code: 'busy', port: 21517 }],
    ['replaced by another tab', BridgeCloseCode.REPLACED, { kind: 'disconnected', reason: 'replaced' }],
    ['bridge shut down', BridgeCloseCode.SHUTTING_DOWN, { kind: 'disconnected', reason: 'bridge-shutdown' }],
  ];
  for (const [what, code, expected] of fatal) {
    it(`close ${code} (${what}) maps to its user-facing state`, () => {
      const h = harness();
      h.client.connect();
      h.socket().open();
      if (code === BridgeCloseCode.REPLACED || code === BridgeCloseCode.SHUTTING_DOWN) h.socket().welcome();
      h.socket().drop(code);
      assert.deepEqual(h.client.status, expected);
    });
  }

  it('an error frame decides the outcome when the close code is lost', () => {
    const h = harness();
    h.client.connect();
    h.socket().open();
    h.socket().frame({ type: 'error', code: 'PAIRING_FAILED', message: 'Pairing code not accepted.' });
    h.socket().drop(1006);
    assert.deepEqual(h.client.status, { kind: 'error', code: 'pairing-failed', port: 21517 });
  });

  it('a socket that never opens is unreachable, or permission-denied when the browser says so', async () => {
    const unreachable = harness({ probePermission: async () => 'prompt' });
    unreachable.client.connect();
    unreachable.socket().drop(1006);
    await flush();
    assert.deepEqual(unreachable.client.status, { kind: 'error', code: 'unreachable', port: 21517 });

    const denied = harness({ probePermission: async () => 'denied' });
    denied.client.connect();
    denied.socket().drop(1006);
    await flush();
    assert.deepEqual(denied.client.status, { kind: 'error', code: 'permission-denied', port: 21517 });
  });

  it('a constructor that throws (the browser blocked the address) is permission-denied, not a crash', () => {
    const h = harness({ WebSocket: class { constructor() { throw new Error('SecurityError'); } } as unknown as BridgeClientOptions['WebSocket'] });
    h.client.connect();
    assert.deepEqual(h.client.status, { kind: 'error', code: 'permission-denied', port: 21517 });
  });

  it('never reconnects with the used code: one socket, one hello, and connect() after a drop is a no-op', () => {
    const h = paired();
    h.socket().drop(1006);
    h.client.connect();
    assert.equal(FakeSocket.count, 1, 'no second socket');
    assert.equal(h.socket().sent.filter((text) => text.includes('"hello"')).length, 1);
    assert.equal(h.client.status.kind, 'disconnected');
  });

  it('disconnect() closes cleanly, aborts in-flight calls and goes idle', async () => {
    const { seen, dispatch } = blockingDispatch();
    const h = paired({ dispatch });
    call(h.socket(), 'c1');
    await flush();
    h.client.disconnect();
    assert.equal(seen[0].signal.aborted, true);
    assert.deepEqual(h.socket().closedWith, { code: 1000, reason: 'disconnected by the user' });
    assert.deepEqual(h.client.status, { kind: 'idle' });
    h.socket().drop(1000);
    assert.deepEqual(h.client.status, { kind: 'idle' }, 'the later close event changes nothing');
  });

  it('closes on pagehide, not on visibilitychange', () => {
    const h = paired();
    h.lifecycle.dispatchEvent(new Event('visibilitychange'));
    assert.equal(h.client.status.kind, 'connected', 'a hidden tab stays connected');
    h.lifecycle.dispatchEvent(new Event('pagehide'));
    assert.deepEqual(h.client.status, { kind: 'disconnected', reason: 'page-hidden' });
    assert.equal(h.socket().closedWith?.code, 1001);
  });

  it('a throwing status listener does not escape into the event loop', () => {
    const h = harness({ onStatus: () => { throw new Error('listener'); } });
    h.client.connect();
    h.socket().open();
    h.socket().welcome();
    h.socket().drop(1006);
    assert.equal(h.client.status.kind, 'disconnected');
  });
});
