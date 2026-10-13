/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelUpload } from '@ifc-lite/report-contract';
import { ReportClient } from './client';
import { checksum, uploadModel } from './upload';

test('#7495 resumed upload checks original bytes and transfers only missing bounded parts', async () => {
  const file = new File(['abcdefghij'], 'private-project.ifc');
  const firstChecksum = await checksum(await file.slice(0, 4).arrayBuffer());
  const remote: ModelUpload = { id: 'upload', status: 'uploading', partBytes: 4, partCount: 3, uploadedParts: [{ partNumber: 1, size: 4, etag: 'etag', sha256: firstChecksum }] };
  const requests: Array<{ path: string; method?: string; body?: BodyInit | null }> = [];
  const sent: number[] = [];
  const transport: typeof fetch = async (input, options) => {
    const path = String(input); requests.push({ path, method: options?.method, body: options?.body });
    if (options?.method === 'PUT') { sent.push((options.body as ArrayBuffer).byteLength); assert.equal(options.credentials, 'omit'); return new Response('', { status: 200 }); }
    if (path.endsWith('/parts')) return Response.json({ url: 'https://models.example.test/part', expiresAt: 'later' });
    if (path.endsWith('/complete')) return Response.json({ status: 'ready' });
    return Response.json(remote);
  };
  const progress: number[] = [];
  await uploadModel(new ReportClient(transport), 'report', remote, file, new AbortController().signal, done => progress.push(done));
  assert.deepEqual(sent, [4, 2]);
  assert.deepEqual(progress, [4, 8, 10]);
  assert.equal(requests.filter(row => row.path.endsWith('/parts')).length, 2);
  assert.ok(requests.at(-1)?.path.endsWith('/complete'));
});

test('#7495 a same-sized different model cannot resume an existing upload', async () => {
  const remote: ModelUpload = { id: 'upload', status: 'uploading', partBytes: 4, partCount: 1, uploadedParts: [{ partNumber: 1, size: 4, etag: 'etag', sha256: await checksum(new TextEncoder().encode('real').buffer) }] };
  let writes = 0, reads = 0;
  const transport: typeof fetch = async (_input, options) => { if (options?.method !== 'GET') writes++; return Response.json({ ...remote, status: ++reads > 1 ? 'ready' : remote.status }); };
  await assert.rejects(uploadModel(new ReportClient(transport), 'report', remote, new File(['fake'], 'same.ifc'), new AbortController().signal, () => {}), /differs/);
  assert.equal(writes, 0);
});

test('#7495 abort never requests another part or finalization', async () => {
  const controller = new AbortController(); controller.abort();
  const remote: ModelUpload = { id: 'upload', status: 'uploading', partBytes: 4, partCount: 1, uploadedParts: [] };
  const methods: string[] = [];
  const transport: typeof fetch = async (_input, options) => { methods.push(options?.method ?? 'GET'); return Response.json(remote); };
  await assert.rejects(uploadModel(new ReportClient(transport), 'report', remote, new File(['real'], 'real.ifc'), controller.signal, () => {}), { name: 'AbortError' });
  assert.deepEqual(methods, ['GET']);
});

test('#7495 resumed verification waits for server-confirmed ready without sending model bytes again', async () => {
  let reads = 0;
  const remote: ModelUpload = { id: 'upload', status: 'verifying', partBytes: 4, partCount: 1, uploadedParts: [], sourceParts: [{ partNumber: 1, size: 4, sha256: await checksum(new TextEncoder().encode('real').buffer) }] };
  const transport: typeof fetch = async (_input, options) => {
    assert.equal(options?.method, 'GET');
    reads++;
    return Response.json({ ...remote, status: reads > 1 ? 'ready' : 'verifying' });
  };
  await uploadModel(new ReportClient(transport), 'report', remote, new File(['real'], 'real.ifc'), new AbortController().signal, () => {});
  assert.equal(reads, 2);
});

for (const status of ['ready', 'verifying'] as const) test(`#7495 ${status} retry rejects a reselected revision with the same name and size`, async () => {
  const remote: ModelUpload = { id: 'upload', status, partBytes: 4, partCount: 1, uploadedParts: [], sourceParts: [{ partNumber: 1, size: 4, sha256: await checksum(new TextEncoder().encode('real').buffer) }] };
  let writes = 0, reads = 0;
  const transport: typeof fetch = async (_input, options) => { if (options?.method !== 'GET') writes++; return Response.json({ ...remote, status: ++reads > 1 ? 'ready' : remote.status }); };
  await assert.rejects(uploadModel(new ReportClient(transport), 'report', remote, new File(['fake'], 'same.ifc'), new AbortController().signal, () => {}), /differs/);
  assert.equal(writes, 0);
});
