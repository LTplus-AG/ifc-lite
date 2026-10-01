/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadToCesiumIon, IonUploadError, type IonUploadInput, type IonS3Request } from './cesium-ion-upload';

const response = () => ({
  assetMetadata: { id: 42 },
  uploadLocation: {
    bucket: 'assets.ion.cesium.com', prefix: 'sources/42/', endpoint: 'https://assets.ion.cesium.com',
    accessKey: 'temporary-access', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session',
  },
  onComplete: { method: 'POST', url: 'https://api.cesium.com/v1/assets/42/uploadComplete', fields: { verify: true } },
});
const input = (signal = new AbortController().signal): IonUploadInput => ({
  token: 'private-write-token', name: 'Building', fileName: 'building.ifc', bytes: new Uint8Array([1, 2, 3]), signal,
});

test('ion follows returned completion fields and sends source bytes only to S3 (#6587)', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const uploads: IonS3Request[] = [];
  const phases: string[] = [];
  await uploadToCesiumIon({ ...input(), onPhase: phase => phases.push(phase) }, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options: options ?? {} });
      return requests.length === 1 ? Response.json(response()) : new Response(null, { status: 204 });
    },
    putObject: async req => { uploads.push(req); },
  });
  assert.deepEqual(phases, ['create', 'upload', 'complete']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.cesium.com/v1/assets');
  const createBody: unknown = JSON.parse(String(requests[0].options.body));
  assert.deepEqual(createBody, { name: 'Building', type: '3DTILES', options: { sourceType: 'BIM_CAD' } });
  assert.equal(requests[1].url, response().onComplete.url);
  assert.deepEqual(JSON.parse(String(requests[1].options.body)), { verify: true });
  assert.equal(new Headers(requests[1].options.headers).get('Authorization'), 'Bearer private-write-token');
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].key, 'sources/42/building.ifc');
  assert.deepEqual(uploads[0].bytes, input().bytes);
  assert.equal(uploads[0].location.accessKey, 'temporary-access');
  assert.ok(!JSON.stringify(uploads[0]).includes('private-write-token'));
});

for (const part of ['assetMetadata', 'uploadLocation', 'onComplete'] as const) {
  test(`ion rejects missing ${part} without uploading (#6587)`, async () => {
    const malformed: Record<string, unknown> = response();
    delete malformed[part];
    let uploaded = false;
    await assert.rejects(uploadToCesiumIon(input(), {
      fetchImpl: async () => Response.json(malformed),
      putObject: async () => { uploaded = true; },
    }), IonUploadError);
    assert.equal(uploaded, false);
  });
}

test('ion never forwards bearer credentials to an unexpected completion origin (#6587)', async () => {
  const malicious = response();
  malicious.onComplete.url = 'https://example.com/v1/assets/42/uploadComplete';
  let requests = 0;
  await assert.rejects(uploadToCesiumIon(input(), {
    fetchImpl: async () => { requests++; return Response.json(malicious); },
    putObject: async () => assert.fail('must not upload'),
  }), (error: unknown) => error instanceof IonUploadError && error.assetId === 42);
  assert.equal(requests, 1);
});

test('ion cancellation stops completion and keeps the created asset identity (#6587)', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(uploadToCesiumIon(input(controller.signal), {
    fetchImpl: async () => { requests++; return Response.json(response()); },
    putObject: async req => { assert.equal(req.signal, controller.signal); controller.abort(); },
  }), (error: unknown) => error instanceof IonUploadError && error.assetId === 42);
  assert.equal(requests, 1);
});

for (const step of ['upload', 'complete'] as const) {
  test(`ion ${step} failure preserves asset and excludes raw credential-bearing errors (#6587)`, async () => {
    let requests = 0;
    await assert.rejects(uploadToCesiumIon(input(), {
      fetchImpl: async () => ++requests === 1 ? Response.json(response())
        : new Response('private-write-token', { status: 403 }),
      putObject: async () => { if (step === 'upload') throw new Error('temporary-secret'); },
    }), (error: unknown) => error instanceof IonUploadError && error.assetId === 42
      && error.phase === step && !error.message.includes('token') && !error.message.includes('secret'));
  });
}

test('invalid upload filenames do not create assets (#6587)', async () => {
  for (const fileName of ['../model.ifc', 'folder/model.ifc', 'model.ifcx', 'model\\name.ifc']) {
    await assert.rejects(uploadToCesiumIon({ ...input(), fileName }, {
      fetchImpl: async () => assert.fail('must not create asset'),
    }), IonUploadError);
  }
});
