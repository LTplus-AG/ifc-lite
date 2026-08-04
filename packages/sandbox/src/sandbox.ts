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

import { getQuickJS, type QuickJSWASMModule, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten';
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

export class Sandbox {
  private runtime: QuickJSRuntime | null = null;
  private vm: QuickJSContext | null = null;
  private logs: LogEntry[] = [];
  private config: Required<SandboxConfig>;
  private bridgeDispose: (() => void) | null = null;
  /** Mutable start time — updated by eval(), read by interrupt handler */
  private evalStartTime = 0;
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

    // Disposing an eval-result handle must never crash the run. If the
    // realm became invalid mid-eval, `.dispose()` throws "Lifetime not
    // alive" — swallow that so the real error (or value) still gets
    // through instead of being masked by a teardown failure.
    const safeDispose = (h: { dispose(): void } | undefined): void => {
      if (!h) return;
      try {
        h.dispose();
      } catch (err) {
        console.warn('[ifc-lite/sandbox] eval-result handle could not be disposed', err);
      }
    };

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
      // Its result is disposable and must be freed: the failure branch owns a
      // live error handle. A job that throws is reported through that result
      // rather than as a host exception, so draining still cannot abort the
      // eval result handling below.
      if (this.runtime) {
        this.runtime.executePendingJobs().dispose();
      }

      const durationMs = Date.now() - this.evalStartTime;
      // Stand the CPU interrupt down before dumping results — vm.dump can run
      // VM code (toJSON / getters) and must not be cut short by the timeout.
      this.evalStartTime = 0;

      if (result.error) {
        let errorData: unknown;
        try {
          errorData = this.vm.dump(result.error);
        } catch (dumpErr) {
          errorData = { message: dumpErr instanceof Error ? dumpErr.message : String(dumpErr) };
        }
        throw new ScriptError(
          typeof errorData === 'object' && errorData !== null && 'message' in errorData
            ? String((errorData as { message: unknown }).message)
            : String(errorData),
          this.logs,
          durationMs,
        );
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
   */
  dispose(): void {
    const bridgeDispose = this.bridgeDispose;
    const vm = this.vm;
    const runtime = this.runtime;
    this.bridgeDispose = null;
    this.vm = null;
    this.runtime = null;

    bridgeDispose?.();
    vm?.dispose();
    runtime?.dispose();
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
