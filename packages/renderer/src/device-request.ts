/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer's adapter + device request, and an early copy of it.
 *
 * A device needs no canvas, and on a fresh page it is the slowest part of
 * bringing a renderer up (~150-250 ms in the GPU process). A host that knows a
 * renderer is about to mount, because the user just picked a file, calls
 * {@link prerequestRendererDevice}: the request then runs while the page resets
 * its interface and mounts the viewport, and the next `WebGPUDevice.init()`
 * adopts the result instead of starting its own. Nothing is requested at idle.
 */

import { requestAdapterWithTimeout } from './adapter-request.js';

export interface RequestedRendererDevice {
  adapter: GPUAdapter;
  device: GPUDevice;
}

/**
 * Request the adapter, then a device carrying the adapter's buffer limits and,
 * when advertised, `timestamp-query`. The two asks degrade one at a time, most
 * wanted first:
 *
 *  - `requiredLimits` is load-bearing for rendering at all: without the raise,
 *    a large IFC's vertex buffer exceeds the 256 MiB default maxBufferSize and
 *    nothing renders.
 *  - `requiredFeatures` is opt-in diagnostics (issue #2670): it does nothing
 *    until a caller constructs a GpuFrameTimingRecorder.
 *
 * A rejection of the full request is retried with the limits alone, and only a
 * rejection of that reaches the bare last-resort request.
 */
export async function requestRendererDevice(gpu: GPU): Promise<RequestedRendererDevice> {
  const adapter = await requestAdapterWithTimeout(gpu);
  if (!adapter) {
    throw new Error('Failed to get GPU adapter');
  }

  const limits = adapter.limits;
  const requiredLimits: Record<string, number> = {};
  if (limits?.maxBufferSize) {
    requiredLimits.maxBufferSize = limits.maxBufferSize;
  }
  if (limits?.maxStorageBufferBindingSize) {
    requiredLimits.maxStorageBufferBindingSize = limits.maxStorageBufferBindingSize;
  }
  // Only advertised features: asking for one the adapter lacks rejects the request.
  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features?.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query');
  }

  let device: GPUDevice | null = null;
  // Stage 1: everything we want.
  try {
    device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
  } catch (e) {
    if (requiredFeatures.length > 0) {
      console.warn(
        '[WebGPU] requestDevice() rejected the request carrying requiredFeatures; ' +
          'retrying with the buffer limits alone (GPU timestamp queries unavailable):',
        e,
      );
    }
  }
  // Stage 2: drop the optional feature, KEEP the limits. Skipped when no feature
  // was requested: the request would be identical to the one that just failed.
  if (!device && requiredFeatures.length > 0) {
    try {
      device = await adapter.requestDevice({ requiredLimits });
    } catch (e) {
      console.warn('[WebGPU] requestDevice() also rejected the limits-only request:', e);
    }
  }
  // Stage 3, last resort: some drivers reject limits they advertise. Logged,
  // because without the raised limits a large model can fail to render.
  if (!device) {
    console.warn(
      '[WebGPU] falling back to a default device with no required limits — ' +
        'a large model may exceed the default maxBufferSize and fail to render.',
    );
    device = await adapter.requestDevice();
  }
  return { adapter, device };
}

/** How long an early device waits for a renderer before it is destroyed. */
export const PREREQUESTED_DEVICE_HOLD_MS = 15_000;

interface EarlyRequest {
  result: Promise<RequestedRendererDevice | null>;
  lost: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

let early: EarlyRequest | null = null;

/**
 * Start the renderer's device request now, for the next `WebGPUDevice.init()`.
 * Returns false (and does nothing) when one is already pending or WebGPU is
 * absent. A device no renderer claims within `holdMs` is destroyed, so a load
 * that fails before its viewport mounts holds it only briefly.
 */
export function prerequestRendererDevice(holdMs = PREREQUESTED_DEVICE_HOLD_MS): boolean {
  const gpu = (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu;
  if (early || !gpu) return false;
  const entry: EarlyRequest = {
    result: Promise.resolve(null),
    lost: false,
    expiry: setTimeout(() => {
      if (early !== entry) return;
      early = null;
      void entry.result.then((requested) => requested?.device.destroy());
    }, holdMs),
  };
  entry.result = requestRendererDevice(gpu).then((requested) => {
    // A loss before the claim: the renderer must request a fresh device.
    void requested.device.lost?.then(() => { entry.lost = true; });
    return requested;
  }, (err: unknown) => {
    console.warn('[WebGPU] early device request failed; the renderer will request its own:', err);
    return null;
  });
  early = entry;
  return true;
}

/**
 * The pending early device, taken once (null when none is pending). Resolves
 * null when that request failed or its device was lost meanwhile: the caller
 * then requests its own.
 */
export function claimPrerequestedRendererDevice(): Promise<RequestedRendererDevice | null> | null {
  const entry = early;
  if (!entry) return null;
  early = null;
  clearTimeout(entry.expiry);
  return entry.result.then((requested) => {
    if (requested && !entry.lost) return requested;
    requested?.device.destroy();
    return null;
  });
}
