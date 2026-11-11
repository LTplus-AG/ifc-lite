/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { MeshData } from '@ifc-lite/geometry';
import { perfCounters, diffCounters } from '@ifc-lite/load-trace';
import { useViewerStore } from '@/store';
import * as harness from '@/test/blank-ifc-loader-harness.js';
import { firstBatchDifference, streamIntoScene } from '@/test/streamed-batch-identity.js';

/**
 * The cold load's final batches are built from what the stream already
 * uploaded (#9684 assembles them on the GPU; worker-built fragment records
 * follow). Whatever builds them, they must equal the full main-thread rebuild
 * of the same meshes: same batches, pieces, frames, bounds, indices, LOD1 and
 * decoded vertices. Real corpus models, meshed by the actual engine, streamed
 * in arrival order like the viewer streams them.
 */
const FIXTURES = ['ara3d/AC20-FZK-Haus.ifc', 'ara3d/duplex.ifc', 'ara3d/C20-Institute-Var-2.ifc', 'ara3d/dental_clinic.ifc', 'ara3d/advanced_model.ifc'];

for (const name of FIXTURES) {
  const fixture = new URL(`../../../../tests/models/${name}`, import.meta.url);
  const skip = !existsSync(fixture) ? `Run pnpm fixtures for ${name}.` : harness.skip;
  it(`${name}: streamed final batches equal the full rebuild, with and without a snapshot capture`, { skip }, async (t) => {
    const bytes = new Uint8Array(readFileSync(fixture));
    await harness.load(new File([bytes.buffer], name.split('/').pop()!, { lastModified: 1 }));
    const state = useViewerStore.getState();
    const meshes: MeshData[] = state.models.get(state.activeModelId ?? '')?.geometryResult?.meshes ?? [];
    assert.ok(meshes.length > 0, `${name} produced meshes`);

    perfCounters.enable();
    const before = perfCounters.read();
    const streamed = await streamIntoScene(meshes);
    const counters = diffCounters(perfCounters.read(), before);
    const reference = await streamIntoScene(meshes, { rebuild: true });
    const assembled = counters['render.finalize.assembled.count'] ?? 0;
    const rebuilt = Object.entries(counters).filter(([key]) => key.startsWith('render.finalize.rebuilt.')).map(([key, n]) => `${key.slice(24)} ${n}`).join(', ');
    t.diagnostic(`${name}: ${meshes.length} meshes, ${streamed.batches.length} batches, ${assembled} assembled; rebuilt: ${rebuilt || 'none'}`);
    assert.ok(assembled > 0, `${name}: some final batch is assembled (${assembled} of ${streamed.batches.length})`);
    const difference = firstBatchDifference(streamed.batches, reference.batches);
    assert.ok(difference === null, `${name}: ${difference}`);

    const captured = await streamIntoScene(meshes, { capture: true });
    const capturedDifference = firstBatchDifference(captured.batches, reference.batches);
    assert.ok(capturedDifference === null, `${name} with a capture armed: ${capturedDifference}`);
  });
}
