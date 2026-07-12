/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry webhooks + auto-merge (08-review.md §8.7, 10-registry.md
 * §10.4): every registry write emits a signed event, and conflict-free
 * all-green candidates merge unattended into `autoMerge` refs — with
 * every fail-closed guard (approval refs, baseless candidates,
 * conflicts) verified to leave refs untouched.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceBase } from '@ifc-lite/ifcx';
import { startCollabServer, type CollabServerHandle } from '../src/index.js';
import { signRegistryEvent, type RegistryEvent } from '../src/registry-webhooks.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const CLASS = 'bsi::ifc::class';
const SECRET = 'hook-secret';

function publishable(
  nodes: IfcxNode[],
  intent: string,
  base: ProvenanceBase | null,
  checks: Array<{ tool: string; spec?: string; result: 'pass' | 'fail' }> = []
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
    author: { kind: 'human', principal: 'alice' },
    intent,
    base,
    created: '2026-06-10T00:00:00.000Z',
    checks,
  });
  const withManifest = setProvenance(bare, manifest);
  return { ...withManifest, header: { ...withManifest.header, id: computeLayerId(withManifest) } };
}

interface Received {
  event: RegistryEvent;
  signature: string | undefined;
  body: string;
}

function startSink(): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      received.push({
        event: JSON.parse(body) as RegistryEvent,
        signature: req.headers['x-ifclite-signature'] as string | undefined,
        body,
      });
      res.writeHead(200);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for webhook delivery');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('registry webhooks + auto-merge', () => {
  let sink: Awaited<ReturnType<typeof startSink>>;
  let handle: CollabServerHandle;
  let api: string;

  beforeAll(async () => {
    sink = await startSink();
    handle = await startCollabServer({
      port: 0,
      layerRegistry: { webhooks: [{ url: sink.url, secret: SECRET }] },
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    api = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await handle.stop();
    await sink.close();
  });

  function eventsOf(type: string): Received[] {
    return sink.received.filter((r) => r.event.event === type);
  }

  it('emits signed events for pushes, ref moves, reviews, and auto-merges green candidates', async () => {
    const base = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
      'Base model',
      null
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(base) })).status).toBe(201);
    await waitFor(() => eventsOf('layer.pushed').length === 1);
    const pushed = eventsOf('layer.pushed')[0];
    expect(pushed.event.data.id).toBe(base.header.id);
    // HMAC-SHA256 over the raw body, verifiable by the consumer.
    expect(pushed.signature).toBe(signRegistryEvent(SECRET, pushed.body));
    expect(pushed.signature).toBe(
      `sha256=${crypto.createHmac('sha256', SECRET).update(pushed.body, 'utf-8').digest('hex')}`
    );

    // Protected auto-merge ref.
    expect(
      (
        await fetch(`${api}/refs/main`, {
          method: 'PUT',
          body: JSON.stringify({ layers: [base.header.id], policy: { autoMerge: true } }),
        })
      ).status
    ).toBe(201);
    await waitFor(() => eventsOf('ref.moved').length === 1);

    // A candidate authored on the ref tip auto-merges on push.
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
      'Bump rating',
      { kind: 'stack', id: computeStackHash([base.header.id]) }
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(candidate) })).status).toBe(201);
    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(ref.layers).toEqual([base.header.id, candidate.header.id]);
    await waitFor(() => eventsOf('ref.merged').length === 1);
    expect(eventsOf('ref.merged')[0].event.data).toMatchObject({
      ref: 'main',
      candidate: candidate.header.id,
      status: 'fast-forward',
      auto: true,
    });

    // Review lifecycle events.
    const opened = await fetch(`${api}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ layer_id: candidate.header.id, into: 'main' }),
    });
    const reviewId = ((await opened.json()) as { id: string }).id;
    await fetch(`${api}/reviews/${reviewId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Looks fine', entity: 'wall-1' }),
    });
    await fetch(`${api}/reviews/${reviewId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ decisions: [{ entity: 'wall-1', decision: 'accept' }] }),
    });
    await waitFor(
      () =>
        eventsOf('review.opened').length === 1 &&
        eventsOf('review.commented').length === 1 &&
        eventsOf('review.updated').length === 1
    );
  });

  it('fail-closed: conflicts, baseless candidates, and approval refs never auto-merge', async () => {
    const mergedBefore = eventsOf('ref.merged').length;
    const refBefore = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };

    // Conflicting candidate (authored on the ORIGINAL base, touching the
    // same component the ref has since changed): pushes fine, no merge.
    const conflicting = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }],
      'Conflicting bump',
      { kind: 'stack', id: computeStackHash([refBefore.layers[0]]) }
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(conflicting) })).status).toBe(201);

    // Baseless candidate: disjoint content, but no declared base — three-way
    // against an empty ancestor must never run unattended.
    const baseless = publishable(
      [{ path: 'roof-1', attributes: { [CLASS]: { code: 'IfcRoof', uri: 'u' } } }],
      'Disjoint baseless',
      null
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(baseless) })).status).toBe(201);

    const refAfter = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(refAfter.layers).toEqual(refBefore.layers);
    expect(eventsOf('ref.merged').length).toBe(mergedBefore);

    // An approval-requiring auto-merge ref never fires either.
    await fetch(`${api}/refs/guarded`, {
      method: 'PUT',
      body: JSON.stringify({
        layers: refBefore.layers,
        policy: { autoMerge: true, requireHumanApproval: true },
      }),
    });
    const green = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI200' } }],
      'Green but unapproved',
      { kind: 'stack', id: computeStackHash(refBefore.layers) }
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(green) })).status).toBe(201);
    const guarded = (await (await fetch(`${api}/refs/guarded`)).json()) as { layers: string[] };
    expect(guarded.layers).toEqual(refBefore.layers);
  });

  it('all-green means the WHOLE manifest: any failing check keeps the merge attended', async () => {
    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    const failing = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI240' } }],
      'Fails a check the policy never required',
      { kind: 'stack', id: computeStackHash(ref.layers) },
      [{ tool: '@ifc-lite/ids', spec: 'unrequired.ids', result: 'fail' }]
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(failing) })).status).toBe(201);
    const after = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(after.layers).toEqual(ref.layers);
  });

  it('a candidate that landed via a merge layer is not re-merged on identical re-push', async () => {
    // Seed a divergence so the auto-merge lands via a MERGE layer.
    const ref = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    const disjoint = publishable(
      [{ path: 'door-1', attributes: { [CLASS]: { code: 'IfcDoor', uri: 'u' } } }],
      'Disjoint auto-mergeable',
      { kind: 'stack', id: computeStackHash(ref.layers.slice(0, 1)) }
    );
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(disjoint) })).status).toBe(201);
    const merged = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(merged.layers.length).toBe(ref.layers.length + 1); // one merge layer appended
    // Byte-identical re-push (201, idempotent store) must not re-merge.
    expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(disjoint) })).status).toBe(201);
    const after = (await (await fetch(`${api}/refs/main`)).json()) as { layers: string[] };
    expect(after.layers).toEqual(merged.layers);
  });
});
