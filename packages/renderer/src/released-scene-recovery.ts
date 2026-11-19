/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Device recovery for a scene whose CPU geometry was released (#10264). The
 * ordinary recovery re-uploads the scene from its CPU pieces; a released scene
 * has none, so it is refused (`cpu-geometry-released`) unless the host
 * registered a {@link ReleasedSceneRebuild} with `Renderer.setReleasedSceneRebuild`.
 *
 * Then the device is replaced as usual, the scene's flat and instanced GPU
 * state is reset while model placements stay, and the host rebuilds it from its
 * own storage through the replacement device, in bounded batches
 * (`replayReleasedGeometry`, `Scene.addInstancedShard`). Readiness is published
 * only after the rebuild completes under the same recovery fence; a newer
 * init/destroy, a loss of the replacement device or a failed rebuild leaves the
 * renderer lost, so recovery reports a failure and may retry.
 */

import { WebGPUDevice } from './device.js';
import type { DeviceRecoveryResult, RendererRecoveryHost } from './device-recovery.js';
import type { RenderPipeline } from './pipeline.js';
import type { Scene } from './scene.js';
import type { SceneRecoveryHost } from './scene-device-recovery.js';
import { releaseInstanceVertices } from './scene-model-translation.js';

/** What a released-scene rebuild runs against: the replacement device, before readiness. */
export interface ReleasedSceneRebuildContext {
  readonly device: GPUDevice;
  readonly pipeline: RenderPipeline;
  readonly scene: Scene;
  /** False once this recovery is superseded (newer init/destroy, replacement device lost). */
  isCurrent(): boolean;
  requestRender(): void;
}

/** Rebuild a released scene's flat and instanced geometry; resolve true only when it is whole. */
export type ReleasedSceneRebuild = (context: ReleasedSceneRebuildContext) => Promise<boolean>;

export async function recoverReleasedScene(
  host: RendererRecoveryHost, generation: number, rebuild: ReleasedSceneRebuild,
): Promise<DeviceRecoveryResult> {
  const lossSequence = host.deviceLossSequence;
  const scene = host.scene;
  const current = () => generation === host.initGeneration && !host.destroyed
    && host.deviceLossSequence === lossSequence && host.scene === scene;
  const failed = (error?: unknown): DeviceRecoveryResult => {
    host.deviceLost = true; host.ready = false;
    host.teardown(false);
    return { ok: false, reason: 'scene-restore-failed', ...(error === undefined ? {} : { error }) };
  };
  for (const omission of host.overlays.recoveryOmissions()) host.recovery.omissions.add(omission);
  if (host.recovery.lostReferenceImages) host.recovery.omissions.add('reference-images');
  if (host.pointCloudRenderer?.hasAssets()) host.recovery.omissions.add('point-clouds');
  // A newer init/destroy owns the lifecycle: hand it an empty scene, as the ordinary recovery does.
  const superseded = () => generation !== host.initGeneration || host.destroyed;
  const invalidated = (): DeviceRecoveryResult => {
    host.teardown(true);
    return { ok: false, reason: 'renderer-destroyed', ...(host.destroyed ? {} : { superseded: true as const }) };
  };
  const pointCloudOptions = host.pointCloudRenderer?.getOptions() ?? host.recovery.pointCloudOptions;
  host.recovery.pointCloudOptions = pointCloudOptions ?? null;
  try {
    scene.discardGpuResourcesForRecovery();
    host.teardown(false);
    host.device = new WebGPUDevice();
    await host.initOnce(generation, { clearDeviceLost: false, publishReady: false });
    if (pointCloudOptions) host.pointCloudRenderer?.setOptions(pointCloudOptions);
    if (superseded()) return invalidated();
    if (!current()) return failed(new Error('Replacement GPU device was lost during initialization'));
    let pipeline = host.pipeline;
    if (!pipeline) throw new Error('Replacement render pipeline was not initialized');
    if (host.recovery.quantizedBatchesRequested) {
      const quantized = await pipeline.ensureQuantizedPipelines();
      if (superseded() || host.pipeline !== pipeline) return invalidated();
      if (!current()) return failed(new Error('Replacement GPU device was lost during quantized pipeline validation'));
      scene.setQuantizedBatches(quantized);
      pipeline = host.pipeline;
    }
    // Placements, ids and per-model translations stay; every GPU-derived flat and instanced piece goes.
    scene.resetReleasedForRebuild();
    const whole = await rebuild({ device: host.device.getDevice(), pipeline, scene, isCurrent: current, requestRender: () => host.requestRender() });
    if (superseded()) return invalidated();
    if (!current() || !whole) return failed(new Error(whole ? 'Released scene rebuild was superseded' : 'Released scene rebuild was incomplete'));
    // Restaged templates carry CPU vertices; a released scene keeps only occurrence transforms.
    releaseInstanceVertices((scene as unknown as SceneRecoveryHost).instancedTemplateCpu);
    host.refreshPlacementBounds();
    host.deviceLost = false;
    host.deviceLostInfo = null;
    host.recovery.lostReferenceImages = false;
    host.recovery.pointCloudOptions = null;
    const omissions = [...host.recovery.omissions];
    host.recovery.omissions.clear();
    host.markReady(generation);
    host.requestRender();
    return { ok: true, omissions };
  } catch (error) {
    console.error('[Renderer] Released scene recovery failed:', error);
    return failed(error);
  }
}
