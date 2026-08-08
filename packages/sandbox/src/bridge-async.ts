/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host-promise delivery for bridge methods (#2305).
 *
 * A schema method whose `call` returns a Promise — `bim.clash.run` and
 * `bim.clash.matrix` are the ones that do — could not be delivered to the
 * script at all before this module existed. `marshalValue` walked the Promise
 * as an ordinary object, found no own enumerable properties, and handed the
 * script `{}`; the real work carried on unobserved on the host and, when it
 * failed, rejected with nobody listening. That is what #2305 is: a script
 * passing a `ClashElement` without its `tag` made the engine throw
 * `Cannot read properties of undefined (reading 'toUpperCase')` as an
 * *unhandled host rejection*, uncaught, killing the page's script run — while
 * the sandbox's own `try/catch` around `method.call` saw nothing, because a
 * throw inside an `async` function is a rejected promise, not a throw.
 *
 * The fix is to make the host promise a real promise inside the realm:
 * `vm.newPromise()` hands the script something it can `await`, and the host
 * settles it. Rejections then travel the sandbox's existing error channel —
 * the same `bim.<ns>.<method>: <message>` text the synchronous path throws,
 * catchable by the script and surfaced as a `ScriptError` when it is not
 * caught (`Sandbox.runEval` already renders a rejected result promise that
 * way). No second channel is introduced.
 *
 * QuickJS knows nothing about the host's microtask queue, so a deferred that
 * has been settled only propagates to the script's `.then` callbacks once
 * `executePendingJobs()` runs again. `HostWorkQueue` is what lets
 * `Sandbox.runEval` wait for the host side and re-drain the guest side, and
 * what lets `dispose()` free any deferred that never settled — an unfreed
 * resolver handle is exactly the orphan that makes `runtime.dispose()` abort
 * the whole WASM module (#1905).
 */

import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten';

/** Marshal a native JS value into the realm. Injected to keep this module free of a cycle back to bridge-schema. */
type MarshalValue = (vm: QuickJSContext, value: unknown) => QuickJSHandle;

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * The host promises created by one sandbox's bridge, and the QuickJS deferreds
 * they settle.
 *
 * Scoped to the sandbox rather than to a run because the bridge is built once
 * per sandbox; `settle()` is what bounds a single run, and it only ever waits
 * on what is in flight at the moment it is called.
 */
export class HostWorkQueue {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly deferreds = new Set<QuickJSDeferredPromise>();

  /** How many host promises have not settled yet. */
  get size(): number {
    return this.inFlight.size;
  }

  /**
   * Wait for everything currently in flight, or for `timeoutMs` to elapse.
   *
   * Returns `false` on timeout, which the caller reports as the run's own CPU
   * deadline. Without a deadline a host promise that never settles would hang
   * the run forever: the QuickJS interrupt handler only fires while *guest*
   * code is executing, and no guest code runs while the host is awaited.
   */
  async settle(timeoutMs: number): Promise<boolean> {
    const waiting = [...this.inFlight];
    if (waiting.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    try {
      return await Promise.race([Promise.all(waiting).then(() => true), expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Free every deferred that never settled.
   *
   * Called from the bridge's own `dispose()`, which `Sandbox.dispose()` runs
   * *before* `vm.dispose()` and `runtime.dispose()`. A deferred's resolve and
   * reject functions are unmanaged lifetimes: leaving one alive keeps a
   * JSObject on the runtime's GC list and makes `JS_FreeRuntime` abort the
   * WASM module for the rest of the document (#1905).
   */
  dispose(): void {
    for (const deferred of this.deferreds) {
      if (deferred.alive) deferred.dispose();
    }
    this.deferreds.clear();
    this.inFlight.clear();
  }

  private track(work: Promise<void>): void {
    const entry = work.then(
      () => { this.inFlight.delete(entry); },
      () => { this.inFlight.delete(entry); },
    );
    this.inFlight.add(entry);
  }

  private release(deferred: QuickJSDeferredPromise): void {
    this.deferreds.delete(deferred);
    if (deferred.alive) deferred.dispose();
  }

  /**
   * Hand `promise` to the realm as a real promise and return its handle.
   *
   * `label` is the `bim.<namespace>.<method>` prefix the synchronous path uses,
   * so a rejection reads identically whichever side of the boundary it came
   * from.
   */
  adopt(
    vm: QuickJSContext,
    promise: PromiseLike<unknown>,
    label: string,
    marshalValue: MarshalValue,
  ): QuickJSHandle {
    const deferred = vm.newPromise();
    this.deferreds.add(deferred);
    this.track(
      Promise.resolve(promise)
        .then(
          (value) => { settleResolved(vm, deferred, value, label, marshalValue); },
          (err) => { settleRejected(vm, deferred, err, label); },
        )
        .catch((err: unknown) => {
          // Reaching here means settling itself failed — a dead realm, or a
          // value that could not be marshalled after the rejection path had
          // already run. Reported rather than swallowed (house rule), and
          // absorbed rather than rethrown: rethrowing would recreate the
          // unhandled host rejection this module exists to remove.
          console.warn(`[ifc-lite/sandbox] ${label}: host result could not be delivered into the sandbox`, err);
        })
        .finally(() => { this.release(deferred); }),
    );
    return deferred.handle;
  }
}

function settleResolved(
  vm: QuickJSContext,
  deferred: QuickJSDeferredPromise,
  value: unknown,
  label: string,
  marshalValue: MarshalValue,
): void {
  if (!deferred.alive || !vm.alive) return;
  let handle: QuickJSHandle;
  try {
    handle = marshalValue(vm, value);
  } catch (err) {
    // A result that cannot cross the boundary (a cyclic graph past the depth
    // guard, a throwing getter) is a failure of this call, not of the sandbox:
    // report it to the script on the same channel as any other failure.
    settleRejected(vm, deferred, err, label);
    return;
  }
  try {
    deferred.resolve(handle);
  } finally {
    // `resolve` copies into the realm; the handle is ours to free.
    handle.dispose();
  }
}

function settleRejected(
  vm: QuickJSContext,
  deferred: QuickJSDeferredPromise,
  err: unknown,
  label: string,
): void {
  if (!deferred.alive || !vm.alive) return;
  const message = err instanceof Error ? err.message : String(err);
  const handle = vm.newError(`${label}: ${message}`);
  try {
    deferred.reject(handle);
  } finally {
    handle.dispose();
  }
}
