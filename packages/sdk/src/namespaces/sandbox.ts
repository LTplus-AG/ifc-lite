/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.sandbox — Sandboxed script execution
 *
 * Run user scripts in a secure, isolated QuickJS-in-WASM environment
 * with only the bim.* API exposed. No DOM, no fetch, no network access.
 *
 * ```ts
 * const result = await bim.sandbox.eval(`
 *   const walls = bim.query.byType('IfcWall');
 *   walls.length;
 * `);
 * console.log(result.value, result.logs);
 * ```
 */

import type { CreateSurfaceMessage } from '@ifc-lite/a2ui';
import { RemoteBackend } from '../transport/remote-backend.js';

// ============================================================================
// Types
// ============================================================================

export interface SandboxPermissions {
  /** Allow query operations (default: true) */
  query?: boolean;
  /** Allow mutation operations (default: false) */
  mutate?: boolean;
  /** Allow viewer operations (default: true) */
  viewer?: boolean;
  /** Allow export operations (default: true) */
  export?: boolean;
  /** Allow model operations (default: true) */
  model?: boolean;
  /** Allow lens operations (default: true) */
  lens?: boolean;
  /** Allow uploaded file access (default: true) */
  files?: boolean;
  /** Allow bim.ui.* result surfaces (default: true) */
  ui?: boolean;
}

export interface SandboxLimits {
  /** Maximum execution time in ms (default: 30000) */
  timeoutMs?: number;
  /** Maximum heap memory in bytes (default: 64MB) */
  memoryBytes?: number;
  /** Maximum stack size in bytes (default: 512KB) */
  maxStackBytes?: number;
}

export interface SandboxConfig {
  /** Permissions for the sandboxed script */
  permissions?: SandboxPermissions;
  /** Resource limits */
  limits?: SandboxLimits;
}

export interface ScriptResult {
  /** Return value of the script */
  value: unknown;
  /** Captured console.log output */
  logs: Array<{ level: 'log' | 'warn' | 'error' | 'info'; args: unknown[]; timestamp: number }>;
  /** Execution time in ms */
  durationMs: number;
  /** A2UI message batches emitted by bim.ui during this run */
  surfaces?: CreateSurfaceMessage[][];
}

// ============================================================================
// Dynamic import
// ============================================================================

async function loadSandbox(): Promise<Record<string, unknown>> {
  const name = '@ifc-lite/sandbox';
  return import(/* webpackIgnore: true */ name) as Promise<Record<string, unknown>>;
}

type AnyFn = (...args: unknown[]) => unknown;

function isTransportBackedContext(bimContext: unknown): boolean {
  if (!bimContext || typeof bimContext !== 'object') return false;
  const candidate = bimContext as { _backend?: unknown };
  return candidate._backend instanceof RemoteBackend;
}

// ============================================================================
// SandboxNamespace
// ============================================================================

/** bim.sandbox — Secure script execution in QuickJS-WASM */
export class SandboxNamespace {
  private bimContext: unknown;
  private activeSandbox: unknown | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(bimContext?: unknown) {
    this.bimContext = bimContext ?? null;
  }

  private assertSupported(): void {
    if (isTransportBackedContext(this.bimContext)) {
      throw new Error('bim.sandbox is not supported for transport-backed contexts. Use a local backend context instead.');
    }
  }

  private runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async createSandboxInstance(config?: SandboxConfig): Promise<unknown> {
    const mod = await loadSandbox();
    return (mod.createSandbox as AnyFn)(this.bimContext, config);
  }

  private disposeActiveSandbox(): void {
    if (!this.activeSandbox) return;
    const sandbox = this.activeSandbox as { dispose: () => void };
    this.activeSandbox = null;
    sandbox.dispose();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Create a sandboxed execution environment.
   *
   * The sandbox runs scripts in an isolated QuickJS WASM instance with only
   * the bim.* API exposed. No DOM, fetch, or network access.
   *
   * @param config - Permissions and resource limits
   * @returns The sandbox instance (call dispose() when done)
   */
  async create(config?: SandboxConfig): Promise<unknown> {
    return this.runLifecycleOperation(async () => {
      this.assertSupported();
      this.disposeActiveSandbox();
      const sandbox = await this.createSandboxInstance(config);
      this.activeSandbox = sandbox;
      return sandbox;
    });
  }

  /**
   * Evaluate a script in the active sandbox.
   * Creates a sandbox if none exists yet.
   */
  async eval(script: string, config?: SandboxConfig): Promise<ScriptResult> {
    return this.runLifecycleOperation(async () => {
      this.assertSupported();
      if (!this.activeSandbox) {
        this.activeSandbox = await this.createSandboxInstance(config);
      }
      const sandbox = this.activeSandbox as { eval: (s: string) => Promise<ScriptResult> };
      return sandbox.eval(script);
    });
  }

  /**
   * Evaluate TypeScript code (transpiles to JS first, then runs).
   */
  async evalTypeScript(tsCode: string, config?: SandboxConfig): Promise<ScriptResult> {
    this.assertSupported();
    const mod = await loadSandbox();
    const jsCode = await (mod.transpileTypeScript as (ts: string) => Promise<string>)(tsCode);
    return this.eval(jsCode, config);
  }

  /** Dispose the active sandbox and free WASM resources. */
  async dispose(): Promise<void> {
    return this.runLifecycleOperation(async () => {
      this.disposeActiveSandbox();
    });
  }

  // --------------------------------------------------------------------------
  // Transpilation
  // --------------------------------------------------------------------------

  /** Transpile TypeScript to JavaScript without executing it. */
  async transpile(tsCode: string): Promise<string> {
    const mod = await loadSandbox();
    return (mod.transpileTypeScript as (ts: string) => Promise<string>)(tsCode);
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  /** Get default permissions. */
  async getDefaultPermissions(): Promise<SandboxPermissions> {
    const mod = await loadSandbox();
    return mod.DEFAULT_PERMISSIONS as SandboxPermissions;
  }

  /** Get default resource limits. */
  async getDefaultLimits(): Promise<SandboxLimits> {
    const mod = await loadSandbox();
    return mod.DEFAULT_LIMITS as SandboxLimits;
  }

  /** Get the bim.* API schema exposed to sandboxed scripts. */
  async getApiSchema(): Promise<unknown> {
    const mod = await loadSandbox();
    return mod.NAMESPACE_SCHEMAS;
  }
}
