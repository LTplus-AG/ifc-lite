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
      const { logs, dispose } = buildBridge(this.vm, this.sdk, this.config.permissions, {
        sandboxSessionId: this.sessionId,
      });
      this.logs = logs;
      this.bridgeDispose = dispose;
    } catch (err) {
      // dispose() is idempotent and null-checks each field, freeing the
      // bridge, vm, and runtime in order without risk of double-free.
      this.dispose();
      throw err;
    }
  }

  /**
   * Execute a script in the sandbox.
   *
   * Supports both JavaScript and TypeScript (TypeScript is type-stripped before execution).
   */
  async eval(code: string, options?: { filename?: string; typescript?: boolean }): Promise<ScriptResult> {
    if (!this.vm) {
      throw new Error('Sandbox not initialized. Call init() first.');
    }

    // Clear previous logs
    this.logs.length = 0;

    // Transpile TypeScript — always strip types for safety.
    // The transpiler is a no-op for plain JavaScript, and the heuristic
    // looksLikeTypeScript missed patterns like Record<string, number>.
    let jsCode = code;
    if (options?.typescript !== false) {
      jsCode = await transpileTypeScript(code);
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
      let drainErrorMessage: string | null = null;
      if (this.runtime) {
        const drained = this.runtime.executePendingJobs();
        try {
          if (drained.error) {
            // The handle carries the context the exception occurred in.
            drainErrorMessage = describeError(drained.error.context, drained.error);
          }
        } finally {
          safeDispose(drained);
        }
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

      // A job that stopped the queue outright — checked after the interrupt
      // flag so a CPU deadline keeps its 'interrupted' message.
      if (drainErrorMessage !== null) {
        throw new ScriptError(drainErrorMessage, this.logs, durationMs);
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

  /** Dispose the sandbox and free WASM memory */
  dispose(): void {
    if (this.bridgeDispose) {
      this.bridgeDispose();
      this.bridgeDispose = null;
    }
    if (this.vm) {
      this.vm.dispose();
      this.vm = null;
    }
    if (this.runtime) {
      this.runtime.dispose();
      this.runtime = null;
    }
  }


}

/** Error thrown when a sandboxed script fails */
export class ScriptError extends Error {
  constructor(
    message: string,
    public readonly logs: LogEntry[],
    public readonly durationMs: number,
  ) {
    super(message);
    this.name = 'ScriptError';
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
