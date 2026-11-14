/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { Blob as NativeBlob } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { computeSourceFingerprint } from '@ifc-lite/cache';
import { getCached, deleteCached } from '@/services/cacheService.js';
import { useViewerStore } from '@/store';
import { resolveLoadTessellationTier } from '@/store/constants.js';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { buildGeometryCacheKey } from './geometryCacheKey.js';
import * as harness from '@/test/blank-ifc-loader-harness.js';
import { installRealCacheCompressionTransport } from '@/test/cache-compression-transport.js';

// Preserve the actual persisted payload across fake-indexeddb's Blob clone.
const priorBlob = globalThis.Blob;
Reflect.set(globalThis, 'Blob', NativeBlob);
after(() => { Reflect.set(globalThis, 'Blob', priorBlob); });
const fixture = new URL('../../../../tests/models/ara3d/C20-Institute-Var-2.ifc', import.meta.url);
const skip = !existsSync(fixture) ? 'Run pnpm fixtures for the real cache write after scene settle (L1).' : harness.skip;

/**
 * The next open's cache entry is not a load step. Its encode used to start at
 * `load.finalize`, while the renderer was still draining and finalizing, and
 * competed with them for the main thread. It now starts once the scene has
 * settled (`whenSceneSettled`). A real C20 cold load (10.8 MB, source tier)
 * through the actual loader, with a renderer that is still finalizing:
 * nothing is written until the finalize ends, then the entry appears.
 */
it('writes the cold load\'s cache entry only after the renderer finished finalizing (L1)', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(fixture));
  const file = new File([bytes.buffer], 'C20-Institute-Var-2.ifc', { lastModified: 4321 });
  const state = useViewerStore.getState();
  const key = buildGeometryCacheKey(bytes.length, computeSourceFingerprint(bytes).hex,
    state.mergeLayers, undefined, state.geometryMode === 'fast',
    resolveLoadTessellationTier(bytes.length / (1024 * 1024), state.geometryMode));
  let finalizing = true;
  // The harness's geometry never reaches a renderer; the loader still calls a
  // few scene methods at load start (cold-tier provider, …). Any method this
  // stand-in does not model is a no-op (never `then`: it must not look awaitable);
  // the settled-state queries are ours.
  const scene = new Proxy({ hasQueuedMeshes: () => false, hasStreamingFragments: () => false,
    isFinalizeInProgress: () => finalizing } as Record<string, unknown>, {
    get: (target, key) => (key === 'then' ? undefined : typeof key === 'string' && key in target ? target[key] : () => undefined),
  });
  const renderer = new Proxy({ getScene: () => scene } as Record<string, unknown>, {
    get: (target, key) => (key === 'then' ? undefined : typeof key === 'string' && key in target ? target[key] : () => undefined),
  }) as unknown as Renderer;
  setGlobalRendererRef({ current: renderer } as RefObject<Renderer | null>);
  const transport = installRealCacheCompressionTransport();
  try {
    await deleteCached(key);
    const fresh = await harness.load(file);
    assert.equal(fresh.loadPath, 'wasm');
    assert.equal(fresh.loadState, 'complete');
    // Long enough for a write started at load.finalize (before L1) to land.
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      assert.ok(!(await getCached(key)), 'no cache entry is written while the scene still finalizes');
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    finalizing = false;
    const writeDeadline = performance.now() + 60000;
    while (!(await getCached(key))) {
      assert.ok(performance.now() < writeDeadline, 'the entry is written once the scene settles');
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  } finally {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
    await transport.dispose();
    await deleteCached(key);
  }
});
