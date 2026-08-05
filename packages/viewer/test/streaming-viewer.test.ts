/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two independent sweeps landed tests for the streaming adapters, and both
 * are kept here because they pin different things:
 *
 *  - The wire-level suites stand up a real capture server on port 0 and read
 *    what actually arrived over HTTP. Nothing about `fetch` or the transport
 *    is stubbed, so they also cover the port, the method and the content type.
 *  - The "(stubbed fetch)" suites replace `globalThis.fetch` and assert the
 *    exact request URL and JSON body of every individual adapter method.
 *
 * The capture server tracks its own sockets and destroys them in `after`, so
 * a failed assertion can never leave a connection holding the server handle
 * open — that is the difference between a failing run and a hanging one.
 *
 * The fetch stub is installed per suite (see `useFetchStub`), never at file
 * scope, so the wire-level suites always run against the real `fetch`.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { EntityRef } from '@ifc-lite/sdk';
import {
  createStreamingViewerAdapter,
  createStreamingVisibilityAdapter,
} from '../src/streaming-viewer.js';

const TO = { timeout: 30_000 } as const;

let server: Server;
let port: number;
let received: Array<Record<string, unknown>>;
let paths: string[];
let methods: Array<string | undefined>;
let contentTypes: Array<string | undefined>;
const sockets = new Set<Socket>();

const ref = (expressId: number): EntityRef => ({ modelId: 'arch', expressId });

/** Wait until exactly `n` commands have landed, or fail. */
async function waitFor(n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (received.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(received.length, n, `expected exactly ${n} commands on the wire`);
}

/** Assert no further command arrives (used to pin the negative direction). */
async function expectNoMore(n: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, n);
}

type Call = { url: string; body: Record<string, unknown> };

let calls: Call[];
let originalFetch: typeof fetch;

/**
 * Register a `globalThis.fetch` stub for the *enclosing suite only*, and
 * restore the real one afterwards. The stub records before its first await,
 * i.e. synchronously within the adapter call, so the fire-and-forget adapter
 * methods can be asserted without awaiting anything.
 */
function useFetchStub(): void {
  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
}

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      paths.push(req.url ?? '');
      methods.push(req.method);
      contentTypes.push(req.headers['content-type']);
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  port = addr.port;
}, TO);

after(() => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  server?.close();
}, TO);

beforeEach(() => {
  received = [];
  paths = [];
  methods = [];
  contentTypes = [];
});

describe('createStreamingViewerAdapter', () => {
  it('POSTs JSON to /api/command on the given port', TO, async () => {
    createStreamingViewerAdapter(port).flyTo([ref(1)]);
    await waitFor(1);
    assert.equal(paths[0], '/api/command');
    assert.equal(methods[0], 'POST');
    assert.equal(contentTypes[0], 'application/json');
    assert.deepEqual(received[0], { action: 'flyto', ids: [1] });
  });

  it('colorize sends the express ids and colour verbatim', TO, async () => {
    createStreamingViewerAdapter(port).colorize([ref(4), ref(9)], [1, 0.5, 0, 1]);
    await waitFor(1);
    assert.deepEqual(received[0], {
      action: 'colorizeEntities',
      ids: [4, 9],
      color: [1, 0.5, 0, 1],
    });
  });

  it('sends only the expressId, dropping the modelId', TO, async () => {
    // The viewer indexes by express id alone; leaking `{modelId, expressId}`
    // objects onto the wire would make every id fail to match.
    createStreamingViewerAdapter(port).flyTo([ref(42)]);
    await waitFor(1);
    assert.deepEqual(received[0].ids, [42]);
  });

  it('colorizeAll sends one command per batch, not just the first', TO, async () => {
    createStreamingViewerAdapter(port).colorizeAll([
      { refs: [ref(1)], color: [1, 0, 0, 1] },
      { refs: [ref(2), ref(3)], color: [0, 1, 0, 1] },
      { refs: [ref(4)], color: [0, 0, 1, 1] },
    ]);
    await waitFor(3);
    const byColor = new Map(received.map((c) => [JSON.stringify(c.color), c.ids]));
    assert.deepEqual(byColor.get('[1,0,0,1]'), [1]);
    assert.deepEqual(byColor.get('[0,1,0,1]'), [2, 3]);
    assert.deepEqual(byColor.get('[0,0,1,1]'), [4]);
    for (const c of received) assert.equal(c.action, 'colorizeEntities');
  });

  it('colorizeAll with no batches sends nothing', TO, async () => {
    createStreamingViewerAdapter(port).colorizeAll([]);
    await expectNoMore(0);
  });

  // Both directions of the resetColors branch. A scoped reset must target
  // the given entities; an unscoped reset must fall back to the global
  // "showall", or the user's other overrides would silently survive.
  it('resetColors with refs sends a scoped reset', TO, async () => {
    createStreamingViewerAdapter(port).resetColors([ref(7)]);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'resetColorEntities', ids: [7] });
  });

  it('resetColors with no argument sends the global showall', TO, async () => {
    createStreamingViewerAdapter(port).resetColors();
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'showall' });
  });

  it('resetColors with an EMPTY array also sends the global showall', TO, async () => {
    // Boundary: [] is falsy-adjacent but truthy in JS. Treating it as a
    // scoped reset would send `resetColorEntities` with an empty id list —
    // a no-op, so the viewer would keep every colour override.
    createStreamingViewerAdapter(port).resetColors([]);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'showall' });
  });

  it('setSection and setCamera forward their payloads under the right action', TO, async () => {
    const adapter = createStreamingViewerAdapter(port);
    const plane = { axis: 'z' as const, position: 2.5, enabled: true, flipped: false };
    adapter.setSection(plane);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'section', section: plane });

    received = [];
    adapter.setCamera({ mode: 'orthographic', target: [0, 0, 0] });
    await waitFor(1);
    assert.deepEqual(received[0], {
      action: 'camera',
      state: { mode: 'orthographic', target: [0, 0, 0] },
    });
  });

  it('the getters are write-only stubs and never touch the wire', TO, async () => {
    const adapter = createStreamingViewerAdapter(port);
    assert.equal(adapter.getSection(), null);
    assert.deepEqual(adapter.getCamera(), { mode: 'perspective' });
    await expectNoMore(0);
  });

  it('targets the port it was constructed with', TO, async () => {
    // A hard-coded or off-by-one port would silently send every command into
    // the void — the adapter swallows transport errors by design, so nothing
    // else in the suite would notice.
    const second: Array<Record<string, unknown>> = [];
    const other = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        second.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200).end('{}');
      });
    });
    other.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    try {
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
      const addr = other.address();
      assert.ok(addr && typeof addr === 'object');

      createStreamingViewerAdapter(addr.port).flyTo([ref(11)]);
      const deadline = Date.now() + 5000;
      while (second.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.deepEqual(second, [{ action: 'flyto', ids: [11] }]);
      // …and nothing reached the other server.
      await expectNoMore(0);
    } finally {
      other.close();
    }
  });

  it('swallows a transport failure instead of rejecting the caller', TO, async () => {
    // Fire-and-forget: a closed viewer must not take the SDK call down.
    const dead = createStreamingViewerAdapter(1);
    assert.doesNotThrow(() => dead.flyTo([ref(1)]));
    await new Promise((r) => setTimeout(r, 200));
  });
});

describe('createStreamingVisibilityAdapter', () => {
  it('hide, show and isolate each map to their own distinct action', TO, async () => {
    const adapter = createStreamingVisibilityAdapter(port);

    adapter.hide([ref(1), ref(2)]);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'hideEntities', ids: [1, 2] });

    received = [];
    adapter.show([ref(3)]);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'showEntities', ids: [3] });

    received = [];
    adapter.isolate([ref(4)]);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'isolateEntities', ids: [4] });
  });

  it('reset sends the global showall with no id list', TO, async () => {
    createStreamingVisibilityAdapter(port).reset();
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'showall' });
    assert.ok(!('ids' in received[0]));
  });

  it('an empty ref list still sends the command with an empty id array', TO, async () => {
    createStreamingVisibilityAdapter(port).hide([]);
    await waitFor(1);
    assert.deepEqual(received[0], { action: 'hideEntities', ids: [] });
  });
});

// The suites below stub `fetch` rather than listening on a socket. They pin
// the exact request URL and the per-method JSON body one call at a time,
// which the batched wire-level suites above deliberately do not.

describe('createStreamingViewerAdapter (stubbed fetch)', () => {
  useFetchStub();

  it('colorize posts colorizeEntities with mapped ids and color', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.colorize([ref(1), ref(2)], [1, 0, 0, 1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:4321/api/command');
    assert.deepEqual(calls[0].body, { action: 'colorizeEntities', ids: [1, 2], color: [1, 0, 0, 1] });
  });

  it('colorizeAll sends one command per batch', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.colorizeAll([
      { refs: [ref(1)], color: [1, 0, 0, 1] },
      { refs: [ref(2), ref(3)], color: [0, 1, 0, 1] },
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { action: 'colorizeEntities', ids: [1], color: [1, 0, 0, 1] });
    assert.deepEqual(calls[1].body, { action: 'colorizeEntities', ids: [2, 3], color: [0, 1, 0, 1] });
  });

  it('resetColors with non-empty refs sends resetColorEntities with those ids', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.resetColors([ref(7), ref(8)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { action: 'resetColorEntities', ids: [7, 8] });
  });

  it('resetColors with no refs sends showall', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.resetColors();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { action: 'showall' });
  });

  it('resetColors with an empty refs array sends showall, not resetColorEntities', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.resetColors([]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { action: 'showall' });
  });

  it('flyTo posts flyto with mapped ids', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.flyTo([ref(9)]);
    assert.deepEqual(calls[0].body, { action: 'flyto', ids: [9] });
  });

  it('setSection posts section with the section payload', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.setSection({ plane: 'x' });
    assert.deepEqual(calls[0].body, { action: 'section', section: { plane: 'x' } });
  });

  it('getSection returns null', () => {
    const adapter = createStreamingViewerAdapter(4321);
    assert.equal(adapter.getSection(), null);
  });

  it('setCamera posts camera with the state payload', () => {
    const adapter = createStreamingViewerAdapter(4321);
    adapter.setCamera({ pos: [0, 0, 1] });
    assert.deepEqual(calls[0].body, { action: 'camera', state: { pos: [0, 0, 1] } });
  });

  it('getCamera returns a perspective mode stub', () => {
    const adapter = createStreamingViewerAdapter(4321);
    assert.deepEqual(adapter.getCamera(), { mode: 'perspective' });
  });
});

describe('createStreamingVisibilityAdapter (stubbed fetch)', () => {
  useFetchStub();

  it('hide posts hideEntities with mapped ids', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.hide([ref(1), ref(2)]);
    assert.deepEqual(calls[0].body, { action: 'hideEntities', ids: [1, 2] });
  });

  it('show posts showEntities with mapped ids', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.show([ref(3)]);
    assert.deepEqual(calls[0].body, { action: 'showEntities', ids: [3] });
  });

  it('isolate posts isolateEntities with mapped ids', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.isolate([ref(4)]);
    assert.deepEqual(calls[0].body, { action: 'isolateEntities', ids: [4] });
  });

  it('reset posts showall', () => {
    const adapter = createStreamingVisibilityAdapter(4321);
    adapter.reset();
    assert.deepEqual(calls[0].body, { action: 'showall' });
  });
});
