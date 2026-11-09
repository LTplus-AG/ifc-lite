/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-device upstream state of the Gaussian layer (#8564): one luma backend and
 * one scene per viewer GPUDevice. Replacing the device drops both; a failed
 * backend load is forgotten so the next add retries it.
 */

import type { GaussianBackend, GaussianBackendFactory, GaussianBackendScene } from './gaussian-backend.js';
import { GaussianSplatError } from './gaussian-errors.js';
import type { GaussianUpstreamStatus } from './gaussian-readiness.js';

export class GaussianDeviceSlot {
  upstream: GaussianUpstreamStatus = 'unknown';
  /** The loaded backend has the depth-interval hook of the nearest-glass split (#8564). */
  depthInterval = false;
  private backend: { device: GPUDevice; promise: Promise<GaussianBackend> } | null = null;
  private current: { device: GPUDevice; scene: GaussianBackendScene } | null = null;

  constructor(private readonly adapter: () => GPUAdapter | null, private readonly createBackend: GaussianBackendFactory) {}

  get scene(): GaussianBackendScene | null { return this.current?.scene ?? null; }

  /** Whether the current scene lives on `device`. */
  owns(device: GPUDevice | null): boolean { return device !== null && this.current?.device === device; }

  backendFor(device: GPUDevice): Promise<GaussianBackend> {
    if (this.backend?.device !== device) {
      // luma's listener sees every uncaptured error of the shared device, not only Gaussian ones.
      const promise = this.createBackend(device, this.adapter(), (error) => console.error('[WebGPU] uncaptured device error (via the Gaussian adapter):', error))
        .catch((error: unknown) => {
          throw error instanceof GaussianSplatError ? error : new GaussianSplatError('upstream-unavailable', `Upstream Gaussian renderer failed to load: ${String(error)}`);
        });
      promise.then((backend) => {
        if (this.backend?.promise !== promise) return;
        this.upstream = backend.upstreamReverseZ ? 'available' : 'missing';
        this.depthInterval = backend.upstreamDepthInterval === true;
      }, () => { if (this.backend?.promise === promise) { this.backend = null; this.upstream = 'unknown'; this.depthInterval = false; } });
      this.backend = { device, promise };
    }
    return this.backend.promise;
  }

  /** The scene for `device`; `created` tells the caller nothing has been uploaded to it yet. */
  sceneFor(device: GPUDevice, backend: GaussianBackend): { scene: GaussianBackendScene; created: boolean } {
    if (this.current?.device === device) return { scene: this.current.scene, created: false };
    this.current?.scene.destroy();
    this.current = { device, scene: backend.createScene() };
    return { scene: this.current.scene, created: true };
  }

  /** Release the scene's upstream allocations; never the viewer device or its attachments. */
  dropScene(): void {
    this.current?.scene.destroy();
    this.current = null;
  }

  dropAll(): void {
    this.dropScene();
    this.backend = null;
  }
}
