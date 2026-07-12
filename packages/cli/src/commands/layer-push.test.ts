/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blake3Digest } from '@ifc-lite/ifcx';
import { loadEvidence, type LayerStore } from './layer-store.js';
import { parseCheckEvidence, publishLayer } from './layer-publish.js';
import { PushPolicyError, pushToRegistry, registryApiBase } from './layer-push.js';
import { FIRE, makeDelta, setupMain, tmpStore } from './layer-test-helpers.js';

interface Recorded {
  method: string;
  path: string;
  body: string;
  auth?: string;
}

/** Minimal registry stub: records requests, replies per configured rule. */
function stubRegistry(rules: { refStatus?: number } = {}) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const record: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      const auth = req.headers.authorization;
      if (typeof auth === 'string') record.auth = auth;
      requests.push(record);
      const refPut = record.method === 'PUT' && record.path.startsWith('/api/v1/refs/');
      const status = refPut ? rules.refStatus ?? 201 : 201;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status < 300 ? { ok: true } : { error: 'protected ref' }));
    });
  });
  return new Promise<{ base: string; requests: Recorded[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function publishWithEvidence(store: LayerStore): { layerId: string; digests: string[] } {
  const specPath = join(store.dir, 'fire-safety.ids');
  const reportPath = join(store.dir, 'report.json');
  const spec = '<ids/>';
  const report = JSON.stringify({ summary: { failedSpecifications: 0 } });
  writeFileSync(specPath, spec, 'utf-8');
  writeFileSync(reportPath, report, 'utf-8');
  const result = publishLayer(store, {
    delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]),
    baseRef: 'main',
    intent: 'Bump fire rating',
    principal: 'alice',
    checks: parseCheckEvidence([`${specPath}=${reportPath}`], store),
  });
  return { layerId: result.layerId, digests: [blake3Digest(spec), blake3Digest(report)] };
}

describe('registryApiBase', () => {
  it('normalizes ws/http bases onto /api/v1', () => {
    expect(registryApiBase('http://reg.example')).toBe('http://reg.example/api/v1');
    expect(registryApiBase('https://reg.example/')).toBe('https://reg.example/api/v1');
    expect(registryApiBase('wss://reg.example')).toBe('https://reg.example/api/v1');
    expect(registryApiBase('http://reg.example/api/v1')).toBe('http://reg.example/api/v1');
  });
});

describe('evidence store', () => {
  it('parseCheckEvidence persists both files so push can upload them', () => {
    const store = tmpStore();
    setupMain(store);
    const { digests } = publishWithEvidence(store);
    expect(loadEvidence(store, digests[0])).toBe('<ids/>');
    expect(JSON.parse(loadEvidence(store, digests[1]) ?? '')).toEqual({
      summary: { failedSpecifications: 0 },
    });
    expect(loadEvidence(store, `blake3:${'0'.repeat(64)}`)).toBeUndefined();
    // Digests are foreign manifest data: traversal shapes never reach the fs.
    writeFileSync(join(store.dir, 'secret.txt'), 'do-not-exfiltrate', 'utf-8');
    expect(loadEvidence(store, '../secret.txt')).toBeUndefined();
    expect(loadEvidence(store, 'blake3:../secret.txt')).toBeUndefined();
  });
});

describe('layer push', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('pushes a ref stack with its evidence, carrying the bearer token', async () => {
    const store = tmpStore();
    const baseId = setupMain(store);
    const { layerId, digests } = publishWithEvidence(store);
    const registry = await stubRegistry();
    close = registry.close;

    const summary = await pushToRegistry(
      store,
      'main',
      { base: registryApiBase(registry.base), token: 'secret-token' },
      false
    );
    // 'main' still points at the base only; the candidate is unpushed.
    expect(summary.layers).toEqual([baseId]);
    expect(summary.evidenceMissing).toEqual([]);

    const single = await pushToRegistry(
      store,
      layerId,
      { base: registryApiBase(registry.base), token: 'secret-token' },
      false
    );
    expect(single.layers).toEqual([layerId]);
    expect(single.evidenceUploaded).toEqual(digests);

    const layerPosts = registry.requests.filter((r) => r.path === '/api/v1/layers');
    expect(layerPosts.map((r) => (JSON.parse(r.body) as { header: { id: string } }).header.id)).toEqual([
      baseId,
      layerId,
    ]);
    const evidencePuts = registry.requests.filter((r) => r.path.startsWith('/api/v1/reports/'));
    expect(evidencePuts).toHaveLength(2);
    expect(evidencePuts.map((r) => decodeURIComponent(r.path.split('/').pop() ?? ''))).toEqual(digests);
    expect(new Set(registry.requests.map((r) => r.auth))).toEqual(new Set(['Bearer secret-token']));
  });

  it('reports missing local evidence instead of failing the push', async () => {
    const store = tmpStore();
    setupMain(store);
    const specPath = join(store.dir, 's.ids');
    const reportPath = join(store.dir, 'r.json');
    writeFileSync(specPath, '<ids/>', 'utf-8');
    writeFileSync(reportPath, JSON.stringify({ summary: { failedSpecifications: 0 } }), 'utf-8');
    // No store passed: digests land in the manifest, bytes are not kept.
    const { layerId } = publishLayer(store, {
      delta: makeDelta([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]),
      baseRef: 'main',
      intent: 'No local evidence',
      principal: 'alice',
      checks: parseCheckEvidence([`${specPath}=${reportPath}`]),
    });
    const registry = await stubRegistry();
    close = registry.close;

    const summary = await pushToRegistry(store, layerId, { base: registryApiBase(registry.base) }, false);
    expect(summary.evidenceUploaded).toEqual([]);
    expect(summary.evidenceMissing).toHaveLength(2);
    expect(registry.requests.filter((r) => r.path.startsWith('/api/v1/reports/'))).toHaveLength(0);
  });

  it('maps a protected-ref refusal onto the policy error (exit 3)', async () => {
    const store = tmpStore();
    setupMain(store);
    const registry = await stubRegistry({ refStatus: 409 });
    close = registry.close;

    await expect(
      pushToRegistry(store, 'main', { base: registryApiBase(registry.base) }, true)
    ).rejects.toBeInstanceOf(PushPolicyError);
    // And --set-ref on a non-ref side is refused before any ref call.
    const { layerId } = publishWithEvidence(store);
    await expect(
      pushToRegistry(store, layerId, { base: registryApiBase(registry.base) }, true)
    ).rejects.toThrowError(/--set-ref requires pushing a ref/);
  });
});
