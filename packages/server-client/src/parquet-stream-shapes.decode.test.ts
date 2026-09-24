/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-batch shape sharing (issue #5407) through the REAL stream reader and
 * the real parquet-wasm decoder, on bytes the real server produced.
 *
 * `__fixtures__/stream-cross-batch.sse` and `stream-batch-local.sse` are the
 * server's SSE output for one IFC — six occurrences of one mapped L-shape,
 * each at its own yaw under a yawed site, streamed two meshes per batch — with
 * and without `stream_shapes=cross-batch`. They are written by
 * `write_server_client_stream_fixtures` in
 * `apps/server/src/routes/parse/parquet_stream_cross_batch_tests.rs`; rerun it
 * when the wire changes.
 *
 * The batch-local stream is ground truth: it shares nothing across batches and
 * has shipped since #3888. Every mesh must land on the same world vertices
 * through the cross-batch stream, whose later batches carry no vertices at all.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { consumeParquetStream } from './parquet-stream-events.js';
import type { ParquetBatch } from './types.js';

function readFixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
}

async function consume(sse: string): Promise<ParquetBatch[]> {
  const batches: ParquetBatch[] = [];
  await consumeParquetStream(new Response(sse), (b) => batches.push(b), 0);
  return batches;
}

/** World vertices per express id: `origin + positions` (rotation already applied). */
function world(batches: ParquetBatch[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const mesh of batches.flatMap((b) => b.meshes)) {
    const o = mesh.origin ?? [0, 0, 0];
    out.set(
      mesh.express_id,
      Array.from(mesh.positions, (p, i) => p + o[i % 3])
    );
  }
  return out;
}

describe('cross-batch Parquet stream on real server bytes', () => {
  it('reconstructs every mesh exactly as the batch-local stream does', async () => {
    const local = await consume(readFixture('stream-batch-local.sse'));
    const shared = await consume(readFixture('stream-cross-batch.sse'));

    expect(local.length).toBeGreaterThanOrEqual(3);
    expect(shared.length).toBe(local.length);

    const expected = world(local);
    const actual = world(shared);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    expect(expected.size).toBe(6);
    for (const [id, verts] of expected) {
      const got = actual.get(id);
      expect(got, `mesh #${id}`).toHaveLength(verts.length);
      got?.forEach((v, i) => expect(Math.abs(v - verts[i]), `mesh #${id} coordinate ${i}`).toBeLessThan(1e-3));
    }
  });

  it('is actually sharing: later batches send no vertices, only rows pointing back', () => {
    const vertexBases = readFixture('stream-cross-batch.sse')
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as { type: string; vertex_base?: number })
      .filter((event) => event.type === 'batch')
      .map((event) => event.vertex_base);
    // Every batch states its base, and it never moves past the first shape.
    expect(vertexBases.every((b) => typeof b === 'number')).toBe(true);
    expect(new Set(vertexBases.slice(1)).size).toBe(1);
    expect(vertexBases[1]).toBeGreaterThan(0);
  });

  it('refuses a stream with a batch missing, instead of drawing the wrong shape', async () => {
    const frames = readFixture('stream-cross-batch.sse').split('\n\n');
    const firstBatch = frames.findIndex((f) => f.includes('"type":"batch"'));
    // Drop the FIRST batch: every later row points into the shape it carried.
    const truncated = frames.filter((_, i) => i !== firstBatch).join('\n\n');
    await expect(consume(truncated)).rejects.toThrow(/missing or out of order/);
  });
});
