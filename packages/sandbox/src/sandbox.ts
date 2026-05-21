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
    this.runtime = module.newRuntime();
    console.log(`[ext-diag] Sandbox ${this.sessionId} init — new QuickJS runtime + context`);

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
  }

  /**
   * Execute a script in the sandbox.
   *
   * Supports both JavaScript and TypeScript (TypeScript is type-stripped before execution).
   */
  async eval(code: string, options?: { filename?: string; typescript?: boolean }): Promise<ScriptResult> {
    if (!this.vm) {
      console.warn(`[ext-diag] Sandbox ${this.sessionId} eval — vm is NULL (disposed or never init)`);
      throw new Error('Sandbox not initialized. Call init() first.');
    }
    console.log(`[ext-diag] Sandbox ${this.sessionId} eval — runtime.alive=${this.runtime?.alive ?? 'n/a'}, vm.alive=${this.vm.alive}`);

    // Clear previous logs
    this.logs.length = 0;

    // Transpile TypeScript — always strip types for safety.
    // The transpiler is a no-op for plain JavaScript, and the heuristic
    // looksLikeTypeScript missed patterns like Record<string, number>.
    let jsCode = code;
    if (options?.typescript !== false) {
      jsCode = await transpileTypeScript(code);
    }

    this.evalStartTime = Date.now();

    const result = this.vm.evalCode(jsCode, options?.filename ?? 'script.js');

    // Drain the QuickJS job queue. Promise callbacks and `async`
    // function bodies are scheduled as jobs — without this, an entry
    // wrapped as `async function run()` returns a pending promise and
    // its body never executes (the tool "succeeds" in 1ms doing
    // nothing). executePendingJobs runs them to completion.
    if (this.runtime) {
      try {
        this.runtime.executePendingJobs();
      } catch (jobErr) {
        console.warn('[ext-diag] executePendingJobs threw:', jobErr);
      }
    }

    const durationMs = Date.now() - this.evalStartTime;
    this.evalStartTime = 0;

    // Disposing an eval-result handle must never crash the run. If the
    // realm became invalid mid-eval, `.dispose()` throws "Lifetime not
    // alive" — swallow that so the real error (or value) still gets
    // through instead of being masked by a teardown failure.
    const safeDispose = (h: { dispose(): void } | undefined): void => {
      if (!h) return;
      try { h.dispose(); } catch { /* handle already dead — nothing to free */ }
    };

    if (result.error) {
      let errorData: unknown;
      try {
        errorData = this.vm.dump(result.error);
      } catch (dumpErr) {
        errorData = { message: dumpErr instanceof Error ? dumpErr.message : String(dumpErr) };
      }
      safeDispose(result.error);
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
      safeDispose(result.value);
      throw new ScriptError(
        `Sandbox realm became invalid during execution: ${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)}`,
        this.logs,
        durationMs,
      );
    }
    safeDispose(result.value);

    return {
      value,
      logs: [...this.logs],
      durationMs,
    };
  }

  /** Dispose the sandbox and free WASM memory */
  dispose(): void {
    // The stack trace names exactly who tore this sandbox down — the
    // key clue when a sandbox dies between activate and run.
    console.warn(`[ext-diag] Sandbox ${this.sessionId} dispose() — caller:\n${new Error().stack}`);
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
