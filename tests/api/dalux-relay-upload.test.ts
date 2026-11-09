/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The relay's one write path: Dalux's three-step file upload (#9522). Every
 * other write stays a 405, which `dalux-relay.test.ts` already asserts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDaluxRelayHandler,
  DEFAULT_DALUX_RELAY_CONFIG,
  MAX_RELAYED_BODY_BYTES,
} from '../../server/sources/dalux-relay.js';

const APP_ORIGIN = 'https://app.example';
const AREA = '1.0/projects/p1/file_areas/a1';
const SLOT = `${AREA}/upload`;
const PART = `${AREA}/upload/guid-1`;
const FINALIZE = '2.0/projects/p1/file_areas/a1/upload/guid-1/finalize';

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
}

function createHandler(respond: () => Response = () => new Response('{"data":{}}', { status: 201 })) {
  const captured: Captured[] = [];
  const handler = createDaluxRelayHandler(
    { ...DEFAULT_DALUX_RELAY_CONFIG, allowedOrigins: [APP_ORIGIN] },
    {
      fetchImpl: async (input, init) => {
        captured.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body: init?.body ? new Uint8Array(init.body as Uint8Array) : null,
        });
        return respond();
      },
    },
  );
  return { handler, captured };
}

function post(path: string, body: BodyInit, headers: Record<string, string>): Request {
  return new Request(`${APP_ORIGIN}/api/dalux/${path}`, {
    method: 'POST',
    headers: { 'x-api-key': 'caller-key', ...headers },
    body,
  });
}

function part(bytes: Uint8Array, range = `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`) {
  return post(PART, bytes, {
    'content-type': 'application/octet-stream',
    'content-range': range,
    'content-disposition': "form-data; filename=\"model.ifc\"; filename*=UTF-8''model.ifc",
  });
}

test('relays slot creation, a part and finalize to the upstream', async () => {
  const { handler, captured } = createHandler();

  const slot = await handler(post(SLOT, '{}', { 'content-type': 'application/json' }));
  assert.equal(slot.status, 201);

  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal((await handler(part(bytes))).status, 201);

  const finalize = await handler(
    post(FINALIZE, JSON.stringify({ fileName: 'model.ifc', folderId: 'f1' }), {
      'content-type': 'application/json',
    }),
  );
  assert.equal(finalize.status, 201);

  assert.deepEqual(
    captured.map((c) => [c.method, c.url]),
    [
      ['POST', `https://node1.field.dalux.com/service/api/${SLOT}`],
      ['POST', `https://node1.field.dalux.com/service/api/${PART}`],
      ['POST', `https://node1.field.dalux.com/service/api/${FINALIZE}`],
    ],
  );
  assert.deepEqual(captured[1].body, bytes);
  assert.equal(captured[1].headers.get('content-range'), 'bytes 0-3/4');
  assert.match(captured[1].headers.get('content-disposition') ?? '', /model\.ifc/);
  assert.equal(captured[1].headers.get('x-api-key'), 'caller-key');
});

test('POST stays a 405 on every non-upload path', async () => {
  const { handler, captured } = createHandler();
  for (const path of [
    '5.1/projects',
    '2.0/projects/p1/file_areas/a1/files',
    '1.0/projects/p1/file_areas/a1/upload/guid-1/extra',
    '2.0/projects/p1/file_areas/a1/upload/guid-1',
    '1.0/projects/p1/users',
  ]) {
    const response = await handler(post(path, '{}', { 'content-type': 'application/json' }));
    assert.ok([400, 405].includes(response.status), `${path} answered ${response.status}`);
  }
  assert.equal(captured.length, 0);
});

test('upload paths cannot be read with GET', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(
    new Request(`${APP_ORIGIN}/api/dalux/${SLOT}`, { headers: { 'x-api-key': 'caller-key' } }),
  );
  assert.equal(response.status, 405);
  assert.equal(captured.length, 0);
});

test('PUT, PATCH and DELETE on upload paths are still refused', async () => {
  const { handler, captured } = createHandler();
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const response = await handler(
      new Request(`${APP_ORIGIN}/api/dalux/${PART}`, {
        method,
        headers: { 'x-api-key': 'caller-key' },
      }),
    );
    assert.equal(response.status, 405, method);
  }
  assert.equal(captured.length, 0);
});

test('an upload needs the caller API key', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(
    new Request(`${APP_ORIGIN}/api/dalux/${SLOT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(captured.length, 0);
});

test('refuses a part larger than the relay cap without contacting upstream', async () => {
  const { handler, captured } = createHandler();
  const size = MAX_RELAYED_BODY_BYTES + 1;
  const response = await handler(part(new Uint8Array(size)));
  assert.equal(response.status, 413);
  assert.equal(captured.length, 0);
});

test('accepts a part exactly at the relay cap', async () => {
  const { handler, captured } = createHandler(() => new Response(null, { status: 202 }));
  const bytes = new Uint8Array(MAX_RELAYED_BODY_BYTES);
  const response = await handler(
    part(bytes, `bytes 0-${MAX_RELAYED_BODY_BYTES - 1}/${MAX_RELAYED_BODY_BYTES * 2}`),
  );
  assert.equal(response.status, 202);
  assert.equal(captured.length, 1);
});

test('a part must declare a Content-Range that matches its body', async () => {
  const { handler, captured } = createHandler();
  const bytes = new Uint8Array(4);
  for (const range of ['', 'bytes 0-9/10', 'bytes 3-0/4', 'bytes 0-3/3', 'items 0-3/4']) {
    const response = await handler(part(bytes, range));
    assert.equal(response.status, 400, `range "${range}"`);
  }
  assert.equal(captured.length, 0);
});

test('a part needs Content-Disposition and the octet-stream type', async () => {
  const { handler, captured } = createHandler();
  const bytes = new Uint8Array(2);
  const noName = await handler(
    post(PART, bytes, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-1/2' }),
  );
  assert.equal(noName.status, 400);
  const wrongType = await handler(
    post(PART, bytes, {
      'content-type': 'text/plain',
      'content-range': 'bytes 0-1/2',
      'content-disposition': 'form-data; filename="a.ifc"',
    }),
  );
  assert.equal(wrongType.status, 400);
  assert.equal(captured.length, 0);
});

test('slot and finalize require a JSON body', async () => {
  const { handler, captured } = createHandler();
  const notJson = await handler(post(FINALIZE, 'nope', { 'content-type': 'application/json' }));
  assert.equal(notJson.status, 400);
  const wrongType = await handler(post(SLOT, '{}', { 'content-type': 'text/plain' }));
  assert.equal(wrongType.status, 400);
  assert.equal(captured.length, 0);
});

test('an upload is never redirected', async () => {
  const { handler, captured } = createHandler(
    () => new Response(null, { status: 307, headers: { location: '/elsewhere' } }),
  );
  const response = await handler(post(SLOT, '{}', { 'content-type': 'application/json' }));
  assert.equal(response.status, 502);
  assert.equal(captured.length, 1);
});

test('upload headers are not forwarded on reads', async () => {
  const { handler, captured } = createHandler(() => new Response('{}', { status: 200 }));
  await handler(
    new Request(`${APP_ORIGIN}/api/dalux/5.1/projects`, {
      headers: {
        'x-api-key': 'caller-key',
        'content-range': 'bytes 0-1/2',
        'content-disposition': 'form-data; filename="a.ifc"',
      },
    }),
  );
  assert.equal(captured[0].headers.get('content-range'), null);
  assert.equal(captured[0].headers.get('content-disposition'), null);
});

test('reads the two property-mapping endpoints, and no other 1.1 path', async () => {
  const { handler, captured } = createHandler(() => new Response('{}', { status: 200 }));
  const read = (path: string) =>
    handler(new Request(`${APP_ORIGIN}/api/dalux/${path}`, { headers: { 'x-api-key': 'k' } }));

  assert.equal(
    (await read('1.1/projects/p1/file_areas/a1/folders/f1/files/properties/1.0/mappings')).status,
    200,
  );
  assert.equal(
    (await read('1.1/projects/p1/file_areas/a1/files/x1/properties/1.0/mappings')).status,
    200,
  );
  assert.equal((await read('1.1/projects/p1/users')).status, 400);
  assert.equal(captured.length, 2);
});

test('preflight advertises POST and the upload headers', async () => {
  const { handler } = createHandler();
  const response = await handler(
    new Request(`${APP_ORIGIN}/api/dalux/${PART}`, {
      method: 'OPTIONS',
      headers: { origin: APP_ORIGIN },
    }),
  );
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(response.headers.get('access-control-allow-headers') ?? '', /Content-Range/);
});
