/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { Blob as NativeBlob } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { computeSourceFingerprint } from '@ifc-lite/cache';
import type { MeshData } from '@ifc-lite/geometry';
import { getCached, deleteCached } from '@/services/cacheService.js';
import { useViewerStore } from '@/store';
import { resolveLoadTessellationTier } from '@/store/constants.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import * as harness from '@/test/blank-ifc-loader-harness.js';
import { installRealCacheCompressionTransport } from '@/test/cache-compression-transport.js';

// Preserve the actual persisted payload across fake-indexeddb's Blob clone.
const priorBlob = globalThis.Blob;
Reflect.set(globalThis, 'Blob', NativeBlob);
after(() => { Reflect.set(globalThis, 'Blob', priorBlob); });
const fixture = new URL('../../../../tests/models/ara3d/C20-Institute-Var-2.ifc', import.meta.url);
const skip = !existsSync(fixture) ? 'Run pnpm fixtures for real C20 cache reload (#7350).' : harness.skip;

/** Exact text for a number, keeping the sign of zero that JSON would drop. */
const exact = (value: number) => (Object.is(value, -0) ? '-0' : String(value));
const list = (values: readonly number[] | undefined) => (values ? values.map(exact).join(',') : 'absent');

/** One piece's identity plus the #7350 optional metadata. Cache chunks reorder
 *  pieces spatially, so the routes are compared as sorted multisets. */
function describePiece(mesh: MeshData): string {
  return [
    mesh.expressId, mesh.geometryItemId ?? '-', mesh.materialId ?? '-', mesh.geometryClass ?? 0,
    mesh.positions.length, mesh.indices.length,
    `shading=${list(mesh.shadingColor)}`,
    `bounds=${mesh.localBounds ? `${list(mesh.localBounds.min)}/${list(mesh.localBounds.max)}` : 'absent'}`,
    `placement=${list(mesh.localToWorld)}`,
  ].join('|');
}

it('#7350 real C20 automatic cache reload retains per-piece shading and pre-placement metadata',
  { skip }, async context => {
    const bytes = new Uint8Array(readFileSync(fixture));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),
      'a06b9cf1922cc0a1e200719189054510dd3e1d188292325f66614f7c1fdb37b4');
    const file = new File([bytes.buffer], 'C20-Institute-Var-2.ifc', { lastModified: 1234 });
    const state = useViewerStore.getState();
    const key = buildGeometryCacheKey(bytes.length, computeSourceFingerprint(bytes).hex,
      state.mergeLayers, undefined, state.geometryMode === 'fast',
      resolveLoadTessellationTier(bytes.length / (1024 * 1024), state.geometryMode));
    const transport = installRealCacheCompressionTransport();
    try {
      await deleteCached(key);
      const fresh = await harness.load(file);
      assert.equal(fresh.loadPath, 'wasm');
      assert.equal(fresh.loadState, 'complete');
      const freshMeshes = fresh.geometryResult?.meshes ?? [];
      assert.ok(freshMeshes.length > 0);
      const freshPieces = freshMeshes.map(describePiece).sort();
      const counts = {
        meshes: freshMeshes.length,
        localBounds: freshMeshes.filter(mesh => mesh.localBounds).length,
        localToWorld: freshMeshes.filter(mesh => mesh.localToWorld).length,
        shadingColor: freshMeshes.filter(mesh => mesh.shadingColor).length,
      };
      // The fresh route really carries the metadata, so parity is not vacuous.
      assert.ok(counts.localBounds > 0 && counts.localToWorld > 0);

      const deadline = performance.now() + 60000;
      let entry = await getCached(key);
      while (!entry) {
        assert.ok(performance.now() < deadline, 'eligible automatic cache write completed');
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        entry = await getCached(key);
      }
      assert.ok(transport.requests > 0, 'actual compression codec handles automatic cache write');
      const cached = await harness.load(file);
      assert.equal(cached.loadPath, 'cache');
      assert.equal(cached.loadState, 'complete');
      const cachedPieces = (cached.geometryResult?.meshes ?? []).map(describePiece).sort();
      const entryBytes = entry.buffer instanceof Blob ? entry.buffer.size : entry.buffer.byteLength;
      context.diagnostic(JSON.stringify({ routes: [fresh.loadPath, cached.loadPath], ...counts, entryBytes }));
      assert.equal(cachedPieces.length, freshPieces.length);
      assert.deepEqual(cachedPieces, freshPieces);
    } finally {
      await transport.dispose();
      await deleteCached(key);
    }
  });
