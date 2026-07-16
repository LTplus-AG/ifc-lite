/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Check-evidence blobs on the registry (08-review.md §8.4): the IDS
 * spec/report files behind a manifest check's `specDigest`/`report`
 * digests become fetchable — digest-verified on write, immutable,
 * durable on the fs store, 501 on stores that predate evidence.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blake3Digest } from '@ifc-lite/ifcx';
import { startCollabServer, type CollabServerHandle } from '../src/index.js';
import { FsLayerRegistry } from '../src/layer-registry-fs.js';
import { MemoryLayerRegistry, type LayerRegistryStore } from '../src/layer-registry.js';

const REPORT = JSON.stringify({
  summary: { totalSpecifications: 1, failedSpecifications: 1 },
  report: { specificationResults: [] },
});
const DIGEST = blake3Digest(REPORT);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-lite-reports-'));
}

describe('report stores', () => {
  it('verifies the digest on write and round-trips, in memory and on disk', () => {
    for (const store of [new MemoryLayerRegistry(), new FsLayerRegistry(tmpDir())]) {
      const id = store.putReport(DIGEST, Buffer.from(REPORT, 'utf-8'));
      expect(id).toBe(DIGEST);
      expect(new TextDecoder().decode(store.getReport(DIGEST))).toBe(REPORT);
      // Idempotent re-put; wrong bytes for a digest are refused.
      expect(store.putReport(DIGEST, Buffer.from(REPORT, 'utf-8'))).toBe(DIGEST);
      expect(() => store.putReport(DIGEST, Buffer.from('{}', 'utf-8'))).toThrowError(/do not hash/);
      expect(() => store.putReport('blake3:00ff', Buffer.from(REPORT))).toThrowError(/unsupported content-address/);
      expect(store.getReport(`blake3:${'0'.repeat(64)}`)).toBeUndefined();
      expect(store.getReport('../../etc/passwd')).toBeUndefined();
    }
  });

  it('caps reports and survives a restart on the fs store', () => {
    const dir = tmpDir();
    const store = new FsLayerRegistry(dir, { maxReports: 1 });
    store.putReport(DIGEST, Buffer.from(REPORT, 'utf-8'));
    const other = 'other evidence';
    expect(() => store.putReport(blake3Digest(other), Buffer.from(other))).toThrowError(/cap/);
    // Re-put of existing evidence still succeeds at the cap.
    expect(store.putReport(DIGEST, Buffer.from(REPORT, 'utf-8'))).toBe(DIGEST);
    const reopened = new FsLayerRegistry(dir, { maxReports: 1 });
    expect(new TextDecoder().decode(reopened.getReport(DIGEST))).toBe(REPORT);
    expect(() => reopened.putReport(blake3Digest(other), Buffer.from(other))).toThrowError(/cap/);
  });
});

describe('reports route', () => {
  let handle: CollabServerHandle;
  let api: string;

  beforeAll(async () => {
    handle = await startCollabServer({ port: 0, layerRegistry: true });
    const port = (handle.httpServer.address() as { port: number }).port;
    api = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await handle.stop();
  });

  it('PUTs digest-verified evidence and GETs it back', async () => {
    const put = await fetch(`${api}/reports/${DIGEST}`, { method: 'PUT', body: REPORT });
    expect(put.status).toBe(201);
    expect(((await put.json()) as { digest: string }).digest).toBe(DIGEST);

    const got = await fetch(`${api}/reports/${DIGEST}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('x-report-digest')).toBe(DIGEST);
    expect(await got.text()).toBe(REPORT);

    // The bare-hex form works like the layers route.
    const bare = await fetch(`${api}/reports/${DIGEST.slice('blake3:'.length)}`);
    expect(bare.status).toBe(200);
  });

  it('refuses tampered bytes and unknown digests', async () => {
    const tampered = await fetch(`${api}/reports/${DIGEST}`, { method: 'PUT', body: '{"forged":true}' });
    expect(tampered.status).toBe(409);
    expect(((await tampered.json()) as { code: string }).code).toBe('id-mismatch');
    expect((await fetch(`${api}/reports/blake3:${'0'.repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${api}/reports/not-a-digest`, { method: 'PUT', body: 'x' })).status).toBe(409);
    expect((await fetch(`${api}/reports`, { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('answers 501 on a store without evidence support', async () => {
    const bare: LayerRegistryStore = new MemoryLayerRegistry();
    delete (bare as { putReport?: unknown }).putReport;
    delete (bare as { getReport?: unknown }).getReport;
    // Methods live on the prototype; shadow them off for this instance.
    Object.defineProperty(bare, 'putReport', { value: undefined });
    Object.defineProperty(bare, 'getReport', { value: undefined });
    const legacy = await startCollabServer({ port: 0, layerRegistry: { store: bare } });
    const port = (legacy.httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/v1`;
    try {
      expect((await fetch(`${base}/reports/${DIGEST}`, { method: 'PUT', body: REPORT })).status).toBe(501);
      expect((await fetch(`${base}/reports/${DIGEST}`)).status).toBe(501);
    } finally {
      await legacy.stop();
    }
  });
});
