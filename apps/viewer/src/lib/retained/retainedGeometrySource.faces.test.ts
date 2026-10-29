/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 M11-F: a published product's per-part persistent face tables reach the
 * retained summary, merged by source key over each part's own view mesh.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { ScriptedHostWorker, complete, productMesh, published, start } from '@/test/retained-host-fixture';
import { RetainedClient } from './retained-client';
import type { RetainedHostEvent } from './retained-protocol';
import { faceRows, retainedGeometryEvents } from './retainedGeometrySource';
import { RetainedInstancing } from './retainedInstancing';

describe('#7955 M11-F retained face tables', () => {
  it('M11-I keeps every grouped product face area when the flat meshes leave the host message', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => 31 + i * 7);
    const messages: RetainedHostEvent[] = [];
    // This is a transport invariant; real IFNS grouping is covered by the WASM
    // and viewer witnesses. Each translated fixture triangle has area 0.5 m².
    const batcher = new RetainedInstancing(() => ({ shard: new Uint8Array(), flatIndices: new Uint32Array(),
      instanceCount: 8, groupCount: 1, verificationRejections: 0 }), 1, event => {
        if (event.kind === 'error') throw new Error(event.message);
        messages.push(event);
      });
    for (const [i, id] of ids.entries()) {
      const product = published(id);
      assert.ok(product.kind === 'published');
      batcher.accept({ ...product, meshes: [productMesh(id, i * 5)],
        instanceKey: 'a'.repeat(64), instanceWorldFromObject: Float64Array.of(1,0,0,0, 0,1,0,0, 0,0,1,0, i*5,0,0,1),
        faces: [{ table: ['#13:cap(end)'], triangles: Uint32Array.of(0) }] });
    }
    batcher.flush();
    const group = messages.find(event => event.kind === 'published');
    assert.ok(group?.kind === 'published');
    assert.equal(group.meshes.length, 0, 'the summary must survive removing the flat payload');
    const summaries: RetainedGeometrySummary[] = [];
    const client = new RetainedClient(() => new ScriptedHostWorker([start(ids), ...messages, complete]));
    const events = retainedGeometryEvents(client, new Uint8Array([1]), { onSummary: s => summaries.push(s) });
    for (let next = await events.next(); !next.done; next = await events.next()) { /* drain */ }
    client.unload();
    assert.deepEqual(summaries.at(-1)!.faces, Object.fromEntries(ids.map(id =>
      [id, [{ key: '#13:cap(end)', triangles: 1, areaM2: 0.5 }]])));
  });

  it('merges each part table by key with its triangle count and area', async () => {
    // The second part's triangle has area 2 (not the first part's 0.5), so a row computed
    // from the wrong part's mesh cannot pass.
    const wide = { ...productMesh(7, 5), positions: new Float32Array([5, 0, 0, 7, 0, 0, 5, 2, 0]) };
    const keyed = { ...published(7), meshes: [productMesh(7), wide],
      faces: [{ table: ['#13:cap(end)'], triangles: Uint32Array.of(0) },
        { table: ['#13:cap(end)', '#14>#9:side(0,1)'], triangles: Uint32Array.of(1) }] } as RetainedHostEvent;
    const summaries: RetainedGeometrySummary[] = [];
    const client = new RetainedClient(() => new ScriptedHostWorker([start([7, 8]), keyed, published(8), complete]));
    const events = retainedGeometryEvents(client, new Uint8Array([1]), { onSummary: (s) => summaries.push(s) });
    for (let next = await events.next(); !next.done; next = await events.next()) { /* drain */ }
    client.unload();
    assert.deepEqual(summaries.at(-1)!.faces, {
      7: [{ key: '#13:cap(end)', triangles: 1, areaM2: 0.5 }, { key: '#14>#9:side(0,1)', triangles: 1, areaM2: 2 }],
    }, 'a product without tables (#8) has no row, never an invented one');
  });

  it('keeps source-table order, not triangle order, and drops keys with no triangles', () => {
    const mesh = { ...productMesh(9), positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]) };
    assert.deepEqual(faceRows([{ table: ['#1:cap(start)', '#1:cap(end)', '#1:side(0,0)'], triangles: Uint32Array.of(1, 0) }], [mesh]), [
      { key: '#1:cap(start)', triangles: 1, areaM2: 2 },
      { key: '#1:cap(end)', triangles: 1, areaM2: 0.5 },
    ]);
  });
});
