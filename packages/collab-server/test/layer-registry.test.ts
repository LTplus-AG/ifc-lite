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
import { MemoryLayerRegistry } from '../src/layer-registry.js';

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

    // Stored reviews are a contract: malformed decisions and unknown
    // status values are rejected, not persisted verbatim.
    const badDecision = await fetch(`${api}/reviews/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ decisions: [{ entity: 'wall-1', decision: 'maybe' }] }),
    });
    expect(badDecision.status).toBe(400);
    const badStatus = await fetch(`${api}/reviews/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ decisions: [], status: 'sideways' }),
    });
    expect(badStatus.status).toBe(400);
    const after = (await (await fetch(`${api}/reviews/${id}`)).json()) as { feedback: unknown[] };
    expect(after.feedback).toHaveLength(1);
  });

  it('rejects malformed percent-encoding in paths as 400, not 500', async () => {
    const res = await fetch(`${api}/layers/%zz`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('percent-encoding');
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

      // An approved review object — server-recorded approval — does, but
      // only while it is the LATEST review for the (candidate, ref) pair:
      // a newer review with changes requested supersedes a stale approval.
      // Protected refs need an explicit reviewer allowlist before an approval
      // counts — an empty reviewer set would let any principal self-approve.
      const opened = await post('/reviews', {
        layer_id: agentLayer.header.id,
        into: 'agents',
        reviewers: ['anonymous'],
      });
      const { id } = (await opened.json()) as { id: string };
      await post(`/reviews/${id}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      const reopened = await post('/reviews', {
        layer_id: agentLayer.header.id,
        into: 'agents',
        reviewers: ['anonymous'],
      });
      const reopenedId = ((await reopened.json()) as { id: string }).id;
      await post(`/reviews/${reopenedId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'reject', comment: 'needs rework' }],
        status: 'changes-requested',
      });
      const superseded = await post('/refs/agents/merge', { candidate: agentLayer.header.id });
      expect(superseded.status).toBe(403);

      await post(`/reviews/${reopenedId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      const merged = await post('/refs/agents/merge', { candidate: agentLayer.header.id });
      expect(merged.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('owns its state: mutating pushed or pulled objects never alters the registry', () => {
    const registry = new MemoryLayerRegistry();
    const layer = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
      'Copy semantics',
      null
    );
    const id = registry.push(layer);
    layer.data.push({ path: 'intruder' }); // ingress: pushed object is not aliased
    expect(registry.loadLayer(id).data.some((n) => n.path === 'intruder')).toBe(false);
    registry.loadLayer(id).data.push({ path: 'intruder' }); // egress: pulled copy is not live
    expect(registry.loadLayer(id).data.some((n) => n.path === 'intruder')).toBe(false);

    registry.setRef('main', { layers: [id], policy: { requireHumanApproval: true } });
    const ref = registry.getRef('main');
    ref?.layers.push('blake3:bogus');
    delete ref?.policy;
    expect(registry.getRef('main')).toEqual({
      layers: [id],
      policy: { requireHumanApproval: true },
    });
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

  it('first write wins: a same-id re-push with different non-canonical bytes is refused', () => {
    const registry = new MemoryLayerRegistry();
    const layer = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
      'First write',
      null
    );
    const id = registry.push(layer);
    // Byte-identical re-push is idempotent.
    expect(registry.push(structuredClone(layer))).toBe(id);
    // Same canonical bytes (derived content is excluded from the id), but
    // different stored bytes: an attacker could poison a derived cache or
    // strip signatures under a trusted id. Refused.
    const tampered = structuredClone(layer);
    tampered.data[0].attributes!['ifclite::derived::bbox'] = [0, 0, 0, 1, 1, 1];
    expect(computeLayerId(tampered)).toBe(id);
    expect(() => registry.push(tampered)).toThrowError(/different non-canonical bytes/);
    expect(registry.loadLayer(id).data[0].attributes!['ifclite::derived::bbox']).toBeUndefined();
  });

  it('caps stored layers so a write loop cannot exhaust memory', () => {
    const registry = new MemoryLayerRegistry({ maxLayers: 1 });
    const first = publishable([{ path: 'a', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }], 'One', null);
    registry.push(first);
    const second = publishable([{ path: 'b', attributes: { [CLASS]: { code: 'IfcDoor', uri: 'u' } } }], 'Two', null);
    expect(() => registry.push(second)).toThrowError(/cap 1/);
    // Idempotent re-push of an existing layer still succeeds at the cap.
    expect(registry.push(structuredClone(first))).toBe(first.header.id);
  });

  it("a protected ref's policy cannot be changed via PUT", async () => {
    const server = await startCollabServer({ port: 0, layerRegistry: true });
    try {
      const port = (server.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      const root = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
        'Import',
        null
      );
      await fetch(`${url}/layers`, { method: 'POST', body: JSON.stringify(root) });
      const created = await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({
          layers: [root.header.id],
          policy: { requireHumanApproval: true, requiredChecks: ['fire.ids'] },
        }),
      });
      expect(created.status).toBe(201);

      // Weakening (or clearing) the policy via PUT would neuter the merge
      // gate for any write principal.
      const weakened = await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({ policy: {} }),
      });
      expect(weakened.status).toBe(409);

      // Idempotent re-PUT of the identical policy stays allowed.
      const idempotent = await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({ policy: { requireHumanApproval: true, requiredChecks: ['fire.ids'] } }),
      });
      expect(idempotent.status).toBe(200);
      const entry = (await (await fetch(`${url}/refs/prod`)).json()) as { policy?: unknown };
      expect(entry.policy).toEqual({ requireHumanApproval: true, requiredChecks: ['fire.ids'] });
    } finally {
      await server.stop();
    }
  });

  it('requireHumanApproval gates every candidate — a claimed-human author cannot skip the review', async () => {
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
      await post('/layers', root);
      await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id], policy: { requireHumanApproval: true } }),
      });

      // author.kind is self-asserted: an agent that lies and claims to be
      // human must still not merge without a server-recorded approval.
      const claimedHuman = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
        'Claims to be human',
        { kind: 'stack', id: computeStackHash([root.header.id]) },
        'human'
      );
      await post('/layers', claimedHuman);
      const unapproved = await post('/refs/prod/merge', { candidate: claimedHuman.header.id });
      expect(unapproved.status).toBe(403);

      // Preview stays available without approval (read-only planning).
      const preview = await post('/refs/prod/merge', {
        candidate: claimedHuman.header.id,
        preview: true,
      });
      expect(preview.status).toBe(200);

      // Protected ref: an explicit reviewer allowlist is required for approval.
      const opened = await post('/reviews', {
        layer_id: claimedHuman.header.id,
        into: 'prod',
        reviewers: ['anonymous'],
      });
      const { id } = (await opened.json()) as { id: string };
      await post(`/reviews/${id}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      const merged = await post('/refs/prod/merge', { candidate: claimedHuman.header.id });
      expect(merged.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('refuses to approve a protected-ref review that names no reviewers', async () => {
    // Without an explicit reviewer allowlist there is nothing to attest the
    // approver against, so an unnamed review must not be approvable on a
    // requireHumanApproval ref (a second minted token would otherwise
    // self-approve past the merge gate).
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
      await post('/layers', root);
      await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id], policy: { requireHumanApproval: true } }),
      });
      const candidate = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
        'Edit',
        { kind: 'stack', id: computeStackHash([root.header.id]) },
        'agent'
      );
      await post('/layers', candidate);

      // No reviewers → approval is rejected on the protected ref.
      const opened = await post('/reviews', { layer_id: candidate.header.id, into: 'prod' });
      const { id } = (await opened.json()) as { id: string };
      const approve = await post(`/reviews/${id}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      expect(approve.status).toBe(403);
      expect(((await approve.json()) as { error: string }).error).toContain('names no reviewers');

      // And the merge still fails because no approval was recorded.
      const merged = await post('/refs/prod/merge', { candidate: candidate.header.id });
      expect(merged.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('empty-reviewer gate only bites protected refs and never exempts the author', async () => {
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
      await post('/layers', root);
      // Unprotected ref: no requireHumanApproval policy.
      await fetch(`${url}/refs/scratch`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id] }),
      });
      // Protected ref over the same base.
      await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id], policy: { requireHumanApproval: true } }),
      });
      const base = { kind: 'stack' as const, id: computeStackHash([root.header.id]) };
      const candidate = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
        'Edit',
        base,
        'agent'
      );
      await post('/layers', candidate);

      // Unprotected ref: a review with NO reviewers can still be approved —
      // the gate must not regress the unprotected flow.
      const scratchReview = await post('/reviews', { layer_id: candidate.header.id, into: 'scratch' });
      const scratchId = ((await scratchReview.json()) as { id: string }).id;
      const scratchApprove = await post(`/reviews/${scratchId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      expect(scratchApprove.status).toBe(200);

      // Protected ref + reviewer allowlist naming the (non-author) actor:
      // approval is accepted and satisfies the merge gate.
      const opened = await post('/reviews', {
        layer_id: candidate.header.id,
        into: 'prod',
        reviewers: ['anonymous'],
      });
      const { id } = (await opened.json()) as { id: string };
      const approve = await post(`/reviews/${id}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      expect(approve.status).toBe(200);
      const merged = await post('/refs/prod/merge', { candidate: candidate.header.id });
      expect(merged.status).toBe(200);

      // Protected ref + reviewer allowlist naming the AUTHOR: being listed is
      // not an exemption from the self-approval separation.
      const selfCandidate = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }],
        'Self edit',
        base,
        'human',
        'anonymous' // same principal the unauthenticated actor resolves to
      );
      await post('/layers', selfCandidate);
      const selfReview = await post('/reviews', {
        layer_id: selfCandidate.header.id,
        into: 'prod',
        reviewers: ['anonymous'],
      });
      const selfId = ((await selfReview.json()) as { id: string }).id;
      const selfApprove = await post(`/reviews/${selfId}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      expect(selfApprove.status).toBe(403);
      expect(((await selfApprove.json()) as { error: string }).error).toContain(
        'cannot approve their own review'
      );
    } finally {
      await server.stop();
    }
  });

  it('maps registry-full to 507 on ref PUT and review POST (not a bare 500)', async () => {
    const store = new MemoryLayerRegistry({ maxRefs: 1, maxReviews: 1 });
    const server = await startCollabServer({ port: 0, layerRegistry: { store } });
    try {
      const port = (server.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      const root = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
        'Import',
        null
      );
      await fetch(`${url}/layers`, { method: 'POST', body: JSON.stringify(root) });
      const first = await fetch(`${url}/refs/main`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id] }),
      });
      expect(first.status).toBe(201);
      const second = await fetch(`${url}/refs/other`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id] }),
      });
      expect(second.status).toBe(507);

      const review = (body: unknown) =>
        fetch(`${url}/reviews`, { method: 'POST', body: JSON.stringify(body) });
      expect((await review({ layer_id: root.header.id, into: 'main' })).status).toBe(201);
      expect((await review({ layer_id: root.header.id, into: 'main' })).status).toBe(507);
    } finally {
      await server.stop();
    }
  });

  it('requires provenance on authenticated pushes and refuses author-less candidates on protected refs', async () => {
    // Authenticated: a manifest-less push would dodge author binding and,
    // later, the self-approval separation.
    const authed = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: () => ({ userId: 'mallory', role: 'editor' }),
    });
    try {
      const port = (authed.httpServer.address() as { port: number }).port;
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
        data: [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
      };
      const manifestless = { ...bare, header: { ...bare.header, id: computeLayerId(bare) } };
      const rejected = await fetch(`http://127.0.0.1:${port}/api/v1/layers`, {
        method: 'POST',
        body: JSON.stringify(manifestless),
      });
      expect(rejected.status).toBe(400);
    } finally {
      await authed.stop();
    }

    // Anonymous registries still accept manifest-less layers, but a
    // requireHumanApproval ref refuses them at merge time: with no author
    // to compare, approver-vs-author separation cannot be verified.
    const anon = await startCollabServer({ port: 0, layerRegistry: true });
    try {
      const port = (anon.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });
      const root = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
        'Import',
        null
      );
      await post('/layers', root);
      await fetch(`${url}/refs/prod`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id], policy: { requireHumanApproval: true } }),
      });

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
        data: [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
      };
      const stripped = { ...bare, header: { ...bare.header, id: computeLayerId(bare) } };
      expect((await post('/layers', stripped)).status).toBe(201);

      // Protected ref: an explicit reviewer allowlist is required for approval,
      // so the approval is recorded — the merge still fails later because the
      // candidate carries no provenance author to compare the approver against.
      const opened = await post('/reviews', {
        layer_id: stripped.header.id,
        into: 'prod',
        reviewers: ['anonymous'],
      });
      const { id } = (await opened.json()) as { id: string };
      await post(`/reviews/${id}/feedback`, {
        decisions: [{ entity: 'wall-1', decision: 'accept' }],
        status: 'approved',
      });
      const merged = await post('/refs/prod/merge', { candidate: stripped.header.id });
      expect(merged.status).toBe(403);
      const body = (await merged.json()) as { reason?: string };
      expect(body.reason).toMatch(/no provenance author/);
    } finally {
      await anon.stop();
    }
  });

  it('merges with per-conflict resolutions from the review UI', async () => {
    const server = await startCollabServer({ port: 0, layerRegistry: true });
    try {
      const port = (server.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });

      const SOUND = 'bsi::ifc::v5a::Pset_Acoustic::Rw';
      const root = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60', [SOUND]: 40 } }],
        'Import',
        null
      );
      await post('/layers', root);
      const ours = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI90', [SOUND]: 45 } }],
        'Ours',
        { kind: 'stack', id: computeStackHash([root.header.id]) }
      );
      await post('/layers', ours);
      await fetch(`${url}/refs/main`, {
        method: 'PUT',
        body: JSON.stringify({ layers: [root.header.id, ours.header.id] }),
      });
      const candidate = publishable(
        [{ path: 'wall-1', attributes: { [FIRE]: 'REI120', [SOUND]: 50 } }],
        'Theirs',
        { kind: 'stack', id: computeStackHash([root.header.id]) }
      );
      await post('/layers', candidate);

      // Without resolutions the conflicts surface as 409.
      const conflicted = await post('/refs/main/merge', { candidate: candidate.header.id });
      expect(conflicted.status).toBe(409);
      const body409 = (await conflicted.json()) as { conflicts: Array<{ componentKey?: string }> };
      expect(body409.conflicts).toHaveLength(2);

      // Malformed resolutions are rejected with a clear 400.
      const malformed = await post('/refs/main/merge', {
        candidate: candidate.header.id,
        resolutions: [{ path: 'wall-1', choice: 'nuke' }],
      });
      expect(malformed.status).toBe(400);

      // Mixed per-conflict choices complete the merge server-side.
      const merged = await post('/refs/main/merge', {
        candidate: candidate.header.id,
        resolutions: [
          { path: 'wall-1', component_key: 'pset:Pset_FireSafety', choice: 'theirs' },
          { path: 'wall-1', component_key: 'pset:Pset_Acoustic', choice: 'ours' },
        ],
      });
      expect(merged.status).toBe(200);
      const outcome = (await merged.json()) as { status: string; merge_layer?: string };
      expect(outcome.status).toBe('merged');
      expect(outcome.merge_layer?.startsWith('blake3:')).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('binds the manifest author to the push credential', async () => {
    const server = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: () => ({ userId: 'mallory', role: 'editor' }),
    });
    try {
      const port = (server.httpServer.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/v1`;
      // Claiming someone else's identity in the manifest is refused: a
      // spoofed author.principal would defeat the no-self-approval guard.
      const spoofed = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
        'Spoofed author',
        null,
        'human',
        'alice'
      );
      const rejected = await fetch(`${url}/layers`, { method: 'POST', body: JSON.stringify(spoofed) });
      expect(rejected.status).toBe(403);

      const honest = publishable(
        [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } }],
        'Honest author',
        null,
        'human',
        'mallory'
      );
      const accepted = await fetch(`${url}/layers`, { method: 'POST', body: JSON.stringify(honest) });
      expect(accepted.status).toBe(201);
    } finally {
      await server.stop();
    }
  });
});
