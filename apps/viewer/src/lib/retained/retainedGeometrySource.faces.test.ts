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
import { retainedGeometryEvents } from './retainedGeometrySource';

describe('#7955 M11-F retained face tables', () => {
  it('merges each part table by key with its triangle count and area', async () => {
    const keyed = { ...published(7), meshes: [productMesh(7), productMesh(7, 5)],
      faces: [{ table: ['#13:cap(end)'], triangles: Uint32Array.of(0) },
        { table: ['#13:cap(end)', '#14>#9:side(0,1)'], triangles: Uint32Array.of(1) }] } as RetainedHostEvent;
    const summaries: RetainedGeometrySummary[] = [];
    const client = new RetainedClient(() => new ScriptedHostWorker([start([7, 8]), keyed, published(8), complete]));
    const events = retainedGeometryEvents(client, new Uint8Array([1]), { onSummary: (s) => summaries.push(s) });
    for (let next = await events.next(); !next.done; next = await events.next()) { /* drain */ }
    client.unload();
    assert.deepEqual(summaries.at(-1)!.faces, {
      7: [{ key: '#13:cap(end)', triangles: 1, areaM2: 0.5 }, { key: '#14>#9:side(0,1)', triangles: 1, areaM2: 0.5 }],
    }, 'a product without tables (#8) has no row, never an invented one');
  });
});
