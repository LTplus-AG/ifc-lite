/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which QuickJS WASM module instance backs new sandboxes, and how a poisoned
 * one is retired (#1922).
 *
 * ## Why this exists
 *
 * An out-of-memory raised inside a *drained promise job* leaves objects
 * orphaned on `rt->gc_obj_list` with leaked refcounts, and upstream
 * `JS_FreeRuntime` asserts that list is empty — so `runtime.dispose()` comes
 * back as `Aborted(Assertion failed: list_empty(&rt->gc_obj_list))`. That is
 * an emscripten `abort()`, which latches a module-wide `ABORT` flag. The abort
 * itself is upstream and not preventable from here; what *is* ours is which
 * module the next sandbox runs on.
 *
 * The package used to hand every sandbox the process-wide singleton behind
 * `getQuickJS()`, so one bad script poisoned scripting for the rest of the
 * document. Two measured consequences, both gone once the module is replaced:
 *
 * - The latch is per module instance, so after the first abort **no later
 *   teardown failure on that module can report itself**: a second runtime left
 *   in exactly the same broken state disposes "successfully" while silently
 *   leaking whatever `JS_FreeRuntime` had not reached. Measured directly, two
 *   runtimes poisoned identically: `#1 -> ABORT`, `#2 -> CLEAN`.
 * - `getQuickJS()` memoizes its module in an upstream module-level variable,
 *   so the poisoned instance and its heap are pinned for the life of the
 *   process even after the last sandbox using it is gone.
 *
 * ## What this does
 *
 * `acquireQuickJSModule()` owns the cache instead of upstream: it is
 * `newQuickJSWASMModule()` behind the same de-duplicating promise, so first
 * load is byte-for-byte the previous behaviour (`getQuickJS()` is itself only
 * a memoized `newQuickJSWASMModule()`). `retireQuickJSModule()` drops the
 * cache when a teardown abort proves the module is poisoned, so the *next*
 * `Sandbox.init()` instantiates a fresh one — measured at 1-5 ms and ~1-2 MB,
 * and only ever on this path. Sandboxes still holding runtimes on the retired
 * module keep working (measured), but their teardown can no longer report a
 * failure, so `isQuickJSModuleRetired()` lets a host recreate them instead.
 *
 * Retiring also *unpins* the poisoned module: nothing here holds it once the
 * last sandbox on it is released, which the upstream singleton never allowed.
 *
 * This is the same shape `@ifc-lite/geometry`'s `recordWasmRuntimeTrap` settled
 * on for #1898: drop the poisoned handle so the next `init()` builds a clean
 * one, let the failing operation fail loudly with its own error, and do *not*
 * latch a realm-wide refusal — that version bricked every unrelated consumer
 * after one failure, and it is what the pre-flight checks removed from
 * `useSandbox` / `sandbox-factory` were doing here.
 */

import { newQuickJSWASMModule, type QuickJSWASMModule } from 'quickjs-emscripten';

/** Cached WASM module promise — de-duplicates concurrent init calls. */
let modulePromise: Promise<QuickJSWASMModule> | null = null;
/** Resolved value of `modulePromise`, so a retire can identify what it holds. */
let activeModule: QuickJSWASMModule | null = null;
/**
 * Weak so a retired module is collectable once the sandboxes still running on
 * it are released — the whole point of not leaving it in upstream's singleton.
 */
const retiredModules = new WeakSet<QuickJSWASMModule>();
let runtimeAborted = false;

/**
 * The module instance new sandboxes should run on, loading it if needed.
 *
 * Concurrent callers share one load. A load that *fails* clears the cache so
 * the next caller retries, rather than every later `init()` inheriting one
 * transient fetch failure forever.
 */
export function acquireQuickJSModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    const pending: Promise<QuickJSWASMModule> = newQuickJSWASMModule().then((module) => {
      // "Adopt only if still the cached load." Defensive rather than
      // load-bearing today: `retireQuickJSModule` only clears the cache for
      // the module it already holds as active, and `activeModule` is null for
      // the whole of an in-flight load, so nothing can currently reassign
      // `modulePromise` between here and the line above. Kept because the
      // alternative — an unconditional assignment — turns any future third
      // writer of `modulePromise` into a silently resurrected retired module,
      // and this costs one reference comparison per load.
      if (modulePromise === pending) activeModule = module;
      return module;
    });
    pending.catch(() => {
      if (modulePromise === pending) modulePromise = null;
    });
    modulePromise = pending;
  }
  return modulePromise;
}

/**
 * Stop handing `module` to new sandboxes — its emscripten `ABORT` latch has
 * fired, so nothing running on it can report a teardown failure any more.
 *
 * Idempotent, and a no-op for `null` (a sandbox torn down before `init()`
 * reached a module never had one).
 */
export function retireQuickJSModule(module: QuickJSWASMModule | null): void {
  if (!module) return;
  retiredModules.add(module);
  if (activeModule === module) {
    activeModule = null;
    modulePromise = null;
  }
}

/** Whether `module` has been retired after a teardown abort. */
export function isQuickJSModuleRetired(module: QuickJSWASMModule | null): boolean {
  return module !== null && retiredModules.has(module);
}

/**
 * Whether a QuickJS teardown has ever aborted a WASM module in this process
 * (#1922).
 *
 * Latched and never cleared — it is a diagnostic, not a health check. It does
 * **not** mean scripting is broken: the poisoned module is retired at the
 * moment of the abort and the next sandbox gets a fresh one, so a `true` here
 * is compatible with a fully working sandbox. A host wanting to know whether a
 * *particular* sandbox is still trustworthy should read `Sandbox.moduleRetired`
 * instead; this is for telemetry and for explaining a script that crashed.
 */
export function isSandboxRuntimeAborted(): boolean {
  return runtimeAborted;
}

/**
 * Record a teardown abort. Reported at error level on *every* occurrence, not
 * only the first: each aborting module is retired, so each new abort happens
 * on a module whose latch has not fired yet and is a genuinely distinct event.
 */
export function markRuntimeAborted(cause: unknown): void {
  runtimeAborted = true;
  console.error(
    '[ifc-lite/sandbox] QuickJS aborted while freeing a runtime (#1922). That WASM ' +
      'module has been retired; the next sandbox will be created on a fresh one.',
    cause,
  );
}
