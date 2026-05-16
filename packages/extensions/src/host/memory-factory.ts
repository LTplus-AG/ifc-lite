/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-memory `RuntimeSandboxFactory` for tests and headless tooling.
 *
 * Evaluates source via `new Function()` in the host realm. **This is
 * NOT a security boundary.** Production hosts must use a real
 * isolation runtime (the viewer uses `@ifc-lite/sandbox` which wraps
 * QuickJS-WASM). This factory exists so the activation pipeline can be
 * exercised end-to-end in headless tests without bringing QuickJS into
 * the test runner.
 *
 * What this DOES verify when used in tests:
 *   - The source-wrap convention produces evaluable code.
 *   - `__ifclite_ctx__` global injection works as designed.
 *   - The `activate(ctx)` call shape is correct.
 *   - Logs are captured and timing is recorded.
 *   - Error propagation lands the right exception class.
 *
 * What this DOES NOT verify:
 *   - QuickJS-specific behaviour (memory limits, CPU interrupts,
 *     realm isolation).
 *   - Cross-realm marshalling of complex values.
 */

import type {
  RuntimeRunOptions,
  RuntimeRunResult,
  RuntimeSandboxCreateOptions,
  RuntimeSandboxFactory,
  RuntimeSandboxHandle,
} from './runtime.js';

export interface MemorySandboxFactoryOptions {
  /** Optional clock for deterministic log timestamps. Defaults to Date.now. */
  now?: () => number;
}

class MemorySandboxHandle implements RuntimeSandboxHandle {
  private globals: Record<string, unknown> = {};
  private disposed = false;
  private readonly now: () => number;

  constructor(opts: MemorySandboxFactoryOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  setGlobal(name: string, value: unknown): void {
    if (this.disposed) throw new Error('Sandbox disposed.');
    this.globals[name] = value;
  }

  async run(source: string, _options?: RuntimeRunOptions): Promise<RuntimeRunResult> {
    if (this.disposed) throw new Error('Sandbox disposed.');

    const logs: RuntimeRunResult['logs'] = [];
    const fakeConsole = {
      log: (...args: unknown[]) => {
        logs.push({ level: 'log', message: args.map(stringify).join(' '), timestamp: this.now() });
      },
      info: (...args: unknown[]) => {
        logs.push({ level: 'info', message: args.map(stringify).join(' '), timestamp: this.now() });
      },
      warn: (...args: unknown[]) => {
        logs.push({ level: 'warn', message: args.map(stringify).join(' '), timestamp: this.now() });
      },
      error: (...args: unknown[]) => {
        logs.push({ level: 'error', message: args.map(stringify).join(' '), timestamp: this.now() });
      },
    };

    // Build the host-realm environment the sandbox source sees as
    // globalThis. We thread the factory's globals plus our captured
    // console into a synthetic globalThis available via `new Function`.
    const start = this.now();
    const env: Record<string, unknown> = {
      ...this.globals,
      console: fakeConsole,
    };

    // Source uses `globalThis.__ifclite_ctx__`; we expose envVar bindings
    // by creating a new Function that accepts them and a synthetic
    // globalThis.
    const envKeys = Object.keys(env);
    const envValues = envKeys.map((k) => env[k]);
    // The wrapper guarantees the source is an IIFE expression. The
    // wrap uses a leading `;` as a defensive ASI guard; that prefix is
    // fine when concatenated with prior code but breaks `return ;(...)`
    // (which parses as `return;`). Strip leading whitespace + `;` so
    // the IIFE result flows through.
    const trimmed = source.replace(/^[\s;]+/, '');
    const fn = new Function(
      ...envKeys,
      'globalThis',
      `return ${trimmed};`,
    );
    const syntheticGlobal = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        return env[prop];
      },
      has(_t, prop) {
        return typeof prop === 'string' && prop in env;
      },
    });

    let value: unknown;
    try {
      value = fn(...envValues, syntheticGlobal);
    } catch (err) {
      throw err;
    }
    const durationMs = this.now() - start;
    return { value, logs, durationMs };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.globals = {};
  }
}

/**
 * Build a memory-backed factory. Each `create()` returns a fresh
 * sandbox handle.
 */
export function createMemorySandboxFactory(
  opts: MemorySandboxFactoryOptions = {},
): RuntimeSandboxFactory {
  return {
    async create(_opts: RuntimeSandboxCreateOptions): Promise<RuntimeSandboxHandle> {
      return new MemorySandboxHandle(opts);
    },
  };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
