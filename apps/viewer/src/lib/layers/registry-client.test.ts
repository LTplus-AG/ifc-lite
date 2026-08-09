/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerRegistryClient, RegistryError } from './registry-client.js';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withMockFetch<T>(impl: FetchImpl, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const BASE = 'http://registry.example';

test('a plain non-2xx (no `status` field) rejects with a RegistryError carrying the body error and HTTP status', async () => {
  await withMockFetch(
    async () => new Response(JSON.stringify({ error: 'layer not found' }), { status: 404 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      await assert.rejects(
        () => client.pullLayer('missing-layer'),
        (err: unknown) => {
          assert.ok(err instanceof RegistryError, 'expected a RegistryError');
          assert.equal((err as RegistryError).status, 404);
          assert.equal((err as RegistryError).message, 'layer not found');
          return true;
        },
      );
    },
  );
});

test('a non-2xx body carrying a `status` field resolves as data instead of throwing (merge outcome pass-through)', async () => {
  const outcomeBody = {
    status: 'conflicts',
    conflicts: [{ componentKey: 'pset:Pset_FireSafety' }],
  };
  await withMockFetch(
    async () => new Response(JSON.stringify(outcomeBody), { status: 409 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      const result = await client.mergeRef('main', { candidate: 'blake3:x' });
      assert.deepEqual(result, outcomeBody);
    },
  );
});

test('path segments are encodeURIComponent-encoded before reaching fetch', async () => {
  const id = 'a/b#c d';
  const captured: string[] = [];
  await withMockFetch(
    async (input) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ header: { id } }), { status: 200 });
    },
    async () => {
      const client = new LayerRegistryClient(BASE);
      await client.pullLayer(id);
    },
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0], `${BASE}/api/v1/layers/a%2Fb%23c%20d`);
});

test('a non-JSON error body degrades to `{ error: text }`, surfaced as the RegistryError message', async () => {
  await withMockFetch(
    async () => new Response('Internal Server Error', { status: 500 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      await assert.rejects(
        () => client.listLayers(),
        (err: unknown) => {
          assert.ok(err instanceof RegistryError);
          assert.equal((err as RegistryError).message, 'Internal Server Error');
          assert.equal((err as RegistryError).status, 500);
          return true;
        },
      );
    },
  );
});

test('an empty success body resolves to `{}`', async () => {
  await withMockFetch(
    async () => new Response('', { status: 200 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      const result = await client.listLayers();
      assert.deepEqual(result, {});
    },
  );
});

test('getReport bypasses the JSON envelope and returns the raw text body unparsed', async () => {
  // Deliberately has whitespace a JSON.parse/stringify round-trip would
  // strip, so a regression to JSON-parsing this body is caught by content,
  // not just by type.
  const raw = '{"looks": "like json but must come back as a raw string,  unparsed"}';
  await withMockFetch(
    async () => new Response(raw, { status: 200 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      const result = await client.getReport('deadbeef');
      assert.equal(result, raw);
      assert.equal(typeof result, 'string');
    },
  );
});

test('getReport returns null on 404 instead of throwing', async () => {
  await withMockFetch(
    async () => new Response('not found', { status: 404 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      const result = await client.getReport('missing-digest');
      assert.equal(result, null);
    },
  );
});

test('getReport throws RegistryError on a non-404 failure', async () => {
  await withMockFetch(
    async () => new Response('boom', { status: 503 }),
    async () => {
      const client = new LayerRegistryClient(BASE);
      await assert.rejects(
        () => client.getReport('some-digest'),
        (err: unknown) => {
          assert.ok(err instanceof RegistryError);
          assert.equal((err as RegistryError).status, 503);
          assert.equal((err as RegistryError).message, 'evidence fetch failed (503)');
          return true;
        },
      );
    },
  );
});
