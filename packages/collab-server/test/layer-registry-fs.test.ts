/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Disk-backed layer registry: the same integrity gates as the memory
 * store, plus what it exists for — layers, refs (with policies), and
 * reviews (with recorded approvals) surviving a process restart, both
 * directly and end to end over HTTP through a server bounce.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceBase } from '@ifc-lite/ifcx';
import { startCollabServer, type CollabServerHandle } from '../src/index.js';
import { FsLayerRegistry } from '../src/layer-registry-fs.js';
import type { RegistryReview } from '../src/layer-registry.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const CLASS = 'bsi::ifc::class';

function publishable(
  nodes: IfcxNode[],
  intent: string,
  base: ProvenanceBase | null,
  kind: 'human' | 'agent' = 'human',
  principal?: string
): IfcxFile {
  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-06-10T00:00:00.000Z',
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
  const manifest = createProvenanceManifest({
    author: { kind, principal: principal ?? (kind === 'agent' ? 'bot-7' : 'alice') },
    intent,
    base,
    created: '2026-06-10T00:00:00.000Z',
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-lite-registry-'));
}

const review = (id: string): RegistryReview => ({
  id,
  layerId: 'blake3:00',
  into: 'main',
  reviewers: [],
  status: 'open',
  feedback: [],
  openedAt: '2026-06-10T00:00:00.000Z',
});

describe('FsLayerRegistry', () => {
  it('pushes, lists, and loads layers through the disk round-trip', () => {
    const registry = new FsLayerRegistry(tmpDir());
    const layer = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
      'Import base model',
      null
    );
    const id = registry.push(layer);
    expect(id).toBe(layer.header.id);
    expect(registry.hasLayer(id)).toBe(true);
    expect(registry.listLayers()).toEqual([id]);
    const loaded = registry.loadLayer(id);
    expect(loaded).toEqual(layer);
    // Disk round-trip means callers get isolated copies.
    loaded.data[0].attributes![FIRE] = 'REI30';
    expect(registry.loadLayer(id).data[0].attributes![FIRE]).toBe('REI60');
    expect(() => registry.loadLayer('blake3:00ff')).toThrowError(/No layer/);
    expect(registry.hasLayer('../../etc/passwd')).toBe(false);
    expect(() => registry.loadLayer('../../etc/passwd')).toThrowError(/No layer/);
  });

  it('keeps the integrity gates: id-mismatch and first-write-wins', () => {
    const registry = new FsLayerRegistry(tmpDir());
    const layer = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
      'First write',
      null
    );
    const id = registry.push(layer);
    // Tampered content under the original id is refused.
    const tampered: IfcxFile = {
      ...layer,
      data: [...layer.data, { path: 'wall-1', attributes: { [FIRE]: 'REI30' } }],
    };
    expect(() => registry.push(tampered)).toThrowError(/does not match/);
    // Byte-identical re-push is idempotent.
    expect(registry.push(structuredClone(layer))).toBe(id);
    // Same canonical bytes, different stored bytes (derived content is
    // excluded from the id): refused, first write wins.
    const derived = structuredClone(layer);
    derived.data[0].attributes!['ifclite::derived::bbox'] = [0, 0, 0, 1, 1, 1];
    expect(computeLayerId(derived)).toBe(id);
    expect(() => registry.push(derived)).toThrowError(/different non-canonical bytes/);
    expect(registry.loadLayer(id).data[0].attributes!['ifclite::derived::bbox']).toBeUndefined();
  });

  it('survives a restart: layers, refs with policy, and reviews rehydrate', () => {
    const dir = tmpDir();
    const first = new FsLayerRegistry(dir);
    const layer = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
      'Durable',
      null
    );
    const id = first.push(layer);
    first.setRef('main', { layers: [id], policy: { requiredChecks: ['fire.ids'] } });
    first.putReview({ ...review('11111111-2222-4333-8444-555555555555'), approvedBy: 'bob' });

    const reopened = new FsLayerRegistry(dir);
    expect(reopened.listLayers()).toEqual([id]);
    expect(reopened.loadLayer(id)).toEqual(layer);
    expect(reopened.getRef('main')).toEqual({
      layers: [id],
      policy: { requiredChecks: ['fire.ids'] },
    });
    expect(reopened.getReview('11111111-2222-4333-8444-555555555555')?.approvedBy).toBe('bob');
    expect(reopened.listReviews()).toHaveLength(1);
  });

  it('enforces the same caps as the memory store, counting persisted state', () => {
    const dir = tmpDir();
    const registry = new FsLayerRegistry(dir, { maxLayers: 1, maxRefs: 1, maxReviews: 1 });
    const one = publishable([{ path: 'a', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }], 'One', null);
    const two = publishable([{ path: 'b', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }], 'Two', null);
    registry.push(one);
    expect(() => registry.push(two)).toThrowError(/registry-full|cap/);
    // Idempotent re-push of an existing layer still succeeds at the cap.
    expect(registry.push(structuredClone(one))).toBe(one.header.id);
    registry.setRef('main', { layers: [one.header.id] });
    expect(() => registry.setRef('other', { layers: [] })).toThrowError(/cap/);
    // Updating an existing ref is not a new ref.
    registry.setRef('main', { layers: [] });
    registry.putReview(review('11111111-2222-4333-8444-555555555555'));
    expect(() => registry.putReview(review('21111111-2222-4333-8444-555555555555'))).toThrowError(/cap/);
    // The caps survive a restart too: persisted layers count against them.
    const reopened = new FsLayerRegistry(dir, { maxLayers: 1 });
    expect(() => reopened.push(two)).toThrowError(/cap/);
  });

  it('refuses filename-unsafe review ids', () => {
    const registry = new FsLayerRegistry(tmpDir());
    expect(() => registry.putReview(review('../evil'))).toThrowError(/not filename-safe/);
    expect(() => registry.putReview(review(''))).toThrowError(/not filename-safe/);
  });

  it('fails closed on corrupt persisted state instead of starting empty', () => {
    const dir = tmpDir();
    const registry = new FsLayerRegistry(dir);
    registry.setRef('main', { layers: [], policy: { requiredChecks: ['fire.ids'] } });
    fs.writeFileSync(path.join(dir, 'layer-registry', 'refs.json'), '{corrupt');
    // A registry that silently dropped this ref would also drop its policy —
    // the exact gate the store exists to persist.
    expect(() => new FsLayerRegistry(dir)).toThrowError();

    const dir2 = tmpDir();
    new FsLayerRegistry(dir2).putReview(review('11111111-2222-4333-8444-555555555555'));
    fs.writeFileSync(
      path.join(dir2, 'layer-registry', 'reviews', '11111111-2222-4333-8444-555555555555.json'),
      '{corrupt'
    );
    expect(() => new FsLayerRegistry(dir2)).toThrowError();
  });

  it('ignores leftover temp files from interrupted writes', () => {
    const dir = tmpDir();
    const registry = new FsLayerRegistry(dir);
    const layer = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
      'Real',
      null
    );
    registry.push(layer);
    const layersDir = path.join(dir, 'layer-registry', 'layers');
    fs.writeFileSync(path.join(layersDir, `${'0'.repeat(64)}.json.tmp-dead`), 'torn');
    fs.writeFileSync(path.join(dir, 'layer-registry', 'reviews', 'x.json.tmp-dead'), 'torn');
    const reopened = new FsLayerRegistry(dir);
    expect(reopened.listLayers()).toEqual([layer.header.id]);
    expect(reopened.listReviews()).toEqual([]);
  });
});

describe('fs registry over HTTP across a server bounce', () => {
  const dir = tmpDir();
  let handle: CollabServerHandle;
  let api: string;

  const start = async () => {
    handle = await startCollabServer({
      port: 0,
      layerRegistry: { store: new FsLayerRegistry(dir) },
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    api = `http://127.0.0.1:${port}/api/v1`;
  };

  beforeAll(start);
  afterAll(async () => {
    await handle.stop();
  });

  it('serves pushed layers, merged refs, and reviews after a restart', async () => {
    const base = publishable(
      [
        { path: 'storey', children: { Wall: 'wall-1' } },
        { path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } },
      ],
      'Import base model',
      null
    );
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
      'Bump fire rating',
      { kind: 'stack', id: computeStackHash([base.header.id]) }
    );

    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(base) })).status).toBe(201);
    expect(
      (await fetch(`${api}/refs/main`, { method: 'PUT', body: JSON.stringify({ layers: [base.header.id] }) })).status
    ).toBe(201);
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(candidate) })).status).toBe(201);
    const merged = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({ candidate: candidate.header.id }),
    });
    expect(merged.status).toBe(200);
    expect(((await merged.json()) as { status: string }).status).toBe('fast-forward');
    const opened = await fetch(`${api}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ layer_id: candidate.header.id, into: 'main' }),
    });
    expect(opened.status).toBe(201);
    const reviewId = ((await opened.json()) as { id: string }).id;

    // Bounce the process: a fresh store instance over the same volume.
    await handle.stop();
    await start();

    const pulled = await fetch(`${api}/layers/${base.header.id}`);
    expect(pulled.status).toBe(200);
    expect(((await pulled.json()) as IfcxFile).header.id).toBe(base.header.id);
    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(ref.layers).toEqual([base.header.id, candidate.header.id]);
    const reviewBack = await fetch(`${api}/reviews/${reviewId}`);
    expect(reviewBack.status).toBe(200);
    expect(((await reviewBack.json()) as { into: string }).into).toBe('main');
  });
});
