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
 * - `[WebGPU] Device lost: … (reason: …)` from packages/renderer/src/device.ts,
 *   with ANY reason. CI's traces show Dawn reporting an instance drop either
 *   as `unknown` ("A valid external Instance reference no longer exists.") or
 *   as `destroyed` ("Device was destroyed."), and in the second shape that is
 *   the ONLY loss line the page logs (run 36602083993: mobile-long-press and
 *   the swept-disk specs). The renderer treats `destroyed` as a teardown and
 *   does not recover, so the view stays dead either way: every reason counts
 *   as a loss here. A teardown line on a healthy page cannot turn a failure
 *   into a skip, because `requireLiveGpu` and the per-spec guards skip only
 *   after the rendering-dependent step has itself failed (the one exception,
 *   `skipIfLost`, is an explicit pre-check a spec opts into),
 * - `[Renderer] GPU device lost` from the renderer's `handleDeviceLost`,
 * - `[Viewport] GPU device lost:` and its toast from
 *   apps/viewer/src/components/viewer/device-loss-report.ts,
 * - the follow-on Dawn errors the loss produces (`popErrorScope rejected
 *   (device likely lost)`, `A valid external Instance reference no longer
 *   exists`).
 *
 * Skips happen only when `E2E_GPU_STRICT=0` and loss evidence exists; a strict
 * run (a real GPU) never skips and still fails, with the loss evidence
 * annotated.
 *
 * `E2E_FORCE_DEVICE_LOSS=1|destroyed` reproduces the CI fault in any spec that
 * calls {@link watchGpuDeviceLoss}: the first WebGPU device is destroyed right
 * after the viewer gets it and reports a loss with reason `unknown` (`1`) or
 * `destroyed` (`destroyed`, the shape that broke the first version of this
 * helper), and every later `requestDevice` rejects, so recovery fails the way
 * it does after Dawn drops the instance.
 */
import { test, type Page } from '@playwright/test';

/** `false` under hosted software WebGPU (CI sets `E2E_GPU_STRICT=0`). */
export const GPU_STRICT = process.env.E2E_GPU_STRICT !== '0';

/** Console lines the viewer and renderer log on a real (non-teardown) device loss. */
export const DEVICE_LOST_SIGNAL =
  /\[WebGPU\] Device lost:|\[Renderer\] GPU device lost|\[Viewport\] GPU device lost:|popErrorScope rejected \(device likely lost\)|A valid external Instance reference no longer exists/;

/**
 * The load error the viewer files in `state.error` when the device dies while a
 * point cloud is loading (`useIfcLoader.ts`, `renderer_device_lost`): the Add
 * path never registers the new model, so this string is the ONLY page-state
 * trace of the loss and a `loadState` wait would otherwise hang to its timeout.
 */
export const DEVICE_LOST_LOAD_ERROR = /The graphics device was lost during the load/;

/** What a load wait should test against `state.error`: the console signals plus {@link DEVICE_LOST_LOAD_ERROR}. */
export const DEVICE_LOST_STATE_ERROR = new RegExp(`${DEVICE_LOST_SIGNAL.source}|${DEVICE_LOST_LOAD_ERROR.source}`);

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

/** Log (and return) the standard note for a GPU-only assertion a non-strict run leaves to the strict witness. */
export function noteSoftwareGpuSkip(what: string): void {
  console.log(`[e2e] E2E_GPU_STRICT=0 - skipping ${what} (software WebGPU)`);
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
  /**
   * Run a wait that can only succeed on a live device (a load that settles, a
   * poll on resident points) and skip the moment the console reports a loss,
   * instead of letting the wait run to its own timeout (#7008: a load wait that
   * never settled after the device died cost 120 s per spec, and several such
   * specs pushed `Viewer E2E smoke (1/2)` past its 13-minute budget).
   *
   * Non-strict only. A strict run (real GPU) just awaits `run`, so a loss there
   * still fails with the step's own error. A wait that wins the race is returned
   * untouched, so a surviving device still runs every assertion in `run`.
   */
  raceLoss<T>(stage: string, run: () => Promise<T>): Promise<T>;
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
  let announceLoss!: (found: string) => void;
  // Never rejects, so an unraced loss leaves nothing unhandled.
  const lossSignal = new Promise<string>((resolve) => { announceLoss = resolve; });
  page.on('console', (message) => {
    const text = message.text();
    if (evidence === null && DEVICE_LOST_SIGNAL.test(text)) {
      evidence = text.slice(0, 300);
      announceLoss(evidence);
    }
  });
  const forced = process.env.E2E_FORCE_DEVICE_LOSS;
  if (forced === '1' || forced === 'destroyed') {
    await page.addInitScript(forceDeviceLoss, { message: FORCED_LOSS_MESSAGE, reason: forced === 'destroyed' ? 'destroyed' : 'unknown' });
  }

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
    async raceLoss(stage, run) {
      if (GPU_STRICT) return run();
      const pending = run();
      // If the loss wins, `run` is abandoned and the skip closes the page, so its
      // eventual rejection is expected and must not surface as unhandled.
      pending.catch(() => undefined);
      const found = await Promise.race([pending.then(() => null, () => null), lossSignal]);
      if (found !== null) {
        test.info().annotations.push({ type: 'gpu-device-lost', description: `${stage}: ${found}` });
        skipForGpuDeviceLoss(stage, found);
      }
      return pending;
    },
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
function forceDeviceLoss({ message, reason }: { message: string; reason: string }): void {
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
      settle({ reason, message });
    }, 0);
    return device;
  };
}
