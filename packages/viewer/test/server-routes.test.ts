/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end route tests for the viewer HTTP server.
 *
 * These drive a REAL `node:http` server over a REAL socket on port 0 —
 * nothing about the request path is mocked. Every request gets its own
 * socket and its own deadline (see ./helpers/http.ts); the SSE suite closes
 * its stream from a `finally` so a failed assertion cannot leave the server
 * handle open and hang the run.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePackageDirFromModuleUrl,
  startViewerServer,
  VALID_ACTIONS,
  type CreateResult,
  type ViewerServer,
  type ViewerServerOptions,
} from '../src/server.js';
import {
  destroyAllSockets,
  json,
  openStream,
  poll,
  req,
  sleep,
  TEST_TIMEOUT,
} from './helpers/http.js';

const HOOK_TIMEOUT = { timeout: 30_000 };

/**
 * Fail fast, and say what to do about it.
 *
 * `startViewerServer` reads the wasm glue at boot, so EVERY suite in this file
 * needs `@ifc-lite/wasm`'s runtime — and that runtime is gitignored
 * (`packages/wasm/pkg/.gitignore` is `*`), built by CI before the test job and
 * by `bash scripts/build-wasm.sh` locally. Without it all six `before` hooks
 * die on a bare `ENOENT … node_modules/@ifc-lite/wasm/pkg/ifc-lite.js`, which
 * reads like a broken install rather than a missing build step.
 *
 * This throws instead of skipping on purpose: if a CI wasm build ever silently
 * fails, these tests must go red, not quietly stop covering the wasm routes.
 */
before(async () => {
  const wasmDir = resolvePackageDirFromModuleUrl(import.meta.resolve('@ifc-lite/wasm'));
  const pkgDir = join(wasmDir, 'pkg');
  for (const name of ['ifc-lite.js', 'ifc-lite_bg.wasm']) {
    await access(join(pkgDir, name)).catch(() => {
      throw new Error(
        `Missing wasm runtime ${join(pkgDir, name)}. These tests serve the real ` +
          `@ifc-lite/wasm artifacts over HTTP, and the runtime is gitignored. ` +
          `Build it first: bash scripts/build-wasm.sh`,
      );
    });
  }
}, HOOK_TIMEOUT);

/** Every server booted by a test, so the final teardown can close them all. */
const booted: ViewerServer[] = [];

async function boot(
  opts: Partial<ViewerServerOptions> = {},
): Promise<{ server: ViewerServer; port: number }> {
  let port = 0;
  const server = await startViewerServer({
    filePath: null,
    fileName: 'model.ifc',
    port: 0,
    ...opts,
    onReady: (p, u) => {
      port = p;
      opts.onReady?.(p, u);
    },
  });
  booted.push(server);
  assert.ok(port > 0, 'onReady must report the bound ephemeral port');
  return { server, port };
}

/**
 * Last line of defence. Runs after every suite in this file, including when
 * an assertion threw: kill any client socket first (an open SSE socket keeps
 * the server handle referenced), then close every server we started.
 */
after(() => {
  destroyAllSockets();
  for (const s of booted) s.close();
}, HOOK_TIMEOUT);

describe('viewer server — static routes and CORS', () => {
  let server: ViewerServer;
  let port: number;
  let dir: string;
  let ifcPath: string;
  const IFC = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-viewer-'));
    ifcPath = join(dir, 'house.ifc');
    await writeFile(ifcPath, IFC);
    ({ server, port } = await boot({ filePath: ifcPath, fileName: 'house.ifc' }));
  }, HOOK_TIMEOUT);

  after(async () => {
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, HOOK_TIMEOUT);

  // Both directions of the CORS decision, one `it` per origin so a kill is
  // attributed to the exact origin that discriminates. The allowlist regex is
  // anchored; unanchored, it would echo the origin back to any host that
  // merely *contains* "localhost", handing a hostile page read access to the
  // model and the command API.
  for (const origin of [
    'http://localhost',
    'http://localhost:5173',
    'https://localhost:8443',
    'http://127.0.0.1',
    'http://127.0.0.1:3000',
  ]) {
    it(`echoes Access-Control-Allow-Origin for ${origin}`, TEST_TIMEOUT, async () => {
      const res = await req(port, '/api/status', { headers: { origin } });
      assert.equal(res.headers['access-control-allow-origin'], origin);
    });
  }

  for (const origin of [
    'http://localhost.evil.com',
    'http://evil.com',
    'https://evil.com/?next=http://localhost',
    'http://127.0.0.1.evil.com',
    'http://localhosts',
    'http://alocalhost',
    'ftp://localhost',
    'http://localhost:notaport',
  ]) {
    it(`withholds Access-Control-Allow-Origin for ${origin}`, TEST_TIMEOUT, async () => {
      const res = await req(port, '/api/status', { headers: { origin } });
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  }

  it('omits the allow-origin header entirely when no Origin is sent', TEST_TIMEOUT, async () => {
    const res = await req(port, '/api/status');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    // The non-origin CORS headers are unconditional.
    assert.equal(res.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
    assert.equal(res.headers['access-control-allow-headers'], 'Content-Type');
  });

  it('answers the preflight with 204 and no body', TEST_TIMEOUT, async () => {
    const res = await req(port, '/api/command', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.body.byteLength, 0);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  });

  it('short-circuits OPTIONS even on a route that exists', TEST_TIMEOUT, async () => {
    // The OPTIONS guard sits ahead of route dispatch. Without it, an OPTIONS
    // /api/status would fall through to the 404 tail and the browser would
    // refuse the preflight.
    const res = await req(port, '/api/status', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.body.byteLength, 0);
  });

  it('serves the viewer HTML at /', TEST_TIMEOUT, async () => {
    const res = await req(port, '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.body.toString(), /<title>house\.ifc — ifc-lite 3D<\/title>/);
  });

  it('does not serve the viewer HTML for POST /', TEST_TIMEOUT, async () => {
    const res = await req(port, '/', { method: 'POST', body: '' });
    assert.equal(res.status, 404);
  });

  it('ignores the query string when matching a route', TEST_TIMEOUT, async () => {
    // Dispatch is on `url.pathname`, not on the raw `req.url`. Matching the
    // raw URL would 404 every cache-busted request the browser makes.
    const res = await req(port, '/?v=12345');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  });

  it('streams the model with a Content-Length matching the file exactly', TEST_TIMEOUT, async () => {
    const res = await req(port, '/model.ifc');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(IFC)));
    assert.equal(res.body.toString(), IFC);
  });

  it('re-stats the model per request so a rewritten file is not truncated', TEST_TIMEOUT, async () => {
    const bigger = IFC + '/* appended after server start */\n';
    await writeFile(ifcPath, bigger);
    try {
      const res = await req(port, '/model.ifc');
      assert.equal(res.headers['content-length'], String(Buffer.byteLength(bigger)));
      assert.equal(res.body.toString(), bigger);
    } finally {
      await writeFile(ifcPath, IFC);
    }
  });

  it('rewrites the wasm glue to load the binary from the server origin', TEST_TIMEOUT, async () => {
    const res = await req(port, '/wasm/ifc-lite.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
    const js = res.body.toString();
    assert.match(js, /new URL\('\/wasm\/ifc-lite_bg\.wasm', location\.origin\)/);
    assert.doesNotMatch(js, /new URL\('ifc-lite_bg\.wasm', import\.meta\.url\)/);
  });

  it('serves the wasm binary with the wasm MIME type and exact length', TEST_TIMEOUT, async () => {
    const res = await req(port, '/wasm/ifc-lite_bg.wasm');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/wasm');
    assert.equal(res.headers['content-length'], String(res.body.byteLength));
    // Absolute check against the WebAssembly spec's magic number.
    assert.deepEqual([...res.body.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  });

  it('404s a snippet asset that does not exist', TEST_TIMEOUT, async () => {
    const res = await req(port, '/wasm/snippets/nope-1234/missing.js');
    assert.equal(res.status, 404);
    assert.equal(res.headers['content-type'], 'text/plain');
    assert.equal(res.body.toString(), 'Not Found');
  });

  it('404s a traversal attempt under /wasm/snippets/', TEST_TIMEOUT, async () => {
    // Two layers, and it matters which one answers.
    //
    // `server.ts` parses the request line with `new URL(...)` (server.ts:164)
    // and routes on `url.pathname`, and the WHATWG parser removes double-dot
    // path segments — including their percent-encoded spellings `%2e%2e` and
    // `.%2e`. So a LITERAL `..` traversal never even reaches the
    // `/wasm/snippets/` branch (server.ts:220): by the time routing happens the
    // pathname is plain `/etc/passwd` and it falls through to the unknown-route
    // 404. That is a real defence, so it is asserted — but it is normalisation,
    // not `resolveWasmAssetPath`.
    const normalised = await req(port, '/wasm/snippets/../../../../../../etc/passwd');
    assert.equal(normalised.status, 404);
    assert.equal(normalised.body.toString(), 'Not Found');

    // The encoded form survives normalisation (`%2f` is not a segment
    // separator, so `%2e%2e%2f…` is one opaque segment), so THIS one really
    // does enter the `/wasm/snippets/` branch and reach
    // `resolveWasmAssetPath`. Target: `pkg/../package.json`, a file that
    // genuinely exists one level outside the served root — so if the route ever
    // decoded the escapes back into separators AND the guard were gone, this
    // would answer 200 with that file's bytes instead of 404.
    const encoded = await req(port, '/wasm/snippets/%2e%2e%2f%2e%2e%2fpackage.json');
    assert.equal(encoded.status, 404, 'an encoded traversal must not escape pkg/');
    assert.equal(encoded.body.toString(), 'Not Found');

    // `resolveWasmAssetPath` returning `null` for an escaping path is pinned
    // directly in ./server.test.ts — it is unreachable from this route, since
    // `url.pathname` always starts `/wasm/snippets/` here and can never carry a
    // surviving `..` segment for `resolve()` to act on.
  });

  it('404s an unknown route', TEST_TIMEOUT, async () => {
    const res = await req(port, '/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.headers['content-type'], 'text/plain');
    assert.equal(res.body.toString(), 'Not Found');
  });

  it('404s a /wasm/ path that is not one of the three wasm routes', TEST_TIMEOUT, async () => {
    // `/wasm/` is only special for the two named files and the snippets
    // prefix — it is not a general static root over the package directory.
    const res = await req(port, '/wasm/package.json');
    assert.equal(res.status, 404);
  });
});

describe('viewer server — empty mode (no file, no create handler)', () => {
  let server: ViewerServer;
  let port: number;

  before(async () => {
    ({ server, port } = await boot({ filePath: null, fileName: 'untitled.ifc' }));
  }, HOOK_TIMEOUT);
  after(() => server?.close(), HOOK_TIMEOUT);

  it('answers /model.ifc with 204 and an empty body, not 404', TEST_TIMEOUT, async () => {
    // 204 is what the browser loader treats as "start empty"; a 404 would
    // surface as a load error in the viewer.
    const res = await req(port, '/model.ifc');
    assert.equal(res.status, 204);
    assert.equal(res.body.byteLength, 0);
  });

  it('reports 501 Not Implemented for /api/create without a handler', TEST_TIMEOUT, async () => {
    const res = await json(port, '/api/create', {
      method: 'POST',
      body: JSON.stringify({ type: 'wall' }),
    });
    assert.equal(res.status, 501);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(res.json, { ok: false, error: 'Create handler not configured' });
  });

  it('reports ok:false when nothing has been created yet', TEST_TIMEOUT, async () => {
    const res = await json(port, '/api/export');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(res.json, { ok: false, error: 'No geometry has been created yet' });
  });
});

describe('viewer server — /api/command allowlist', () => {
  let server: ViewerServer;
  let port: number;

  before(async () => {
    ({ server, port } = await boot());
  }, HOOK_TIMEOUT);
  after(() => server?.close(), HOOK_TIMEOUT);

  // One `it` per action, so removing any single action from the allowlist is
  // killed by a named test rather than by one lucky case inside a loop.
  for (const action of [
    'colorize', 'isolate', 'xray', 'flyto', 'highlight',
    'colorizeEntities', 'isolateEntities', 'hideEntities', 'showEntities', 'resetColorEntities',
    'section', 'clearSection', 'colorByStorey', 'addGeometry',
    'showall', 'reset', 'picked', 'setView', 'removeCreated', 'camera',
  ]) {
    it(`accepts the "${action}" action`, TEST_TIMEOUT, async () => {
      assert.ok(VALID_ACTIONS.has(action), `${action} must be exported in VALID_ACTIONS`);
      const res = await json(port, '/api/command', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true, action, clients: 0 });
    });
  }

  it('exports exactly the twenty actions the viewer implements', () => {
    // Pins the size in both directions: the per-action tests above catch a
    // removal, this catches a silent addition.
    assert.equal(VALID_ACTIONS.size, 20);
  });

  it('rejects an action outside the allowlist and lists the valid ones', TEST_TIMEOUT, async () => {
    const res = await json(port, '/api/command', {
      method: 'POST',
      body: JSON.stringify({ action: 'rm -rf' }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'Unknown action: rm -rf');
    assert.deepEqual(res.json.validActions, [...VALID_ACTIONS]);
  });

  it('rejects a command with no action at all', TEST_TIMEOUT, async () => {
    const res = await json(port, '/api/command', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Unknown action: (none)');
  });

  it('rejects a malformed JSON body with 400 rather than crashing', TEST_TIMEOUT, async () => {
    const res = await json(port, '/api/command', { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(typeof res.json.error, 'string');
  });

  it('reads the whole request body, not just the first chunk', TEST_TIMEOUT, async () => {
    // A >64 KiB body arrives in several `data` events. Resolving on the first
    // one would truncate the JSON and turn every large command into a 400.
    const ids = Array.from({ length: 40_000 }, (_, i) => i);
    const res = await json(port, '/api/command', {
      method: 'POST',
      body: JSON.stringify({ action: 'flyto', ids }),
    });
    assert.ok(JSON.stringify({ action: 'flyto', ids }).length > 65_536);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, action: 'flyto', clients: 0 });
  });

  it('does not treat GET /api/command as a command', TEST_TIMEOUT, async () => {
    const res = await req(port, '/api/command');
    assert.equal(res.status, 404);
  });

  it('does not treat POST /api/status as a status request', TEST_TIMEOUT, async () => {
    const res = await req(port, '/api/status', { method: 'POST', body: '' });
    assert.equal(res.status, 404);
  });
});

describe('viewer server — SSE broadcast', () => {
  let server: ViewerServer;
  let port: number;

  before(async () => {
    ({ server, port } = await boot());
  }, HOOK_TIMEOUT);
  after(() => server?.close(), HOOK_TIMEOUT);

  it('greets a subscriber, counts it, and forwards accepted commands', TEST_TIMEOUT, async () => {
    const events: string[] = [];
    const stream = await openStream(port, '/events');

    // `finally`: an open SSE socket keeps `server.close()` pending forever,
    // so a failed assertion must not leak the stream out of this test.
    try {
      assert.equal(stream.res.statusCode, 200);
      assert.equal(stream.res.headers['content-type'], 'text/event-stream');
      assert.equal(stream.res.headers['cache-control'], 'no-cache');
      stream.res.on('data', (c: Buffer) => events.push(c.toString()));

      const waitFor = async (n: number) => {
        await poll(() => events.length >= n);
        assert.ok(events.length >= n, `expected ${n} SSE frames, got ${events.length}`);
      };

      await waitFor(1);
      // The greeting is a complete SSE frame: `data: ` prefix, JSON payload,
      // blank-line terminator. Drop either newline and no browser EventSource
      // ever dispatches the event.
      assert.equal(events[0], 'data: {"action":"connected"}\n\n');
      await poll(() => server.clientCount() === 1);
      assert.equal(server.clientCount(), 1);

      const accepted = await json(port, '/api/command', {
        method: 'POST',
        body: JSON.stringify({ action: 'flyto', ids: [7, 9] }),
      });
      assert.equal(accepted.json.clients, 1);
      await waitFor(2);
      assert.equal(events[1], 'data: {"action":"flyto","ids":[7,9]}\n\n');

      // A rejected command must NOT reach subscribers.
      await json(port, '/api/command', {
        method: 'POST',
        body: JSON.stringify({ action: 'nope' }),
      });
      await sleep(100);
      assert.equal(events.length, 2);
    } finally {
      stream.close();
    }

    await poll(() => server.clientCount() === 0);
    assert.equal(server.clientCount(), 0, 'disconnecting must drop the SSE client');
  });

  it('broadcasts to every subscriber, not only the first', TEST_TIMEOUT, async () => {
    const a = await openStream(port, '/events');
    const b = await openStream(port, '/events');
    const seenA: string[] = [];
    const seenB: string[] = [];
    try {
      a.res.on('data', (c: Buffer) => seenA.push(c.toString()));
      b.res.on('data', (c: Buffer) => seenB.push(c.toString()));
      await poll(() => server.clientCount() === 2);
      assert.equal(server.clientCount(), 2);

      server.broadcast({ action: 'showall' });
      await poll(() => seenA.length >= 2 && seenB.length >= 2);
      assert.deepEqual(seenA.at(-1), 'data: {"action":"showall"}\n\n');
      assert.deepEqual(seenB.at(-1), 'data: {"action":"showall"}\n\n');
    } finally {
      a.close();
      b.close();
    }
    await poll(() => server.clientCount() === 0);
    assert.equal(server.clientCount(), 0);
  });

  it('/api/status reports the live subscriber count, not a constant', TEST_TIMEOUT, async () => {
    const before = await json(port, '/api/status');
    assert.equal(before.json.clients, 0);

    const stream = await openStream(port, '/events');
    try {
      await poll(() => server.clientCount() === 1);
      const during = await json(port, '/api/status');
      assert.equal(during.json.clients, 1);
    } finally {
      stream.close();
    }
    await poll(() => server.clientCount() === 0);
    const afterwards = await json(port, '/api/status');
    assert.equal(afterwards.json.clients, 0);
  });

  it('does not open an SSE stream for POST /events', TEST_TIMEOUT, async () => {
    const res = await req(port, '/events', { method: 'POST', body: '' });
    assert.equal(res.status, 404);
    assert.equal(server.clientCount(), 0);
  });
});

describe('viewer server — create / export / clear lifecycle', () => {
  let server: ViewerServer;
  let port: number;
  const seen: unknown[][] = [];
  let nextContent = '';

  before(async () => {
    ({ server, port } = await boot({
      fileName: 'house.ifc',
      createHandler: async (elements): Promise<CreateResult> => {
        seen.push(elements);
        return {
          content: nextContent,
          entities: elements.map((e, i) => ({ type: e.type, expressId: 100 + i })),
          stats: { fileSize: nextContent.length },
        };
      },
    }));
  }, HOOK_TIMEOUT);
  after(() => server?.close(), HOOK_TIMEOUT);

  /**
   * Put the server's created-segment list into an exactly-known state.
   *
   * The suite shares one server, so without this the status/export/clear tests
   * would be reading whatever the create tests above happened to leave behind —
   * they would pass in file order and fail run in isolation or reordered.
   * Clearing first also means the count each of them asserts is the count this
   * helper just produced, not an accumulation of the whole file.
   */
  async function seedSegments(...contents: string[]): Promise<void> {
    const cleared = await json(port, '/api/clear-created', { method: 'POST' });
    assert.equal(cleared.status, 200, 'seed: clear must succeed');
    assert.deepEqual(server.createdSegments, [], 'seed: must start from empty');
    for (const content of contents) {
      nextContent = content;
      const res = await json(port, '/api/create', {
        method: 'POST',
        body: JSON.stringify({ type: 'IfcWall' }),
      });
      assert.equal(res.status, 200, `seed: creating ${content} must succeed`);
    }
    assert.deepEqual(server.createdSegments, contents, 'seed: state must match the request');
  }

  it('wraps a single (non-array) element body into a one-element array', TEST_TIMEOUT, async () => {
    // server.ts: `Array.isArray(parsed) ? parsed : [parsed]`. Without the
    // wrap the handler receives a bare object, `elements.length` is
    // `undefined` and `POST {"type":"IfcWall"}` — the documented single-element
    // form — stops working.
    nextContent = 'SEG_A';
    const res = await json(port, '/api/create', {
      method: 'POST',
      body: JSON.stringify({ type: 'IfcWall', params: { length: 3 } }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.count, 1);
    assert.equal(res.json.ifcSize, 5);
    assert.deepEqual(res.json.entities, [{ type: 'IfcWall', expressId: 100 }]);
    assert.deepEqual(seen.at(-1), [{ type: 'IfcWall', params: { length: 3 } }]);
  });

  it('passes an array body straight through and counts every element', TEST_TIMEOUT, async () => {
    // The other direction of the same branch: an array must NOT be nested
    // inside another array, which would give count 1 and a handler argument
    // of `[[…]]`.
    nextContent = 'SEG_B';
    const res = await json(port, '/api/create', {
      method: 'POST',
      body: JSON.stringify([{ type: 'IfcSlab' }, { type: 'IfcColumn' }]),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 2);
    assert.deepEqual(seen.at(-1), [{ type: 'IfcSlab' }, { type: 'IfcColumn' }]);
    assert.deepEqual(res.json.entities, [
      { type: 'IfcSlab', expressId: 100 },
      { type: 'IfcColumn', expressId: 101 },
    ]);
  });

  it('rejects an element without a "type" field', TEST_TIMEOUT, async () => {
    const before = seen.length;
    const res = await json(port, '/api/create', {
      method: 'POST',
      body: JSON.stringify([{ params: { length: 3 } }]),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { ok: false, error: 'Missing "type" field' });
    assert.equal(seen.length, before, 'the create handler must not run');
  });

  it('rejects an empty element array', TEST_TIMEOUT, async () => {
    const before = seen.length;
    const res = await json(port, '/api/create', { method: 'POST', body: '[]' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { ok: false, error: 'Missing "type" field' });
    assert.equal(seen.length, before, 'the create handler must not run');
  });

  it('rejects a null element without crashing the request', TEST_TIMEOUT, async () => {
    // `[null]` reaches `elements[0].type` on a null. Whatever the message,
    // the contract is a 400 with ok:false — never a hung socket or a 500.
    const before = seen.length;
    const res = await json(port, '/api/create', { method: 'POST', body: '[null]' });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(typeof res.json.error, 'string');
    assert.equal(seen.length, before, 'the create handler must not run');
  });

  it('rejects a malformed create body with 400', TEST_TIMEOUT, async () => {
    const res = await json(port, '/api/create', { method: 'POST', body: '{' });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  });

  it('does not treat GET /api/create as a create', TEST_TIMEOUT, async () => {
    const res = await req(port, '/api/create');
    assert.equal(res.status, 404);
  });

  it('reports the accumulated segment count in /api/status', TEST_TIMEOUT, async () => {
    // Two separate creates, so "accumulated" is what is actually being pinned:
    // a status route that reported 1 (or the last segment only) would fail.
    await seedSegments('SEG_A', 'SEG_B');
    const res = await json(port, '/api/status');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(res.json, {
      ok: true,
      model: 'house.ifc',
      clients: 0,
      createdSegments: 2,
    });
    assert.deepEqual(server.createdSegments, ['SEG_A', 'SEG_B']);
  });

  it('exports the segments newline-separated as an IFC attachment', TEST_TIMEOUT, async () => {
    await seedSegments('SEG_A', 'SEG_B');
    const res = await req(port, '/api/export');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="created-house.ifc"');
    assert.equal(res.body.toString(), 'SEG_A\nSEG_B');
    assert.equal(res.headers['content-length'], String(Buffer.byteLength('SEG_A\nSEG_B')));
  });

  it('clears the segments and reports how many were dropped', TEST_TIMEOUT, async () => {
    // `cleared` must be the number actually dropped, so seed a known 2 — a
    // route that returned a constant, or 1, or the post-clear length, fails.
    await seedSegments('SEG_A', 'SEG_B');
    const res = await json(port, '/api/clear-created', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, cleared: 2 });
    assert.deepEqual(server.createdSegments, []);

    const status = await json(port, '/api/status');
    assert.equal(status.json.createdSegments, 0);

    // Clearing again is a no-op that reports zero.
    const again = await json(port, '/api/clear-created', { method: 'POST' });
    assert.deepEqual(again.json, { ok: true, cleared: 0 });

    const exported = await json(port, '/api/export');
    assert.deepEqual(exported.json, { ok: false, error: 'No geometry has been created yet' });
  });

  it('surfaces a create-handler failure as 400 with the handler message', TEST_TIMEOUT, async () => {
    const failing = await boot({
      createHandler: async () => {
        throw new Error('unsupported element');
      },
    });
    try {
      const res = await json(failing.port, '/api/create', {
        method: 'POST',
        body: JSON.stringify({ type: 'IfcNope' }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.json, { ok: false, error: 'unsupported element' });
      assert.deepEqual(failing.server.createdSegments, [], 'a failed create records no segment');
    } finally {
      failing.server.close();
    }
  });

  it('broadcasts addGeometry with the created IFC content', TEST_TIMEOUT, async () => {
    const live = await boot({
      createHandler: async () => ({
        content: 'CREATED_IFC',
        entities: [{ expressId: 1 }],
        stats: { fileSize: 11 },
      }),
    });
    const stream = await openStream(live.port, '/events');
    const events: string[] = [];
    try {
      stream.res.on('data', (c: Buffer) => events.push(c.toString()));
      await poll(() => events.length >= 1);
      await json(live.port, '/api/create', {
        method: 'POST',
        body: JSON.stringify({ type: 'IfcWall' }),
      });
      await poll(() => events.length >= 2);
      assert.equal(
        events[1],
        'data: {"action":"addGeometry","ifcContent":"CREATED_IFC"}\n\n',
      );

      // …and clearing broadcasts the paired removeCreated.
      await json(live.port, '/api/clear-created', { method: 'POST' });
      await poll(() => events.length >= 3);
      assert.equal(events[2], 'data: {"action":"removeCreated"}\n\n');
    } finally {
      stream.close();
      live.server.close();
    }
  });
});

describe('viewer server — startup contract', () => {
  it('rejects when the model file does not exist', TEST_TIMEOUT, async () => {
    // If the pre-flight `stat` is ever dropped, this resolves instead of
    // rejecting — and the server it just bound would keep the process alive
    // forever. `leaked` + `finally` turns that into a clean failure rather
    // than a hung run.
    let leaked: ViewerServer | undefined;
    try {
      await assert.rejects(
        async () => {
          leaked = await startViewerServer({
            filePath: join(tmpdir(), 'ifclite-does-not-exist-42.ifc'),
            fileName: 'x.ifc',
            port: 0,
          });
        },
        /ENOENT/,
      );
    } finally {
      leaked?.close();
    }
  });

  it('reports the bound port and URL through onReady', TEST_TIMEOUT, async () => {
    let seenPort = -1;
    let seenUrl = '';
    const { server, port } = await boot({
      fileName: 'm.ifc',
      onReady: (p, u) => {
        seenPort = p;
        seenUrl = u;
      },
    });
    try {
      assert.ok(seenPort > 0);
      assert.equal(seenPort, port);
      assert.equal(seenUrl, `http://localhost:${seenPort}`);
      const res = await req(seenPort, '/api/status');
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });
});
