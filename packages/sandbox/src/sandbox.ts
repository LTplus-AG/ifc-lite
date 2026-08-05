/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sandbox — QuickJS-in-WASM script execution environment.
 *
 * Architecture:
 * - One WASM module loaded per app lifetime (shared across sandboxes)
 * - Each sandbox creates a fresh QuickJS context (cheap — a few KB)
 * - The `bim` API is built inside the context via bridge.ts
 * - Scripts run synchronously inside QuickJS
 * - Memory and CPU limits enforced per-context
 * - TypeScript is transpiled to JS before execution (type-stripping)
 */

import {
  getQuickJS,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten';
import type { BimContext } from '@ifc-lite/sdk';
import type { SandboxConfig, ScriptResult, LogEntry } from './types.js';
import { DEFAULT_LIMITS, DEFAULT_PERMISSIONS } from './types.js';
import { buildBridge } from './bridge.js';
import { transpileTypeScript } from './transpile.js';

/** Cached WASM module promise — deduplicates concurrent init calls */
let modulePromise: Promise<QuickJSWASMModule> | null = null;
let nextSandboxSessionId = 1;

function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = getQuickJS();
  }
  return modulePromise!;
}

function createSandboxSessionId(): string {
  const sessionId = nextSandboxSessionId;
  nextSandboxSessionId += 1;
  return `sandbox-${sessionId}`;
}

/**
 * Render a QuickJS error handle as a ScriptError message.
 *
 * Shared by the main-body error path and the rejected-promise path so both
 * report identically. Never throws: a `dump` that fails (invalid realm)
 * becomes the message instead of masking the error it was reading.
 *
 * Does NOT free `handle` — the caller owns it.
 */
function describeError(vm: QuickJSContext, handle: QuickJSHandle): string {
  let errorData: unknown;
  try {
    errorData = vm.dump(handle);
  } catch (dumpErr) {
    errorData = { message: dumpErr instanceof Error ? dumpErr.message : String(dumpErr) };
  }
  return typeof errorData === 'object' && errorData !== null && 'message' in errorData
    ? String((errorData as { message: unknown }).message)
    : String(errorData);
}

export class Sandbox {
  private runtime: QuickJSRuntime | null = null;
  private vm: QuickJSContext | null = null;
  private logs: LogEntry[] = [];
  /**
   * Clears the log buffer *and* the bridge's capture budget. Set by init();
   * eval() calls it instead of emptying `logs` itself, so the budget can never
   * again be left latched across runs (#2099).
   */
  private resetLogs: (() => void) | null = null;
  private config: Required<SandboxConfig>;
  private bridgeDispose: (() => void) | null = null;
  /** Mutable start time — updated by eval(), read by interrupt handler */
  private evalStartTime = 0;
  /**
   * Set by the interrupt handler when it actually cuts execution short.
   * Cleared at the start of every eval(). QuickJS reports an interrupted
   * *main body* as an eval error, but an interrupted *promise job* is
   * swallowed by executePendingJobs(), so this flag is the only signal that
   * the drained jobs hit the CPU deadline.
   */
  private interrupted = false;
  private readonly sessionId = createSandboxSessionId();
  /**
   * Tail of the per-sandbox run queue (#2110).
   *
   * The bridge's capture state — the `logs` array, its byte total and the
   * `truncated` flag — is built once per sandbox and closed over by the
   * console functions, so it belongs to the sandbox, not to a run. `eval()`
   * resets it before every script. Two overlapping `eval()` calls therefore
   * shared one buffer: the second call's reset wiped output the first was
   * still accumulating, and each run's `ScriptResult.logs` could come back
   * short, empty, or carrying the other run's entries.
   *
   * Every `eval()` chains onto this promise, so a second call queues behind
   * the first instead of interleaving with it. Sequential callers — the
   * viewer, and every caller that awaits its result — see no change at all;
   * a concurrent caller trades overlap for correctness, which is the only
   * reading of the contract under which its results were ever meaningful.
   *
   * Rejections are absorbed here: a failed run must not poison the queue for
   * the runs behind it, and each caller still receives its own rejection from
   * the promise `eval()` returned to it.
   */
  private evalQueue: Promise<void> = Promise.resolve();
  /**
   * Set by dispose(). Distinguishes "never initialized" from "torn down" so a
   * use-after-dispose reports as such instead of advising `init()`, which
   * would not help — a disposed sandbox is not reusable.
   */
  private isDisposed = false;

  /**
   * Whether `dispose()` has run. A disposed sandbox rejects every later
   * `eval()`; callers holding one across an async boundary (a React cleanup,
   * an extension unload) can check this instead of catching.
   */
  get disposed(): boolean {
    return this.isDisposed;
  }

  constructor(
    private sdk: BimContext,
    config: SandboxConfig = {},
  ) {
    this.config = {
      permissions: { ...DEFAULT_PERMISSIONS, ...config.permissions },
      limits: { ...DEFAULT_LIMITS, ...config.limits },
    };
  }

  /** Initialize the sandbox (loads WASM module if not cached) */
  async init(): Promise<void> {
    const module = await getModule();
    // Set this.runtime before the try so dispose() can free it if any
    // subsequent step (newContext / buildBridge) throws — otherwise a failed
    // init() leaks the WASM runtime for the page/process lifetime, since the
    // caller never receives a handle to dispose.
    this.runtime = module.newRuntime();

    try {
      // Apply resource limits
      this.runtime.setMemoryLimit(this.config.limits.memoryBytes ?? DEFAULT_LIMITS.memoryBytes);
      this.runtime.setMaxStackSize(this.config.limits.maxStackBytes ?? DEFAULT_LIMITS.maxStackBytes);

      // CPU limit via interrupt handler — reads instance field set by eval()
      const timeoutMs = this.config.limits.timeoutMs ?? DEFAULT_LIMITS.timeoutMs;
      this.runtime.setInterruptHandler(() => {
        if (this.evalStartTime > 0 && Date.now() - this.evalStartTime > timeoutMs) {
          this.interrupted = true;
          return true; // Interrupt execution
        }
        return false;
      });

      this.vm = this.runtime.newContext();

      // Build the bim API inside the sandbox
      const { logs, resetLogs, dispose } = buildBridge(this.vm, this.sdk, this.config.permissions, {
        sandboxSessionId: this.sessionId,
      });
      this.logs = logs;
      this.resetLogs = resetLogs;
      this.bridgeDispose = dispose;
    } catch (err) {
      // dispose() is idempotent — it clears each field before freeing it, so
      // the bridge, vm and runtime are released in order and never twice.
      this.dispose();
      throw err;
    }
  }

  /**
   * Execute a script in the sandbox.
   *
   * Supports both JavaScript and TypeScript (TypeScript is type-stripped before execution).
   *
   * Runs are serialized per sandbox: calling `eval()` while another run is in
   * flight queues behind it rather than interleaving with it (#2110). One
   * sandbox owns one QuickJS realm and one log-capture buffer, so overlapping
   * runs could never have been independent.
   */
  eval(code: string, options?: { filename?: string; typescript?: boolean }): Promise<ScriptResult> {
    // The queue is advanced *synchronously* on call, so ordering follows call
    // order even when callers never await between calls. Doing it inside the
    // async body would let two callers both read the same tail and run
    // concurrently — the defect this exists to prevent.
    const run = this.evalQueue.then(() => this.runEval(code, options));
    this.evalQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One script execution. Only ever called from the `evalQueue` chain. */
  private async runEval(
    code: string,
    options?: { filename?: string; typescript?: boolean },
  ): Promise<ScriptResult> {
    if (this.isDisposed) {
      throw new Error('Sandbox disposed. Create a new sandbox to run more scripts.');
    }
    if (!this.vm || !this.resetLogs) {
      throw new Error('Sandbox not initialized. Call init() first.');
    }

    // Clear the previous run's logs and, with them, the capture budget that
    // bounds them — the two are one operation (see buildConsole).
    this.resetLogs();

    // Transpile TypeScript — always strip types for safety.
    // The transpiler is a no-op for plain JavaScript, and the heuristic
    // looksLikeTypeScript missed patterns like Record<string, number>.
    let jsCode = code;
    if (options?.typescript !== false) {
      jsCode = await transpileTypeScript(code);
    }

    // Re-check after the await, not only before it. The transpile is this
    // method's only suspension point, and a `dispose()` landing there — a
    // React cleanup firing while a run is in flight is the ordinary way it
    // happens — nulls `this.vm` before the dereference below, which surfaced
    // as `TypeError: Cannot read properties of null (reading 'evalCode')`.
    // Rejecting with the same message as the pre-await guard keeps the
    // contract the `disposed` getter documents: a disposed sandbox always
    // says so. Queued runs behind this one hit the pre-await guard and settle
    // the same way, so nothing is left pending.
    if (this.isDisposed) {
      throw new Error('Sandbox disposed. Create a new sandbox to run more scripts.');
    }
    if (!this.vm) {
      throw new Error('Sandbox not initialized. Call init() first.');
    }

    // Disposing a QuickJS handle must never crash the run. If the realm
    // became invalid mid-eval, `.dispose()` throws "Lifetime not alive" —
    // swallow that so the real error (or value) still gets through instead
    // of being masked by a teardown failure.
    const safeDispose = (h: { dispose(): void } | undefined): void => {
      if (!h) return;
      try {
        h.dispose();
      } catch (err) {
        console.warn('[ifc-lite/sandbox] QuickJS handle could not be disposed', err);
      }
    };

    this.interrupted = false;
    this.evalStartTime = Date.now();

    const result = this.vm.evalCode(jsCode, options?.filename ?? 'script.js');

    // The eval-result handle is freed in a `finally` covering every exit —
    // including an unexpected throw from job draining. A handle created
    // through the context is an unmanaged lifetime that `vm.dispose()` does
    // NOT free, so leaking one keeps a JSObject on the runtime's GC list and
    // makes `runtime.dispose()` abort the whole WASM module (#1905).
    const resultHandle = result.error ?? result.value;
    try {
      // Drain the QuickJS job queue. Promise callbacks and `async`
      // function bodies are scheduled as jobs — without this, an entry
      // wrapped as `async function run()` returns a pending promise and
      // its body never executes (the tool "succeeds" in 1ms doing
      // nothing). executePendingJobs runs them to completion.
      //
      // Its result is disposable and must be freed on both branches: the
      // failure branch owns a live error handle. Read it before disposing —
      // discarding it swallowed whatever stopped the queue. Note this does
      // NOT cover a throw inside an `async` body or a rejected promise:
      // QuickJS captures those in the promise, and executePendingJobs()
      // documents that it does not report them (handled after the interrupt
      // check below). Draining reports through the result rather than as a
      // host exception, so it still cannot abort the handling below.
      // The drain result is disposed but NOT inspected. Its `error` branch was
      // written and then removed: it is unreachable from script — ~20 constructs
      // across three attempts failed to produce it — and unpinnable, so it was
      // dead code asserting a capability the package does not have. Disposal
      // still matters: a leaked handle keeps a JSObject on the runtime's GC list
      // and makes runtime.dispose() abort the whole module (#1905).
      if (this.runtime) {
        safeDispose(this.runtime.executePendingJobs());
      }

      const durationMs = Date.now() - this.evalStartTime;
      // Stand the CPU interrupt down before dumping results — vm.dump can run
      // VM code (toJSON / getters) and must not be cut short by the timeout.
      this.evalStartTime = 0;

      if (result.error) {
        throw new ScriptError(describeError(this.vm, result.error), this.logs, durationMs);
      }

      // The main body finished, but a drained job may have been cut short by
      // the CPU deadline — executePendingJobs() reports no error for that, so
      // result.value still holds the (stale) main-body value. Reporting it as
      // a success hands the caller a silently truncated run, so surface the
      // same 'interrupted' ScriptError QuickJS raises for a main-body timeout.
      if (this.interrupted) {
        throw new ScriptError('interrupted', this.logs, durationMs);
      }

      // The main body finished, but when it hands back a promise — the shape
      // the extension host's entry wrap produces, `return activate(ctx)` — a
      // throw after the entry's first `await` settles that promise as
      // *rejected* without ever touching `result.error`. `vm.dump` then
      // renders the rejection as ordinary data (`{ type: 'rejected', … }`)
      // inside a successful ScriptResult, so the run reports a clean pass
      // carrying a failure. Draining cannot close this: executePendingJobs()
      // does not return errors thrown inside async functions or rejected
      // promises (the promise captures them), so the promise's own state is
      // the only signal. Surface it exactly as a main-body error.
      //
      // Checked *after* the interrupt flag on purpose: a job cut short by the
      // CPU deadline rejects with QuickJS's own `InternalError: interrupted`,
      // and a timeout must keep reporting as a timeout on the deliberate
      // channel #2063 added rather than depend on that reason text — which
      // the fire-and-forget shape (`run(); 'started'`) never exposes anyway.
      let rejectionMessage: string | null = null;
      try {
        const promiseState = this.vm.getPromiseState(result.value);
        if (promiseState.type === 'rejected') {
          try {
            rejectionMessage = describeError(this.vm, promiseState.error);
          } finally {
            // Freed on every exit for the same reason as the eval-result
            // handle: getPromiseState hands back an unmanaged lifetime that
            // vm.dispose() does NOT reclaim (#1905).
            safeDispose(promiseState.error);
          }
        } else if (promiseState.type === 'fulfilled' && !promiseState.notAPromise) {
          // A settled promise's value is another fresh handle. The dump below
          // re-reads it from the promise, so free this one. `notAPromise`
          // returns `result.value` itself, which the `finally` already frees.
          safeDispose(promiseState.value);
        }
      } catch (stateErr) {
        throw new ScriptError(
          `Sandbox realm became invalid during execution: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`,
          this.logs,
          durationMs,
        );
      }
      if (rejectionMessage !== null) {
        throw new ScriptError(rejectionMessage, this.logs, durationMs);
      }

      let value: unknown;
      try {
        value = this.vm.dump(result.value);
      } catch (dumpErr) {
        throw new ScriptError(
          `Sandbox realm became invalid during execution: ${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)}`,
          this.logs,
          durationMs,
        );
      }

      return {
        value,
        logs: [...this.logs],
        durationMs,
      };
    } finally {
      // Belt-and-braces: the success path already zeroed this before the dumps,
      // but an unexpected throw from job draining would otherwise leave the CPU
      // interrupt armed against a stale start time, so the next VM code to run
      // in this realm (including teardown) would be cut short as a timeout.
      this.evalStartTime = 0;
      safeDispose(resultHandle);
    }
  }

  /**
   * Dispose the sandbox and free WASM memory.
   *
   * Each field is cleared *before* the step that frees it, so a step that
   * throws is never retried. That matters for `runtime.dispose()`: an
   * out-of-memory or CPU-interrupt exception raised inside a drained promise
   * job leaves QuickJS holding objects with leaked refcounts, and upstream
   * `JS_FreeRuntime` then trips `assert(list_empty(&rt->gc_obj_list))` and
   * throws out of `dispose()` part-way through freeing the runtime (#1922).
   * Re-entering it — from a second `dispose()`, a React cleanup, or an
   * extension unload — would free those same structures twice.
   *
   * The failure is still reported: the throw propagates, so a caller that
   * cannot tolerate a broken teardown still sees it, and the leak-oracle
   * tests in dispose-leak.test.ts still fail on a retained handle.
   *
   * The steps run in sequence rather than through a `finally` chain. Freeing
   * the runtime after a throwing `vm.dispose()` would run `JS_FreeRuntime`
   * against a live context, which aborts the WASM module for the rest of the
   * document — a worse outcome than the ~17KB the skipped free costs, and it
   * would mask the original error.
   *
   * The abort itself is upstream and cannot be prevented from here (#1922) —
   * see `SandboxAbortError` for what was measured and what is done instead.
   */
  dispose(): void {
    const bridgeDispose = this.bridgeDispose;
    const vm = this.vm;
    const runtime = this.runtime;
    this.bridgeDispose = null;
    this.resetLogs = null;
    this.vm = null;
    this.runtime = null;
    // Set before the frees, not after: if `runtime.dispose()` aborts, the
    // sandbox must already read as disposed, so a later eval() reports a dead
    // sandbox instead of running against half-freed structures.
    this.isDisposed = true;

    bridgeDispose?.();
    vm?.dispose();
    if (!runtime) return;
    try {
      runtime.dispose();
    } catch (err) {
      // Record it before rethrowing: from here on, no later teardown in this
      // process can be trusted to report its own failure (see markRuntimeAborted).
      markRuntimeAborted(err);
      throw new SandboxAbortError(err);
    }
  }

}

/**
 * Whether a QuickJS teardown has aborted the shared WASM module in this
 * process (#1922).
 *
 * Once true, the module's heap is in an undefined state and — critically —
 * emscripten's `abort()` latch means **no later teardown failure can report
 * itself**: a second runtime left in the same broken state disposes
 * "successfully" while silently leaking whatever `JS_FreeRuntime` had not yet
 * freed. Measured directly: with two runtimes poisoned identically, the first
 * `dispose()` throws the assertion and the second returns cleanly.
 *
 * A host that cares about that distinction (the viewer, an extension host)
 * should treat a `true` here as "reload before trusting sandbox teardown
 * again". Nothing in this package refuses to run on an aborted module: the
 * module was measured to keep executing scripts correctly afterwards, so
 * hard-failing every later sandbox would break more than the bug does.
 */
export function isSandboxRuntimeAborted(): boolean {
  return runtimeAborted;
}

let runtimeAborted = false;

function markRuntimeAborted(cause: unknown): void {
  if (runtimeAborted) return;
  runtimeAborted = true;
  // Reported once, at error level, because this is the only moment the
  // condition is observable: every later occurrence is swallowed by the
  // emscripten abort latch.
  console.error(
    '[ifc-lite/sandbox] QuickJS aborted while freeing a runtime (#1922). The shared ' +
      'WASM module is now in an undefined state and later teardown failures will be ' +
      'silent. Reload before relying on sandbox teardown again.',
    cause,
  );
}

/**
 * Thrown by `Sandbox.dispose()` when upstream QuickJS aborts while freeing the
 * runtime (#1922).
 *
 * A failure raised inside a *drained promise job* — the reported case is an
 * out-of-memory in the post-`await` body of an `async function run()` — leaves
 * objects orphaned on `rt->gc_obj_list` with leaked refcounts. `JS_FreeRuntime`
 * asserts that list is empty, so teardown comes back as
 * `Aborted(Assertion failed: list_empty(&rt->gc_obj_list))` — long after the
 * `eval()` that caused it resolved normally, with a message that says nothing
 * about which script did it or what to do next.
 *
 * This class does not fix that; it contains it. The following were each
 * measured against the issue's reproducer in a **fresh process per trial** —
 * the isolation matters, because emscripten latches `ABORT` and every trial
 * after the first in one process reports a false clean:
 *
 * - forcing a QuickJS collection before teardown, by allocating 256 through
 *   1,000,000 object literals in the realm: still aborts. The orphaned objects
 *   have leaked refcounts, so the collector cannot reach them.
 * - the same with the memory limit lifted first, and with large retained-then-
 *   dropped allocations to push past the collector's threshold: still aborts.
 * - draining the job queue repeatedly, creating and freeing a second context,
 *   and skipping `context.dispose()`: all still abort.
 *
 * quickjs-emscripten 0.32 exposes no GC entry point, so there is no remaining
 * in-repo lever. What is left is to name the failure accurately, point at the
 * issue, and record that the module is now unreliable.
 */
export class SandboxAbortError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      'QuickJS aborted while freeing the sandbox runtime. This is upstream ' +
        'quickjs-emscripten behaviour after an out-of-memory or interrupt inside a ' +
        'drained promise job (ifc-lite#1922); the sandbox is unusable and the shared ' +
        'WASM module is in an undefined state. Original error: ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = 'SandboxAbortError';
  }
}

/** Error thrown when a sandboxed script fails */
export class ScriptError extends Error {
  /**
   * Console output captured before the failure.
   *
   * Copied from the caller's array: `eval()` reuses one log buffer and clears
   * it in place on every run, so storing that array by reference emptied a
   * caught error's diagnostics the moment the next script started (#2092).
   */
  public readonly logs: LogEntry[];

  constructor(
    message: string,
    logs: LogEntry[],
    public readonly durationMs: number,
  ) {
    super(message);
    this.name = 'ScriptError';
    this.logs = [...logs];
  }
}

/**
 * Create and initialize a sandbox.
 *
 * Usage:
 *   const sandbox = await createSandbox(bim, { permissions: { mutate: true } })
 *   const result = await sandbox.eval('bim.query.byType("IfcWall")')
 *   sandbox.dispose()
 */
export async function createSandbox(
  sdk: BimContext,
  config?: SandboxConfig,
): Promise<Sandbox> {
  const sandbox = new Sandbox(sdk, config);
  await sandbox.init();
  return sandbox;
}
