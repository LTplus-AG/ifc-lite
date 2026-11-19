/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Dalux provider's `uploadFile` through the REAL same-origin relay to a
 * mocked Dalux upstream (#9522).
 *
 * The provider and the relay are each tested on their own, but they can still
 * disagree about the wire format. Each step has to satisfy both: which body
 * the slot request carries, the part headers, the part size against the relay
 * cap. This drives the provider exactly as the browser does: every call is
 * rewritten onto `/api/dalux/*` and handled by `createDaluxRelayHandler`, and
 * only the relay talks to the mocked upstream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { SourceFileRef, UploadResult } from '@ifc-lite/plugin-api';
import {
  createDaluxRelayHandler,
  DEFAULT_DALUX_RELAY_CONFIG,
  MAX_RELAYED_BODY_BYTES,
} from '../../server/sources/dalux-relay.js';
import { DaluxBuildProvider } from '../../packages/source-dalux/src/provider.js';
import { folderContainerId } from '../../packages/source-dalux/src/mapping.js';
import { DALUX_DEFAULT_PART_BYTES } from '../../packages/source-dalux/src/upload.js';
import {
  createDaluxApiMock,
  createDaluxMockContext,
  DALUX_MOCK_BASE_URL,
  type DaluxMockWorld,
} from '../../packages/source-dalux/test/dalux-api-mock.js';

const APP_ORIGIN = 'https://app.example';

const WORLD: DaluxMockWorld = {
  projects: [
    {
      projectId: 'p1',
      projectName: 'Project',
      fileAreas: [
        {
          fileAreaId: 'fa-files',
          fileAreaName: 'Files',
          fileAreaType: 'files',
          folders: [
            { folderId: 'fld-ifc', folderName: 'IFC' },
            { folderId: 'fld-other', folderName: 'Other' },
          ],
          files: [
            {
              fileId: 'file-a',
              fileName: 'a.ifc',
              folderId: 'fld-ifc',
              fileRevisionId: 'rev-1',
              fileType: 'model',
              content: 'A-ONE',
            },
          ],
        },
      ],
    },
  ],
};

interface RelayedCall {
  readonly method: string;
  readonly status: number;
  readonly path: string;
}

/**
 * A `PluginContext` whose fetch goes the way the browser's does: the Dalux
 * URL is rewritten onto the same-origin relay path, and the relay handler,
 * not the test, decides what reaches the mocked upstream.
 */
function throughRelay() {
  const mock = createDaluxApiMock(WORLD, { pageSize: 100 });
  // The package mock answers JSON routes with a minimal Response-shaped
  // object (no body stream, one content type for every header name), which
  // is enough for the provider's own tests. The relay streams `body` and
  // copies headers by name, so it is given a real Response, as Dalux sends.
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await mock(input, init);
    if (response instanceof Response) return response;
    const bytes = await response.arrayBuffer();
    return new Response(bytes.byteLength > 0 ? bytes : null, {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' },
    });
  }) as typeof fetch;
  const relay = createDaluxRelayHandler(
    { ...DEFAULT_DALUX_RELAY_CONFIG, allowedOrigins: [APP_ORIGIN] },
    { fetchImpl: upstream },
  );
  const calls: RelayedCall[] = [];

  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    assert.ok(url.href.startsWith(DALUX_MOCK_BASE_URL), `unexpected direct call to ${url.href}`);
    const tail = url.pathname.slice(new URL(DALUX_MOCK_BASE_URL).pathname.length + 1);
    const response = await relay(
      new Request(`${APP_ORIGIN}/api/dalux/${tail}${url.search}`, {
        method: init?.method ?? 'GET',
        headers: init?.headers,
        body: init?.body ?? null,
        signal: init?.signal ?? null,
      }),
    );
    calls.push({ method: init?.method ?? 'GET', status: response.status, path: tail });
    return response;
  }) as typeof fetch;

  return { ctx: createDaluxMockContext(browserFetch), provider: new DaluxBuildProvider(), calls };
}

function ok(result: UploadResult) {
  if (!result.ok) throw new Error(`expected success, got conflict ${JSON.stringify(result.conflict)}`);
  return result;
}

/**
 * A payload that needs three parts at the default part size. ASCII, because
 * the package mock stores uploaded content as text; the byte pattern still
 * makes a misplaced or dropped part visible.
 */
function multiPartPayload(): Uint8Array {
  const size = DALUX_DEFAULT_PART_BYTES * 2 + 17;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = 65 + (i % 26);
  return bytes;
}

/** Byte equality without a multi-megabyte diff on failure. */
function assertSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  assert.equal(actual.byteLength, expected.byteLength, 'length');
  const first = actual.findIndex((value, index) => value !== expected[index]);
  assert.equal(first, -1, `first differing byte at ${first}`);
}

async function download(
  provider: DaluxBuildProvider,
  ctx: ReturnType<typeof throughRelay>['ctx'],
  ref: SourceFileRef,
): Promise<Uint8Array> {
  return new Uint8Array(await provider.download(ctx, ref));
}

test('the default part size fits the relay cap', () => {
  assert.ok(DALUX_DEFAULT_PART_BYTES <= MAX_RELAYED_BODY_BYTES);
});

test('new-version: every upload step passes the relay, and the new bytes come back', async () => {
  const { ctx, provider, calls } = throughRelay();
  const payload = multiPartPayload();

  const result = ok(
    await provider.uploadFile(
      ctx,
      {
        mode: 'new-version',
        ref: { projectId: 'p1', containerId: folderContainerId('fa-files', 'fld-ifc'), fileId: 'file-a' },
        baseRevisionId: 'rev-1',
      },
      payload.buffer as ArrayBuffer,
    ),
  );

  const posts = calls.filter((call) => call.method === 'POST');
  assert.deepEqual(
    posts.map((call) => call.status),
    [201, 202, 202, 202, 201],
    'slot, three parts, finalize, all accepted by the relay and the upstream',
  );
  assert.ok(calls.every((call) => call.status < 400), JSON.stringify(calls.filter((c) => c.status >= 400)));

  const stored = await download(provider, ctx, {
    projectId: 'p1',
    containerId: folderContainerId('fa-files', 'fld-ifc'),
    fileId: result.file.id,
    revisionId: result.revision.id,
  });
  assertSameBytes(stored, payload);
});

for (const [mode, folderId] of [
  ['new-file', 'fld-ifc'],
  ['new-location', 'fld-other'],
] as const) {
  test(`${mode}: creates the file through the relay`, async () => {
    const { ctx, provider, calls } = throughRelay();
    const payload = new TextEncoder().encode(`${mode} bytes`);
    const containerId = folderContainerId('fa-files', folderId);

    const result = ok(
      await provider.uploadFile(
        ctx,
        { mode, projectId: 'p1', containerId, fileName: `${mode}.ifc` },
        payload.buffer as ArrayBuffer,
      ),
    );

    assert.ok(calls.every((call) => call.status < 400), JSON.stringify(calls.filter((c) => c.status >= 400)));
    assert.equal(result.file.name, `${mode}.ifc`);
    const stored = await download(provider, ctx, {
      projectId: 'p1',
      containerId,
      fileId: result.file.id,
      revisionId: result.revision.id,
    });
    assertSameBytes(stored, payload);
  });
}
