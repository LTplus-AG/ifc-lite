/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When the viewer may prepare its runtime before the first file (fixed load
 * floor): never on a browser that reports under 4 GB of device memory or asks
 * to save data, never while the tab is hidden, and only once the main thread is
 * idle. Each piece has its own kill switch. Loaded lazily by each piece, so
 * none of this is in the viewer's entry chunk.
 */

/** A perf flag's raw value turns its piece off: `0`/`false`, as a URL string (`?perf.warmShell=0`) or a value. */
function switchedOff(raw: unknown): boolean {
  return raw === 0 || raw === false || raw === '0' || raw === 'false';
}

/**
 * Whether this browser may warm up before the first file. `killSwitch` is the
 * raw value of the piece's perf flag; the rest is read from `navigator`.
 */
export function mayWarmUp(killSwitch: unknown, nav: Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } } = navigator): boolean {
  if (switchedOff(killSwitch) || nav.connection?.saveData === true) return false;
  return nav.deviceMemory === undefined || nav.deviceMemory >= 4;
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
