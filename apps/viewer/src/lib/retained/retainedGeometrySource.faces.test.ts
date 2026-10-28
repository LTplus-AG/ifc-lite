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

describe('#7955 M11-F retained face tables', () => {
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
