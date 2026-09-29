/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared hosted-GPU device-loss handling for viewer E2E specs (#6232 F3).
 *
 * CI runs Chrome on SwiftShader WebGPU (`E2E_GPU_STRICT=0`), and Dawn can drop
 * that device at any moment ("A valid external Instance reference no longer
 * exists.", reason `unknown`). Once it does, the viewer stops drawing and never
 * uploads the model's meshes, so any step that needs rendering (a scene face
 * hit, a GPU pick, a colour frame) fails for a reason that has nothing to do
 * with the change under test. Specs used to hand-roll a console listener and a
 * skip around one step each, and a step they missed (the face search in
 * mobile-long-press) flaked unrelated PRs.
 *
 * The signal is the viewer's own fault path, not a guess:
 * - `[WebGPU] Device lost: … (reason: <not destroyed>)` from
 *   packages/renderer/src/device.ts,
 * - `[Renderer] GPU device lost` from the renderer's `handleDeviceLost`,
 * - `[Viewport] GPU device lost:` and its toast from
 *   apps/viewer/src/components/viewer/device-loss-report.ts.
 * `reason: destroyed` alone is NOT a loss: the renderer tears its own device
 * down that way (re-init, recovery, page close) and ignores it, so a spec must
 * not skip on it.
 *
 * Skips happen only when `E2E_GPU_STRICT=0` and the device really was lost; a
 * strict run (a real GPU) still fails, with the loss evidence annotated.
 *
 * `E2E_FORCE_DEVICE_LOSS=1` reproduces the CI fault in any spec that calls
 * {@link watchGpuDeviceLoss}: the first WebGPU device reports an `unknown`-
 * reason loss right after the viewer gets it, and every later `requestDevice`
 * rejects, so the viewer's recovery fails the way it does after Dawn drops the
 * instance.
 */
import { test, type Page } from '@playwright/test';

/** `false` under hosted software WebGPU (CI sets `E2E_GPU_STRICT=0`). */
export const GPU_STRICT = process.env.E2E_GPU_STRICT !== '0';

/** Console lines the viewer and renderer log on a real (non-teardown) device loss. */
export const DEVICE_LOST_SIGNAL =
  /\[WebGPU\] Device lost:(?!.*\(reason: destroyed\))|\[Renderer\] GPU device lost|\[Viewport\] GPU device lost:/;

/** The toast `reportDeviceLost` shows (device-loss-report.ts). */
export const DEVICE_LOST_TOAST = 'The graphics device was lost, so the 3D view has stopped drawing.';

const FORCED_LOSS_MESSAGE = 'A valid external Instance reference no longer exists. (E2E_FORCE_DEVICE_LOSS)';

/**
 * Skip the running test because the hosted software GPU lost its device.
 * No-op in a strict run, so the caller's `throw` still fails the test there.
 */
export function skipForGpuDeviceLoss(stage: string, evidence: string): void {
  if (GPU_STRICT) return;
  const reason = `Hosted software WebGPU device was lost before/during ${stage}: ${evidence}`;
  console.warn(`[e2e] E2E_GPU_STRICT=0 - skipping: ${reason}`);
  test.skip(true, reason);
}

export interface GpuDeviceLossWatch {
  /** The first device-loss console line this page logged, or `null`. */
  readonly evidence: string | null;
  /**
   * Console evidence, else the viewer's device-loss toast on screen. Waits up
   * to `graceMs` for a loss that is still being reported: a step can fail a
   * moment before the `device.lost` promise's log reaches the test.
   */
  lost(graceMs?: number): Promise<string | null>;
  /** Skip now (non-strict only) when the device has already been lost. */
  skipIfLost(stage: string): Promise<void>;
  /**
   * Run a step that needs a live GPU device. If it throws and the device was
   * lost, skip (non-strict) with the evidence; otherwise rethrow unchanged.
   */
  requireLiveGpu<T>(stage: string, run: () => Promise<T>): Promise<T>;
}

/**
 * Start watching `page` for device loss. Call before `page.goto` so a loss
 * during load is seen.
 */
export async function watchGpuDeviceLoss(page: Page): Promise<GpuDeviceLossWatch> {
  let evidence: string | null = null;
  page.on('console', (message) => {
    const text = message.text();
    if (evidence === null && DEVICE_LOST_SIGNAL.test(text)) evidence = text.slice(0, 300);
  });
  if (process.env.E2E_FORCE_DEVICE_LOSS === '1') await page.addInitScript(forceDeviceLoss, FORCED_LOSS_MESSAGE);

  const lost = async (graceMs = 0): Promise<string | null> => {
    const deadline = Date.now() + graceMs;
    for (;;) {
      if (evidence !== null) return evidence;
      const toast = page.locator('[data-toast-seq]').filter({ hasText: DEVICE_LOST_TOAST });
      if (!page.isClosed() && await toast.count().catch(() => 0) > 0) return `toast: ${DEVICE_LOST_TOAST}`;
      if (Date.now() >= deadline || page.isClosed()) return null;
      await page.waitForTimeout(100);
    }
  };

  return {
    get evidence() { return evidence; },
    lost,
    async skipIfLost(stage) {
      const found = await lost();
      if (found !== null) skipForGpuDeviceLoss(stage, found);
    },
    async requireLiveGpu(stage, run) {
      try {
        return await run();
      } catch (error) {
        const found = await lost(1_000);
        if (found !== null) {
          test.info().annotations.push({ type: 'gpu-device-lost', description: `${stage}: ${found}` });
          skipForGpuDeviceLoss(stage, found);
        }
        throw error;
      }
    },
  };
}

/**
 * Browser-side fault injection (runs as an init script). Serialised by
 * Playwright, so it must be self-contained.
 */
function forceDeviceLoss(message: string): void {
  const adapter = (globalThis as { GPUAdapter?: { prototype: { requestDevice(...args: unknown[]): Promise<{ destroy(): void }> } } }).GPUAdapter;
  if (!adapter) return;
  const requestDevice = adapter.prototype.requestDevice;
  let issued = false;
  adapter.prototype.requestDevice = async function (this: unknown, ...args: unknown[]) {
    // Recovery must fail too: after Dawn drops the instance no new device comes back.
    if (issued) throw new DOMException(message, 'OperationError');
    issued = true;
    const device = await requestDevice.apply(this, args);
    let settle!: (info: { reason: string; message: string }) => void;
    const lost = new Promise<{ reason: string; message: string }>((resolve) => { settle = resolve; });
    Object.defineProperty(device, 'lost', { configurable: true, get: () => lost });
    setTimeout(() => {
      device.destroy();
      settle({ reason: 'unknown', message });
    }, 0);
    return device;
  };
}
