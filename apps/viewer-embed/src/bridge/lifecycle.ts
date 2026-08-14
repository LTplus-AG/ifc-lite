/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StrictMode-safe mount/unmount guard for the postMessage bridge.
 *
 * React 19's <React.StrictMode> double-invokes effects in development:
 * mount -> cleanup -> mount. `EmbedViewer`'s bridge-init effect guards the
 * MOUNT side with a ref ("already initialized? skip"), but the guard must
 * also be reset on the CLEANUP side -- otherwise the StrictMode remount
 * sees the guard still flipped, skips re-init, and the bridge is left
 * permanently dead (listener removed, never re-added) even though the
 * component is mounted and alive.
 *
 * This is deliberately plain TS (no JSX) so it can be unit-tested under
 * this package's `src/**\/*.test.ts`-only vitest include glob, which does
 * not collect `.tsx` test files.
 */

export interface MountGuardRef {
  current: boolean;
}

/**
 * Run `init` only if the guard is not already set. Pair with
 * `unmountBridgeLifecycle` using the SAME ref so a StrictMode
 * cleanup+remount correctly re-initializes instead of leaving the bridge
 * dead.
 */
export function mountBridgeLifecycle(ref: MountGuardRef, init: () => void): void {
  if (ref.current) return;
  ref.current = true;
  init();
}

/**
 * Tear down only if `mountBridgeLifecycle` actually ran `init` for this
 * guard (idempotent: unmounting a never-mounted guard is a no-op).
 */
export function unmountBridgeLifecycle(ref: MountGuardRef, destroy: () => void): void {
  if (!ref.current) return;
  // Reset the guard BEFORE tearing down so a StrictMode cleanup+remount
  // (mount -> cleanup -> mount, all synchronous) sees an unset guard on the
  // second mount and correctly re-initializes, instead of finding the guard
  // still flipped `true` and skipping init forever.
  ref.current = false;
  destroy();
}
