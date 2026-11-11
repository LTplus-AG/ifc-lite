/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When the viewer may prepare its runtime before the first file (fixed load
 * floor): never on a browser that reports under 4 GB of device memory or asks
 * to save data, never while the tab is hidden, and only once the main thread is
 * idle. Each piece has its own kill switch.
 */

interface WarmRuntimeEnvironment {
  readonly disabled: boolean;
  readonly deviceMemoryGB?: number;
  readonly saveData?: boolean;
}

/** Why this browser must not warm up early, or null when it may. */
export function warmRuntimeRefusal(env: WarmRuntimeEnvironment): 'disabled' | 'save-data' | 'low-memory' | null {
  if (env.disabled) return 'disabled';
  if (env.saveData === true) return 'save-data';
  if (env.deviceMemoryGB !== undefined && env.deviceMemoryGB < 4) return 'low-memory';
  return null;
}

/** This browser's environment; `killSwitch` is the raw value of the piece's perf flag. */
export function warmRuntimeEnvironment(killSwitch: unknown): WarmRuntimeEnvironment {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return { disabled: killSwitch === 0 || killSwitch === false, deviceMemoryGB: nav.deviceMemory, saveData: nav.connection?.saveData };
}

/**
 * Wait for a visible tab and an idle main thread, then call `run`. Returns a
 * cancel function; `run` is never called after it ran.
 */
export function scheduleWhenIdle(run: () => void): () => void {
  let cancelled = false;
  let idleHandle: number | undefined;
  const fire = () => {
    idleHandle = undefined;
    if (cancelled) return;
    if (document.visibilityState !== 'visible') { arm(); return; }
    run();
  };
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    arm();
  };
  const arm = () => {
    if (cancelled) return;
    if (document.visibilityState !== 'visible') { document.addEventListener('visibilitychange', onVisible); return; }
    idleHandle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(fire, { timeout: 4000 })
      : window.setTimeout(fire, 1500);
  };
  arm();
  return () => {
    cancelled = true;
    document.removeEventListener('visibilitychange', onVisible);
    if (idleHandle === undefined) return;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleHandle);
    else window.clearTimeout(idleHandle);
  };
}
