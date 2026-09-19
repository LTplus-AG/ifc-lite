/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { WebGPUDevice } from './device.js';
import type { RenderPipeline } from './pipeline.js';
import type { Scene } from './scene.js';

/** GPU-only content that cannot be reconstructed after a device loss. */
export type DeviceRecoveryOmission =
  | 'point-clouds'
  | 'reference-images'
  | 'line-overlays'
  | 'symbolic-overlays'
  | 'section-2d-overlay';

/** Stable failure categories returned by {@link Renderer.recoverDevice}. */
export type DeviceRecoveryFailureReason =
  | 'not-lost'
  | 'cpu-geometry-released'
  | 'scene-not-settled'
  | 'unsupported-authored-meshes'
  | 'cold-restore-failed'
  | 'device-init-failed'
  | 'scene-restore-failed'
  | 'renderer-destroyed';

/** Result of rebuilding a lost renderer in place. */
export type DeviceRecoveryResult =
  | { ok: true; omissions: readonly DeviceRecoveryOmission[] }
  | { ok: false; reason: DeviceRecoveryFailureReason; error?: unknown };

/** Internal friend surface used to keep the recovery lifecycle out of Renderer. */
export interface RendererRecoveryHost {
  device: WebGPUDevice;
  pipeline: RenderPipeline | null;
  scene: Scene;
  overlays: { recoveryOmissions(): DeviceRecoveryOmission[] };
  pointCloudRenderer: { hasAssets(): boolean } | null;
  recovery: {
    inFlight: Promise<DeviceRecoveryResult> | null;
    lostReferenceImages: boolean;
    quantizedBatchesRequested: boolean;
    omissions: Set<DeviceRecoveryOmission>;
  };
  deviceLost: boolean;
  destroyed: boolean;
  ready: boolean;
  initGeneration: number;
  deviceLostGeneration: number | null;
  initChain: Promise<void>;
  deviceLossSequence: number;
  deviceLostInfo: { message: string; reason: string } | null;
  rejectReadyWaiters(error: Error): void;
  teardown(clearScene?: boolean): void;
  initOnce(
    generation: number,
    options?: { clearDeviceLost?: boolean; publishReady?: boolean },
  ): Promise<void>;
  markReady(generation: number): void;
  refreshPlacementBounds(): void;
  requestRender(): void;
}

/** Internal stable error used by readiness and recovery. */
export function rendererDeviceLostError(): Error {
  const error = new Error('GPU device was lost before the renderer became ready');
  error.name = 'RendererDeviceLostError';
  return error;
}

/** Coalesce and serialize recovery with the renderer's ordinary init lifecycle. */
export function recoverRendererDevice(host: RendererRecoveryHost): Promise<DeviceRecoveryResult> {
  if (host.recovery.inFlight) return host.recovery.inFlight;
  if (!host.deviceLost) return Promise.resolve({ ok: false, reason: 'not-lost' });
  if (host.destroyed) return Promise.resolve({ ok: false, reason: 'renderer-destroyed' });

  const generation = ++host.initGeneration;
  host.ready = false;
  host.deviceLostGeneration = generation;
  host.rejectReadyWaiters(rendererDeviceLostError());
  const run = host.initChain.then(
    () => recoverRendererDeviceOnce(host, generation),
    () => recoverRendererDeviceOnce(host, generation),
  );
  host.initChain = run.then(() => undefined, () => undefined);
  host.recovery.inFlight = run;
  const clearInFlight = () => {
    if (host.recovery.inFlight === run) host.recovery.inFlight = null;
  };
  void run.then(clearInFlight, clearInFlight);
  return run;
}

async function recoverRendererDeviceOnce(
  host: RendererRecoveryHost,
  generation: number,
): Promise<DeviceRecoveryResult> {
  const lossSequence = host.deviceLossSequence;
  if (generation !== host.initGeneration || host.destroyed) {
    return { ok: false, reason: 'renderer-destroyed' };
  }
  let prepared: ReturnType<Scene['prepareDeviceRecovery']>;
  try {
    prepared = host.scene.prepareDeviceRecovery();
  } catch (error) {
    console.error('[Renderer] Failed to prepare the CPU scene for device recovery:', error);
    return { ok: false, reason: 'cold-restore-failed', error };
  }
  if (!prepared.ok) return prepared;
  if (generation !== host.initGeneration || host.destroyed) {
    return { ok: false, reason: 'renderer-destroyed' };
  }

  for (const omission of host.overlays.recoveryOmissions()) host.recovery.omissions.add(omission);
  if (host.recovery.lostReferenceImages) host.recovery.omissions.add('reference-images');
  if (host.pointCloudRenderer?.hasAssets()) host.recovery.omissions.add('point-clouds');

  let phase: 'device' | 'scene' = 'scene';
  try {
    host.scene.discardGpuResourcesForRecovery();
    host.teardown(false);
    host.device = new WebGPUDevice();
    phase = 'device';
    await host.initOnce(generation, { clearDeviceLost: false, publishReady: false });
    if (generation !== host.initGeneration || host.destroyed) {
      host.teardown(false);
      return { ok: false, reason: 'renderer-destroyed' };
    }
    if (host.deviceLossSequence !== lossSequence) {
      throw new Error('Replacement GPU device was lost during initialization');
    }
    const initializedPreparation = host.scene.prepareDeviceRecovery();
    if (!initializedPreparation.ok) {
      host.deviceLost = true;
      host.ready = false;
      host.teardown(false);
      return initializedPreparation;
    }
    if (host.recovery.quantizedBatchesRequested && host.pipeline) {
      const quantized = await host.pipeline.ensureQuantizedPipelines();
      host.scene.setQuantizedBatches(quantized);
    }
    phase = 'scene';
    if (!host.pipeline) throw new Error('Replacement render pipeline was not initialized');
    host.scene.restoreGpuResourcesAfterRecovery(host.device.getDevice(), host.pipeline);
    // A loss which settles during the synchronous restore cannot run its
    // device.lost callback until this continuation yields. Let it latch before
    // readiness is published, then revalidate because the yield also permits a
    // caller to mutate the scene.
    await Promise.resolve();
    if (generation !== host.initGeneration || host.destroyed) {
      host.teardown(false);
      return { ok: false, reason: 'renderer-destroyed' };
    }
    if (host.deviceLossSequence !== lossSequence) {
      throw new Error('Replacement GPU device was lost during scene restore');
    }
    const restoredPreparation = host.scene.prepareDeviceRecovery();
    if (!restoredPreparation.ok) {
      host.deviceLost = true;
      host.ready = false;
      host.teardown(false);
      return restoredPreparation;
    }
    // teardown(false) deliberately drops GPU-only point clouds and overlays.
    // Rebuild the authoritative bounds from the restored IFC scene before
    // readiness is observable, so fit-to-view and sections cannot retain the
    // vanished layers' extents.
    host.refreshPlacementBounds();
    host.deviceLost = false;
    host.deviceLostInfo = null;
    host.recovery.lostReferenceImages = false;
    const omissions = [...host.recovery.omissions];
    host.recovery.omissions.clear();
    host.markReady(generation);
    host.requestRender();
    return { ok: true, omissions };
  } catch (error) {
    console.error(`[Renderer] Device recovery failed during ${phase} restore:`, error);
    host.deviceLost = true;
    host.ready = false;
    try {
      host.teardown(false);
    } catch (teardownError) {
      console.warn('[Renderer] Failed to dispose a partial recovery attempt:', teardownError);
    }
    return {
      ok: false,
      reason: phase === 'device' ? 'device-init-failed' : 'scene-restore-failed',
      error,
    };
  }
}
