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
import type { CoordinateInfo } from '@ifc-lite/geometry';
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
const skip = !existsSync(fixture) ? 'Run pnpm fixtures for real C20 cache reload (#7239).' : harness.skip;

// A schema-optional field may be omitted or own-undefined. Every defined value
// and unknown remains exact; no numeric tolerance or inferred value is used.
function definedCoordinateFields(info: CoordinateInfo) {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
}

it('#7239 real C20 canonical fresh load and automatic cache reload retain complete coordinate provenance',
  { skip }, async context => {
    const bytes = new Uint8Array(readFileSync(fixture));
    assert.equal(bytes.length, 10786515);
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
      assert.ok(fresh.geometryResult && fresh.geometryResult.meshes.length > 0);
      const coordinates = structuredClone(fresh.geometryResult.coordinateInfo);
      assert.ok(coordinates);
      // Independently declared IFC metre units and unshifted C20 origin.
      assert.equal(coordinates.lengthUnitScale, 1);
      assert.equal(coordinates.boundsRecoveryFallbackCount, 0);
      assert.deepEqual(coordinates.originShift, { x: 0, y: 0, z: 0 });
      assert.equal(coordinates.hasLargeCoordinates, false);
      assert.deepEqual(coordinates.originalBounds, coordinates.shiftedBounds);
      const deadline = performance.now() + 60000;
      while (!(await getCached(key))) {
        assert.ok(performance.now() < deadline, 'eligible automatic cache write completed');
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      assert.ok(transport.requests > 0, 'actual compression codec handles automatic cache write');
      const cached = await harness.load(file);
      assert.equal(cached.loadPath, 'cache');
      assert.equal(cached.loadState, 'complete');
      assert.ok(cached.geometryResult?.coordinateInfo);
      assert.notEqual(cached.id, fresh.id);
      assert.deepEqual(definedCoordinateFields(cached.geometryResult.coordinateInfo),
        definedCoordinateFields(coordinates));
      assert.equal(cached.geometryResult.meshes.length, fresh.geometryResult.meshes.length);
      context.diagnostic(JSON.stringify({ routes: [fresh.loadPath, cached.loadPath],
        meshes: fresh.geometryResult.meshes.length, coordinateInfo: coordinates,
        parity: 'complete coordinate metadata only; independent full geometry route parity remains #7024' }));
    } finally {
      await transport.dispose();
      await deleteCached(key);
    }
  });
