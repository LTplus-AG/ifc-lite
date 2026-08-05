/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The streaming adapters POST to a running viewer over real HTTP, so these
 * tests stand up a real capture server on port 0 and read what actually
 * arrived on the wire. Nothing about `fetch` or the transport is stubbed.
 *
 * The capture server tracks its own sockets and destroys them in `after`, so
 * a failed assertion can never leave a connection holding the server handle
 * open — that is the difference between a failing run and a hanging one.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
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
