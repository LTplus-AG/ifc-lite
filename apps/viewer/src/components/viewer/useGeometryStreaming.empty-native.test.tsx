/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, useCallback, useRef, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { createLoadTracer } from '@ifc-lite/load-trace';
import { publishLoadTrace } from '@/lib/perf/activeLoadTrace';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { recoveryAllocationDevice } from '@/test/recovery-allocation-device';
import { sectionNativeGeometry, sourceDigest } from '@/test/section-native-geometry';
import { useGeometryStreaming } from './useGeometryStreaming';

for (const mode of ['instanced', 'filtered', 'clear-and-reload'] as const) {
  it(`#6993 valid ${mode} empty-flat stream preserves completion ownership`, { timeout: 30_000 }, async t => {
    const native = sectionNativeGeometry(t); if (!native) return;
    assert.equal(native.shard.instances.length, 42, 'real native IFNS prerequisites');
    assert.ok(native.meshes.length > 200, 'real native flat source exists before the stated filter removes it');
    const before = sourceDigest(native.source);
    const allocation = recoveryAllocationDevice(), renderer = new Renderer(allocation.canvas);
    const tracer = createLoadTracer({ enabled: true, sink: null });
    publishLoadTrace(mode, tracer.startLoad(mode));
    useViewerStore.setState(fixtureModels(fixtureModel('native', { idOffset: 0 })));
    let complete: () => void = () => { throw new Error('Viewport not mounted'); };
    let cancel: () => void = () => { throw new Error('Viewport not mounted'); };
    let restart: () => void = () => { throw new Error('Viewport not mounted'); };
    let released = 0, cleared = 0;
    const clearCaches = renderer.clearCaches.bind(renderer);
    renderer.clearCaches = () => { cleared++; clearCaches(); };
    const noop = () => { /* This native-source completion queues no authoring work. */ };
    try {
      await renderer.init();
      const Probe = () => {
        const [geometry, setGeometry] = useState<MeshData[] | null>([]);
        const [streaming, setStreaming] = useState(true);
        const [replacement, setReplacement] = useState(0);
        const [shards, setShards] = useState<Array<{ modelId: string; bytes: ArrayBuffer }> | null>(
          mode === 'filtered' ? null : [{ modelId: 'native', bytes: native.shardBytes.slice().buffer }]);
        const clearShards = useCallback(() => setShards(null), []);
        const ref = useRef(renderer), bounds = useRef({ min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
        const color = useRef<[number, number, number, number]>([0, 0, 0, 1]);
        const indices = useRef(new Map([['native', 0]])).current;
        const offsets = useRef(new Map([['native', 0]])).current;
        const present = useRef(new Set([0])).current;
        complete = () => setStreaming(false);
        cancel = () => { setGeometry(null); setStreaming(false); setReplacement(value => value + 1); };
        restart = () => { setGeometry([]); setStreaming(true); setReplacement(value => value + 1); };
        useGeometryStreaming({ rendererRef: ref, isInitialized: true, geometry, isStreaming: streaming,
          modelCount: 1, geometryReplacementVersion: replacement, geometryBoundsRef: bounds, clearColorRef: color,
          coordinateInfo: native.coordinateInfo, pendingMeshColorUpdates: null, pendingColorUpdates: null,
          pendingMeshRemovals: null, pendingMeshTranslations: null, pendingMeshRotations: null,
          pendingInstancedShards: shards, modelIdToIndex: indices, modelIdToOffset: offsets,
          presentInstancedModelIndices: present, clearInstancedShards: clearShards,
          clearPendingMeshColorUpdates: noop, clearPendingColorUpdates: noop, clearPendingMeshRemovals: noop,
          pruneGeometryMeshes: noop, clearPendingMeshTranslations: noop, clearPendingMeshRotations: noop,
          releaseGeometryAfterFinalize: mode !== 'instanced', onGeometryReleased: () => { released++; },
        });
        return <canvas />;
      };
      render(<Probe />);
      const scene = renderer.getScene();
      const occurrences = [...new Set(native.shard.instances.map(instance => instance.entityId))].flatMap(id => scene.getInstancedMeshDataPieces(id) ?? []);
      if (mode !== 'filtered') assert.equal(occurrences.length, 42, 'real native IFNS was uploaded before completion assertion');
      else assert.equal(scene.getBatchedMeshes().length, 0, 'stated all-flat visibility filter leaves no GPU flat triangles');
      const finalized = () => tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.end !== null).length ?? 0;
      if (mode === 'clear-and-reload') {
        await act(async () => cancel());
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(finalized(), 0, 'null clears rather than finalizing the cancelled load');
        assert.equal(released, 0, 'cancelled load cannot release a later owner');
        await act(async () => restart());
      }
      await act(async () => complete());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.equal(finalized(), 1, 'a valid empty-flat stream must finalize exactly once');
      assert.equal(cleared, 1, 'actual renderer caches clear on successful completion');
      assert.equal(released, mode === 'instanced' ? 0 : 1, 'ephemeral source releases exactly once');
      await act(async () => complete());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.equal(finalized(), 1, 'settled empty-flat stream does not repeat finalization');
      assert.equal(sourceDigest(native.source), before, 'native source bytes remain unchanged');
    } finally {
      cleanup(); renderer.destroy(); allocation.restore();
    }
  });
}
