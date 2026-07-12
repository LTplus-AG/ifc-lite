/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review comments as BCF topics (08-review.md §8.6): topics bind to
 * (review, entity, componentKey?), follow the named-reviewers write gate,
 * validate their shape, and survive a restart on the fs store.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeLayerId, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { startCollabServer, type CollabServerHandle } from '../src/index.js';
import { FsLayerRegistry } from '../src/layer-registry-fs.js';
import type { RegistryReviewTopic } from '../src/layer-registry.js';

function publishable(intent: string): IfcxFile {
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
    data: [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' } } }],
  };
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base: null,
    created: '2026-06-10T00:00:00.000Z',
  });
  const withManifest = setProvenance(bare, manifest);
  return { ...withManifest, header: { ...withManifest.header, id: computeLayerId(withManifest) } };
}

describe('review topics route', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-lite-topics-'));
  let handle: CollabServerHandle;
  let api: string;
  let reviewId = '';

  beforeAll(async () => {
    handle = await startCollabServer({ port: 0, layerRegistry: { store: new FsLayerRegistry(dir) } });
    const port = (handle.httpServer.address() as { port: number }).port;
    api = `http://127.0.0.1:${port}/api/v1`;

    const layer = publishable('Candidate');
    await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(layer) });
    await fetch(`${api}/refs/main`, { method: 'PUT', body: JSON.stringify({ layers: [layer.header.id] }) });
    const opened = await fetch(`${api}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ layer_id: layer.header.id, into: 'main' }),
    });
    reviewId = ((await opened.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await handle.stop();
  });

  it('binds a BCF topic to (review, entity, componentKey) and lists it back', async () => {
    const created = await fetch(`${api}/reviews/${reviewId}/topics`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Fire rating too low on this wall',
        description: 'REI90 does not satisfy the zone requirement.',
        entity: 'wall-1',
        component_key: 'pset:Pset_FireSafety',
        viewpoint: { camera: { position: [1, 2, 3], target: [0, 0, 0] } },
      }),
    });
    expect(created.status).toBe(201);
    const { guid } = (await created.json()) as { guid: string };
    expect(guid).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await fetch(`${api}/reviews/${reviewId}/topics`);
    expect(listed.status).toBe(200);
    const { topics } = (await listed.json()) as { topics: RegistryReviewTopic[] };
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      guid,
      title: 'Fire rating too low on this wall',
      entity: 'wall-1',
      componentKey: 'pset:Pset_FireSafety',
    });
    expect(topics[0].createdAt).toBeTruthy();
    expect(topics[0].viewpoint).toEqual({ camera: { position: [1, 2, 3], target: [0, 0, 0] } });

    // The topic also rides the full review object (agents read it there).
    const review = (await (await fetch(`${api}/reviews/${reviewId}`)).json()) as {
      topics?: RegistryReviewTopic[];
    };
    expect(review.topics).toHaveLength(1);
  });

  it('rejects malformed topics and unknown reviews', async () => {
    const noTitle = await fetch(`${api}/reviews/${reviewId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ entity: 'wall-1' }),
    });
    expect(noTitle.status).toBe(400);
    const blankTitle = await fetch(`${api}/reviews/${reviewId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ title: '  ', entity: 'wall-1' }),
    });
    expect(blankTitle.status).toBe(400);
    const badViewpoint = await fetch(`${api}/reviews/${reviewId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ title: 'x', entity: 'wall-1', viewpoint: [1] }),
    });
    expect(badViewpoint.status).toBe(400);
    expect((await fetch(`${api}/reviews/00000000-0000-4000-8000-000000000000/topics`)).status).toBe(404);
    expect(
      (await fetch(`${api}/reviews/${reviewId}/topics`, { method: 'DELETE' })).status
    ).toBe(405);
  });

  it('persists topics across a registry restart', async () => {
    const reopened = new FsLayerRegistry(dir);
    const review = reopened.getReview(reviewId);
    expect(review?.topics?.length).toBe(1);
    expect(review?.topics?.[0].title).toBe('Fire rating too low on this wall');
  });
});

describe('review topics reviewer gate', () => {
  it('only named reviewers may post topics', async () => {
    const handle = await startCollabServer({
      port: 0,
      layerRegistry: true,
      // Identity = the bearer token itself, so tests can act as different
      // principals without a real auth provider.
      authenticate: (token) => (token ? { userId: token, role: 'editor' } : null),
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const api = `http://127.0.0.1:${port}/api/v1`;
    const as = (token: string, path2: string, init?: RequestInit) =>
      fetch(`${api}${path2}`, { ...init, headers: { authorization: `Bearer ${token}` } });
    try {
      const layer = publishable('Gate candidate');
      // alice authors + pushes (author binding requires matching principal).
      expect((await as('alice', '/layers', { method: 'POST', body: JSON.stringify(layer) })).status).toBe(201);
      await as('alice', '/refs/main', { method: 'PUT', body: JSON.stringify({ layers: [layer.header.id] }) });
      const opened = await as('alice', '/reviews', {
        method: 'POST',
        body: JSON.stringify({ layer_id: layer.header.id, into: 'main', reviewers: ['bob'] }),
      });
      const { id } = (await opened.json()) as { id: string };

      const outsider = await as('mallory', `/reviews/${id}/topics`, {
        method: 'POST',
        body: JSON.stringify({ title: 'drive-by comment', entity: 'wall-1' }),
      });
      expect(outsider.status).toBe(403);

      const reviewer = await as('bob', `/reviews/${id}/topics`, {
        method: 'POST',
        body: JSON.stringify({ title: 'legit comment', entity: 'wall-1' }),
      });
      expect(reviewer.status).toBe(201);
      const listed = (await (await as('mallory', `/reviews/${id}/topics`)).json()) as {
        topics: RegistryReviewTopic[];
      };
      expect(listed.topics).toHaveLength(1);
      expect(listed.topics[0].author).toBe('bob');
    } finally {
      await handle.stop();
    }
  });
});
