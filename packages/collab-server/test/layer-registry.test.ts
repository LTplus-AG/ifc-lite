/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer-registry route end to end over real HTTP: push with the
 * server-side integrity gate, pull by id, refs with policy-protected
 * moves, the shared merge flow (fast-forward, conflicts, policy
 * enforcement, unrelated-base refusal), and review objects.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceBase } from '@ifc-lite/ifcx';
import { startCollabServer, type CollabServerHandle } from '../src/index.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const CLASS = 'bsi::ifc::class';

function publishable(
  nodes: IfcxNode[],
  intent: string,
  base: ProvenanceBase | null,
  kind: 'human' | 'agent' = 'human'
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
    author: { kind, principal: kind === 'agent' ? 'bot-7' : 'alice' },
    intent,
    base,
    created: '2026-06-10T00:00:00.000Z',
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

describe('layer registry route', () => {
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

  async function push(file: IfcxFile): Promise<Response> {
    return fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(file) });
  }

  const baseLayer = publishable(
    [
      { path: 'storey', children: { Wall: 'wall-1' } },
      { path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } },
    ],
    'Import base model',
    null
  );

  it('pushes with the integrity gate and pulls by id', async () => {
    const created = await push(baseLayer);
    expect(created.status).toBe(201);
    expect(((await created.json()) as { id: string }).id).toBe(baseLayer.header.id);

    // Tampered content under the original id is rejected at the door.
    const tampered: IfcxFile = {
      ...baseLayer,
      data: [...baseLayer.data, { path: 'wall-1', attributes: { [FIRE]: 'REI30' } }],
    };
    const rejected = await push(tampered);
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { code: string }).code).toBe('id-mismatch');

    const pulled = await fetch(`${api}/layers/${baseLayer.header.id}`);
    expect(pulled.status).toBe(200);
    expect(((await pulled.json()) as IfcxFile).header.id).toBe(baseLayer.header.id);
    expect((await fetch(`${api}/layers/blake3:00ff`)).status).toBe(404);
  });

  it('creates refs, fast-forwards through merge, and reads back the stack', async () => {
    const put = await fetch(`${api}/refs/main`, {
      method: 'PUT',
      body: JSON.stringify({ layers: [baseLayer.header.id] }),
    });
    expect(put.status).toBe(201);

    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
      'Bump fire rating',
      { kind: 'stack', id: computeStackHash([baseLayer.header.id]) }
    );
    expect((await push(candidate)).status).toBe(201);

    const merged = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({ candidate: candidate.header.id }),
    });
    expect(merged.status).toBe(200);
    const outcome = (await merged.json()) as { status: string; layers: string[] };
    expect(outcome.status).toBe('fast-forward');
    expect(outcome.layers).toEqual([baseLayer.header.id, candidate.header.id]);

    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(ref.layers).toHaveLength(2);
  });

  it('enforces policy server-side: protected moves and required checks', async () => {
    const protect = await fetch(`${api}/refs/main`, {
      method: 'PUT',
      body: JSON.stringify({ policy: { requiredChecks: ['fire-safety.ids'] } }),
    });
    expect(protect.status).toBe(200);

    // Policy-protected refs cannot be force-moved by PUT.
    const forced = await fetch(`${api}/refs/main`, {
      method: 'PUT',
      body: JSON.stringify({ layers: [baseLayer.header.id] }),
    });
    expect(forced.status).toBe(409);

    // A candidate without passing check evidence is blocked at merge.
    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    const unchecked = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }],
      'No evidence attached',
      { kind: 'stack', id: computeStackHash(ref.layers) }
    );
    expect((await push(unchecked)).status).toBe(201);
    const blocked = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({ candidate: unchecked.header.id }),
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { reason: string }).reason).toContain('fire-safety.ids');

    // Waiving the check (with a reason) lets it through.
    const waived = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({
        candidate: unchecked.header.id,
        waivers: [{ spec: 'fire-safety.ids', reason: 'spec not applicable to walls' }],
      }),
    });
    expect(waived.status).toBe(200);
  });

  it('surfaces conflicts as 409 and refuses unrelated bases as 422', async () => {
    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    const stale: ProvenanceBase = {
      kind: 'stack',
      id: computeStackHash(ref.layers.slice(0, 1)),
    };
    const conflicting = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI999' } }],
      'Concurrent edit from a stale base',
      stale
    );
    expect((await push(conflicting)).status).toBe(201);
    const conflicted = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({
        candidate: conflicting.header.id,
        waivers: [{ spec: 'fire-safety.ids', reason: 'conflict test' }],
      }),
    });
    expect(conflicted.status).toBe(409);
    const conflicts = ((await conflicted.json()) as { conflicts: unknown[] }).conflicts;
    expect(conflicts.length).toBeGreaterThan(0);

    const unrelated = publishable(
      [{ path: 'slab-9', attributes: { [CLASS]: { code: 'IfcSlab', uri: 'u' } } }],
      'Different history entirely',
      { kind: 'stack', id: 'blake3:doesnotexistanywhere' }
    );
    expect((await push(unrelated)).status).toBe(201);
    const refused = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({ candidate: unrelated.header.id }),
    });
    expect(refused.status).toBe(422);
  });

  it('opens reviews and records feedback', async () => {
    const layerId = baseLayer.header.id;
    const opened = await fetch(`${api}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ layer_id: layerId, into: 'main' }),
    });
    expect(opened.status).toBe(201);
    const { id } = (await opened.json()) as { id: string };

    const feedback = await fetch(`${api}/reviews/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        decisions: [{ entity: 'wall-1', decision: 'reject', comment: 'wrong rating' }],
        status: 'changes-requested',
      }),
    });
    expect(feedback.status).toBe(200);

    const review = (await (await fetch(`${api}/reviews/${id}`)).json()) as {
      status: string;
      feedback: unknown[];
      openedBy?: string;
    };
    expect(review.status).toBe('changes-requested');
    expect(review.feedback).toHaveLength(1);
    expect(review.openedBy).toBe('anonymous');
  });

  it('enforces named reviewers and blocks self-approval', async () => {
    const server = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: () => ({ userId: 'bot-7', role: 'editor' }),
    });
    try {
      const port = (server.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });

      // Agent-authored layer (manifest author.principal = 'bot-7').
      const layer = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
        'Agent work',
        null,
        'agent'
      );
      expect((await post('/layers', layer)).status).toBe(201);
      await fetch(`${url}/refs/main`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [layer.header.id] }),
      });

      // Named reviewers exclude the caller: feedback is rejected.
      const restricted = await post('/reviews', {
        layer_id: layer.header.id,
        into: 'main',
        reviewers: ['bob'],
      });
      const restrictedId = ((await restricted.json()) as { id: string }).id;
      const rejected = await post(`/reviews/${restrictedId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      expect(rejected.status).toBe(403);

      // Unrestricted review: the layer's own author still cannot approve it.
      const open = await post('/reviews', { layer_id: layer.header.id, into: 'main' });
      const openId = ((await open.json()) as { id: string }).id;
      const selfApproval = await post(`/reviews/${openId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      expect(selfApproval.status).toBe(403);
      expect(((await selfApproval.json()) as { error: string }).error).toContain('own review');

      // Non-approving feedback from the author is still allowed.
      const comment = await post(`/reviews/${openId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept', comment: 'self-note' }],
      });
      expect(comment.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('rejects malformed ref bodies: non-string layers and invalid policy shapes', async () => {
    const badLayers = await fetch(`${api}/refs/bad`, {
      method: 'PUT',
      body: JSON.stringify({ layers: [42, null] }),
    });
    expect(badLayers.status).toBe(400);
    const badPolicy = await fetch(`${api}/refs/bad`, {
      method: 'PUT',
      body: JSON.stringify({ layers: [], policy: { requiredChecks: 'not-an-array' } }),
    });
    expect(badPolicy.status).toBe(400);
  });

  it('derives requireHumanApproval from approved reviews, never from caller input', async () => {
    const server = await startCollabServer({ port: 0, layerRegistry: true });
    try {
      const port = (server.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });

      const root = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
        'Import',
        null
      );
      expect((await post('/layers', root)).status).toBe(201);
      const put = await fetch(`${url}/refs/agents`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id], policy: { requireHumanApproval: true } }),
      });
      expect(put.status).toBe(201);

      const agentLayer = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
        'Agent edit',
        { kind: 'stack', id: computeStackHash([root.header.id]) },
        'agent'
      );
      expect((await post('/layers', agentLayer)).status).toBe(201);

      // A caller-asserted approved_by must NOT satisfy the policy.
      const asserted = await post('/refs/agents/merge', {
        candidate: agentLayer.header.id,
        approved_by: 'mallory',
      });
      expect(asserted.status).toBe(403);

      // An approved review object — server-recorded approval — does.
      const opened = await post('/reviews', { layer_id: agentLayer.header.id, into: 'agents' });
      const { id } = (await opened.json()) as { id: string };
      await post(`/reviews/${id}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      const merged = await post('/refs/agents/merge', { candidate: agentLayer.header.id });
      expect(merged.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('rejects all access when authentication denies', async () => {
    const denied = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: () => null,
    });
    try {
      const port = (denied.httpServer.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/layers`);
      expect(res.status).toBe(401);
    } finally {
      await denied.stop();
    }
  });

  it('rejects writes from read-only principals but allows reads', async () => {
    const viewerOnly = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: () => ({ userId: 'reader', role: 'viewer' }),
    });
    try {
      const port = (viewerOnly.httpServer.address() as { port: number }).port;
      const reads = await fetch(`http://127.0.0.1:${port}/api/v1/layers`);
      expect(reads.status).toBe(200);
      const writes = await fetch(`http://127.0.0.1:${port}/api/v1/layers`, {
        method: 'POST',
        body: JSON.stringify(baseLayer),
      });
      expect(writes.status).toBe(401);
    } finally {
      await viewerOnly.stop();
    }
  });
});
