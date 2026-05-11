/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute } from '../src/doc/entity.js';
import {
  runSnapshotWorker,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerScopeLike,
} from '../src/snapshot/worker.js';

/**
 * Minimal in-process simulation of a DedicatedWorkerGlobalScope, just
 * enough to drive `runSnapshotWorker` from the test thread.
 */
function fakeWorker(): {
  scope: WorkerScopeLike;
  send(request: WorkerRequest): Promise<WorkerResponse>;
} {
  let listener: ((event: { data: WorkerRequest }) => void) | null = null;
  let pending: ((value: WorkerResponse) => void) | null = null;
  const scope: WorkerScopeLike = {
    addEventListener(_type, handler) {
      listener = handler;
    },
    postMessage(data: WorkerResponse) {
      pending?.(data);
      pending = null;
    },
  };
  return {
    scope,
    send(request) {
      return new Promise<WorkerResponse>((resolve) => {
        pending = resolve;
        listener?.({ data: request });
      });
    },
  };
}

describe('snapshot worker', () => {
  it('snapshots a Y update into IFCX', async () => {
    const w = fakeWorker();
    runSnapshotWorker(w.scope);

    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    setAttribute(doc, 'wall', 'Name', 'WallA');
    const update = Y.encodeStateAsUpdate(doc);

    const reply = await w.send({ kind: 'snapshot', update, requestId: 'r1' });
    expect(reply.kind).toBe('snapshot:ok');
    if (reply.kind !== 'snapshot:ok') return;
    expect(reply.requestId).toBe('r1');
    const wall = reply.ifcx.data.find((n) => n.path === 'wall')!;
    expect(wall.attributes?.Name).toBe('WallA');
  });

  it('seeds from IFCX and returns a Y update', async () => {
    const w = fakeWorker();
    runSnapshotWorker(w.scope);

    const ifcx = {
      header: {
        id: 'test',
        ifcxVersion: 'ifcx_alpha',
        dataVersion: '1.0.0',
        author: 'test',
        timestamp: 'now',
      },
      imports: [],
      schemas: {},
      data: [{ path: 'wall', attributes: { Name: 'seeded' } }],
    };

    const reply = await w.send({ kind: 'seed', source: ifcx, requestId: 'r2' });
    expect(reply.kind).toBe('seed:ok');
    if (reply.kind !== 'seed:ok') return;

    const doc = createCollabDoc();
    Y.applyUpdate(doc, reply.update);
    const ents = doc.getMap('entities');
    expect(ents.has('wall')).toBe(true);
  });

  it('reports errors back to the caller', async () => {
    const w = fakeWorker();
    runSnapshotWorker(w.scope);
    const reply = await w.send({
      kind: 'snapshot',
      update: new Uint8Array([0xff, 0xff, 0xff]),
      requestId: 'r3',
    });
    expect(reply.kind).toBe('error');
  });
});
