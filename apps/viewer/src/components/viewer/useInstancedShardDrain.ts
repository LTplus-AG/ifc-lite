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
 *
 * A shard belongs to its model. Removal withdraws it from the queue
 * (`modelSlice.sessionRelease`), and it is never uploaded under index 0 and
 * offset 0, which are another model's (#9628 review). Every producer publishes
 * the owner before enqueueing, so an owner missing from the drain's maps is
 * either one render behind (the live store lists it: wait for the maps) or
 * gone for good (the store does not: drop and count, never hold the bytes).
 */

import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { decodeInstancedShard, type MeshData } from '@ifc-lite/geometry';
import { liftNewInstancedOccurrences } from '@/lib/level-arrival';
import { activeLoadTrace } from '@/lib/perf/activeLoadTrace';
import { useViewerStore } from '@/store';
import { drainInstancedShards, hasPendingInstancedShards, noteDroppedInstancedShards, subscribeInstancedShards } from '@/store/instancedShardQueue';
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
  const schedule = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { latest.current = params; });
  const { isInitialized, gpuRecoveryEpoch, modelIdToIndex, modelIdToOffset } = params;
  // An owner the drain was waiting for may have just been published.
  useLayoutEffect(() => {
    if (hasPendingInstancedShards()) schedule.current?.();
  }, [modelIdToIndex, modelIdToOffset]);

  useEffect(() => {
    if (!isInitialized) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const drain = () => {
      timer = undefined;
      const p = latest.current;
      const renderer = p.rendererRef.current;
      const device = renderer?.getGPUDevice();
      // No device (lost or not yet up): keep the shards queued. Recovery bumps
      // `gpuRecoveryEpoch`, which re-subscribes and drains again.
      if (!renderer || !device) return;
      const scene = renderer.getScene();
      try {
        drainInstancedShards((shards, settle) => {
          const trace = activeLoadTrace(); // #6979: shards only arrive while a load streams
          const ownerless: string[] = [];
          let uploaded = 0;
          const liveModels = useViewerStore.getState().models;
          for (const pending of shards) {
            const { modelId, bytes } = pending;
            // No maps at all is the single-model legacy wiring (index 0, offset 0).
            const modelIndex = p.modelIdToIndex ? p.modelIdToIndex.get(modelId) : 0;
            const idOffset = p.modelIdToOffset ? p.modelIdToOffset.get(modelId) : 0;
            if (modelIndex === undefined || idOffset === undefined) {
              if (liveModels.has(modelId)) settle(pending, 'waiting');
              else { ownerless.push(modelId); settle(pending, 'dropped'); }
              continue;
            }
            // CRITICAL: never let a shard decode/upload throw out of the drain.
            // addInstancedShard creates GPU buffers; on a degraded backend whose
            // device is being lost (e.g. CI's SwiftShader), createBuffer throws.
            // Instanced overlays are non-essential, so a failed shard is dropped:
            // the flat geometry still renders.
            let outcome: 'uploaded' | 'dropped' = 'dropped';
            try {
              const shard = trace.span('instanced.decode', () => decodeInstancedShard(new Uint8Array(bytes)));
              if (shard) {
                applyFederationOffsetToShard(shard, idOffset);
                liftNewInstancedOccurrences(shard, p.currentLevelY ?? new Map());
                trace.span('instanced.upload', () => scene.addInstancedShard(device, shard, modelIndex));
                uploaded++;
                outcome = 'uploaded';
              }
            } catch (err) {
              console.warn('[useInstancedShardDrain] instanced shard upload failed (device lost?), skipping:', err);
            }
            // Settled once its upload was attempted: a later throw cannot replay it.
            settle(pending, outcome);
          }
          noteDroppedInstancedShards('ownerless', ownerless.length, ownerless);
          if (uploaded === 0) return;
          if (p.geometryKernel === 'retained' && p.geometry?.length === 0 && !p.appearanceSourceGeometry?.length
            && scene.getInstancedModelIndices().length > 0) {
            fitInstanceOnlyBounds({ renderer, cameraFittedRef: p.cameraFittedRef, cameraSnapshotRef: p.cameraSnapshotRef,
              geometryBoundsRef: p.geometryBoundsRef, finalBoundsRefittedRef: p.finalBoundsRefittedRef,
              lastFitPolicyKindRef: p.lastFitPolicyKindRef, complete: false });
            p.lastGeometryRef.current = p.geometry;
          }
          renderer.requestRender();
        });
        failures = 0;
      } catch (err) {
        // The queue restored every shard the drain had not settled. Retry a few
        // times with backoff; after that the next enqueue, owner change or
        // device recovery drains again.
        failures++;
        console.error('[useInstancedShardDrain] drain failed; unsettled shards stay queued:', err);
        if (failures <= 3 && hasPendingInstancedShards() && timer === undefined) timer = setTimeout(drain, 250 * 2 ** failures);
      }
    };
    const later = () => { if (timer === undefined) timer = setTimeout(drain, 0); };
    schedule.current = later;
    const unsubscribe = subscribeInstancedShards((event) => {
      if (event.kind === 'enqueued') later();
    });
    // Shards queued before the renderer was ready, or across a device recovery.
    drain();
    return () => {
      if (schedule.current === later) schedule.current = null;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isInitialized, gpuRecoveryEpoch]);
}
