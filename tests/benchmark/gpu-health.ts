/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-sample GPU device health (#6993, folding in #7164).
 *
 * Under SwiftShader (CI, WSL, the ARM/x86 qualification runners) Chromium can
 * lose the WebGPU device, or the Dawn instance behind it, mid-load. The
 * renderer then re-creates its device and re-uploads the whole scene, so the
 * sample measured a different load. Such a sample is flagged `contaminated`
 * and consumers keep it out of every median, baseline and verdict instead of
 * averaging it with clean ones.
 *
 * Two independent witnesses, so a base build that predates the counters is
 * still classified:
 *   - the viewer's session counters (`gpu.devices`, `gpu.deviceLost`,
 *     `gpu.uncapturedErrors`, see packages/renderer/src/gpu-counters.ts), read
 *     from `__IFC_LITE_LOAD_TRACE__.sessionCounters()`: totals since boot, so a
 *     loss before the load window opens is still seen;
 *   - the console lines the renderer and Chromium print for the same events.
 * Both see one loss once, so each count is the larger of the two, never the sum.
 *
 * Uncaptured errors and Dawn "Instance reference no longer exists" errors are
 * reported but do not by themselves contaminate a sample. Measured on WSL
 * SwiftShader (FZK, Snowdon): every sample logs one, from a pipeline probe on
 * a device already destroyed before the load, while the renderer's own device
 * lives on and renders. Only the renderer losing its device, or re-creating
 * it, changes the work the sample measured.
 */

export interface GpuHealth {
  /** True when this sample must not be averaged with clean samples. */
  contaminated: boolean;
  /** Human-readable causes, empty when clean. */
  reasons: string[];
  /** `device.lost` settlements for any reason but `destroyed`. */
  deviceLost: number;
  /**
   * True when `deviceLost` may undercount: it merges log sites (one loss is
   * printed by up to three of them), so two distinct losses printed only at
   * different sites read as one. False only when the `gpu.deviceLost` counter
   * agrees with every site that reported. Contamination is unaffected.
   */
  deviceLostIsLowerBound: boolean;
  /** Lines where Chromium/Dawn reported the WebGPU instance gone (#7164); evidence, not a verdict. */
  instanceErrors: number;
  /** Devices the renderer created; null when the build exposes no counters. */
  devicesCreated: number | null;
  uncapturedErrors: number;
  /** Which witnesses were available. */
  source: 'counters+console' | 'console';
  /** The matching console lines, capped, for the evidence trail. */
  events: string[];
}

/**
 * Every line the renderer and viewer print when the renderer's device is lost,
 * in one place (#6993 review): each names its own log site. A loss surfaces
 * through one or more of them, so per sample the loss count is the largest
 * per-format count, never their sum. `destroyed` is intentional teardown.
 */
export const DEVICE_LOSS_LOG_FORMATS: ReadonlyArray<{ site: string; pattern: RegExp; reason?: number }> = [
  // packages/renderer/src/device.ts: the `device.lost` promise (Chromium).
  { site: 'WebGPUDevice.lost', pattern: /\[WebGPU\] Device lost:.*\(reason: ([\w-]+)\)/, reason: 1 },
  // packages/renderer/src/index.ts `handleDeviceLost`: also synchronous losses
  // (Safari throws, upload exceptions) that never settle `device.lost`.
  { site: 'Renderer.handleDeviceLost', pattern: /\[Renderer\] GPU device lost — halting rendering until re-init:/ },
  // apps/viewer/src/components/viewer/device-loss-report.ts: once per episode.
  { site: 'reportDeviceLost', pattern: /\[Viewport\] GPU device lost:/ },
];
const INSTANCE_LOST = /valid external Instance reference no longer exists/i;
const UNCAPTURED = /\[WebGPU\] Uncaptured error:/;
const MAX_EVENTS = 20;

/** Which loss format a console line is, or null; `destroyed` teardown lines are not losses. */
export function deviceLossFormat(line: string): string | null {
  for (const { site, pattern, reason } of DEVICE_LOSS_LOG_FORMATS) {
    const match = pattern.exec(line);
    if (match && (reason === undefined || match[reason] !== 'destroyed')) return site;
  }
  return null;
}

export function gpuHealthFrom(
  consoleLogs: readonly string[],
  sessionCounters: Readonly<Record<string, number>> | null,
): GpuHealth {
  const lossesBySite = new Map<string, number>();
  let instanceErrors = 0;
  let consoleUncaptured = 0;
  const events: string[] = [];
  for (const line of consoleLogs) {
    const site = deviceLossFormat(line);
    const isLoss = site !== null;
    // Loss lines quote the same message, and a destroyed-teardown line is no
    // instance error either; count that event once, as the loss.
    const isInstance = !isLoss && !DEVICE_LOSS_LOG_FORMATS[0].pattern.test(line) && INSTANCE_LOST.test(line);
    const isUncaptured = UNCAPTURED.test(line);
    if (site) lossesBySite.set(site, (lossesBySite.get(site) ?? 0) + 1);
    if (isInstance) instanceErrors++;
    if (isUncaptured) consoleUncaptured++;
    if ((isLoss || isInstance || isUncaptured) && events.length < MAX_EVENTS) events.push(line.slice(0, 300));
  }
  const consoleLost = Math.max(0, ...lossesBySite.values());
  const counter = (name: string) => sessionCounters?.[name] ?? 0;
  const deviceLost = Math.max(consoleLost, counter('gpu.deviceLost'));
  const deviceLostIsLowerBound = deviceLost > 0 &&
    (sessionCounters === null || [...lossesBySite.values()].some((n) => n !== counter('gpu.deviceLost')));
  const uncapturedErrors = Math.max(consoleUncaptured, counter('gpu.uncapturedErrors'));
  const devicesCreated = sessionCounters ? counter('gpu.devices') : null;

  const reasons: string[] = [];
  if (deviceLost > 0) reasons.push(`GPU device lost ${deviceLostIsLowerBound ? '≥' : ''}${deviceLost}x`);
  if (devicesCreated !== null && devicesCreated > 1) reasons.push(`renderer re-created its GPU device (${devicesCreated} devices): scene re-uploaded`);
  return {
    contaminated: reasons.length > 0,
    reasons,
    deviceLost,
    deviceLostIsLowerBound,
    instanceErrors,
    devicesCreated,
    uncapturedErrors,
    source: sessionCounters ? 'counters+console' : 'console',
    events,
  };
}

/** Where the viewer publishes its trace API under `?perfTrace=1`. */
const LOAD_TRACE_GLOBAL = '__IFC_LITE_LOAD_TRACE__';

/** The one Playwright `Page` method this needs, so tests can pass a stub. */
export interface EvaluatingPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/** Session counter totals, or null when the build exposes none (tracing off, or a pre-#6993 base). */
export async function readSessionCounters(page: EvaluatingPage): Promise<Record<string, number> | null> {
  try {
    return await page.evaluate((key: string) => {
      const api = (globalThis as Record<string, unknown>)[key] as { sessionCounters?: () => Record<string, number> } | undefined;
      return typeof api?.sessionCounters === 'function' ? api.sessionCounters() : null;
    }, LOAD_TRACE_GLOBAL);
  } catch (error) {
    // A crashed page or lost context cannot answer; the console witness still can.
    console.warn('[Benchmark] could not read session counters', error);
    return null;
  }
}

export async function readGpuHealth(page: EvaluatingPage, consoleLogs: readonly string[]): Promise<GpuHealth> {
  return gpuHealthFrom(consoleLogs, await readSessionCounters(page));
}
