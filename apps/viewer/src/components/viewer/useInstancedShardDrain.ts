/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer's drain for GPU-instancing shards (`store/instancedShardQueue`).
 *
 * It subscribes to the queue instead of selecting store state, so a streamed
 * batch's shards cost one decode + upload and no React render (NEW-1). A
 * drain runs in a task of its own, scheduled on the first enqueue since the
 * last drain: React has by then committed any store write made in the same
 * task as the enqueue (a federated finalize registers the model, then
 * enqueues), so the model-index and id-offset maps read here already list
 * that model. Shards enqueued in one task are drained together.
 */

import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { decodeInstancedShard, type MeshData } from '@ifc-lite/geometry';
import { liftNewInstancedOccurrences } from '@/lib/level-arrival';
import { activeLoadTrace } from '@/lib/perf/activeLoadTrace';
import { drainInstancedShards, subscribeInstancedShards } from '@/store/instancedShardQueue';
import { applyFederationOffsetToShard } from './instancedFederationOffset.js';
import { fitInstanceOnlyBounds } from './streamingInstancedBounds.js';
import type { Bounds } from './streamingBounds.js';

export interface InstancedShardDrainParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  gpuRecoveryEpoch: number;
  geometryKernel: 'exact' | 'retained';
  geometry: MeshData[] | null;
  appearanceSourceGeometry?: readonly MeshData[] | null;
  currentLevelY?: ReadonlyMap<number, number>;
  modelIdToIndex?: ReadonlyMap<string, number>;
  modelIdToOffset?: ReadonlyMap<string, number>;
  cameraFittedRef: MutableRefObject<boolean>;
  cameraSnapshotRef: Parameters<typeof fitInstanceOnlyBounds>[0]['cameraSnapshotRef'];
  geometryBoundsRef: MutableRefObject<Bounds>;
  finalBoundsRefittedRef: MutableRefObject<boolean>;
  lastFitPolicyKindRef: MutableRefObject<'compact' | 'linear' | null>;
  lastGeometryRef: MutableRefObject<MeshData[] | null>;
}

export function useInstancedShardDrain(params: InstancedShardDrainParams): void {
  const latest = useRef(params);
  useLayoutEffect(() => { latest.current = params; });
  const { isInitialized, gpuRecoveryEpoch } = params;

  useEffect(() => {
    if (!isInitialized) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => {
      timer = undefined;
      const p = latest.current;
      const renderer = p.rendererRef.current;
      const device = renderer?.getGPUDevice();
      // No device (lost or not yet up): keep the shards queued. Recovery bumps
      // `gpuRecoveryEpoch`, which re-subscribes and drains again.
      if (!renderer || !device) return;
      const scene = renderer.getScene();
      drainInstancedShards((shards) => {
        const trace = activeLoadTrace(); // #6979: shards only arrive while a load streams
        for (const { modelId, bytes } of shards) {
          // CRITICAL: never let a shard decode/upload throw out of the drain.
          // addInstancedShard creates GPU buffers; on a degraded backend whose
          // device is being lost (e.g. CI's SwiftShader), createBuffer throws.
          // Instanced overlays are non-essential, so swallow per-shard
          // failures: the flat geometry still renders.
          try {
            const shard = trace.span('instanced.decode', () => decodeInstancedShard(new Uint8Array(bytes)));
            if (!shard) continue;
            applyFederationOffsetToShard(shard, p.modelIdToOffset?.get(modelId) ?? 0);
            liftNewInstancedOccurrences(shard, p.currentLevelY ?? new Map());
            const modelIndex = p.modelIdToIndex?.get(modelId) ?? 0;
            trace.span('instanced.upload', () => scene.addInstancedShard(device, shard, modelIndex));
          } catch (err) {
            console.warn('[useInstancedShardDrain] instanced shard upload failed (device lost?), skipping:', err);
          }
        }
        if (p.geometryKernel === 'retained' && p.geometry?.length === 0 && !p.appearanceSourceGeometry?.length
          && scene.getInstancedModelIndices().length > 0) {
          fitInstanceOnlyBounds({ renderer, cameraFittedRef: p.cameraFittedRef, cameraSnapshotRef: p.cameraSnapshotRef,
            geometryBoundsRef: p.geometryBoundsRef, finalBoundsRefittedRef: p.finalBoundsRefittedRef,
            lastFitPolicyKindRef: p.lastFitPolicyKindRef, complete: false });
          p.lastGeometryRef.current = p.geometry;
        }
        renderer.requestRender();
      });
    };
    const unsubscribe = subscribeInstancedShards((event) => {
      if (event.kind === 'enqueued' && timer === undefined) timer = setTimeout(drain, 0);
    });
    // Shards queued before the renderer was ready, or across a device recovery.
    drain();
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isInitialized, gpuRecoveryEpoch]);
}
