/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adapter — `RuntimeSandboxFactory` backed by `@ifc-lite/sandbox`.
 *
 * The viewer's production sandbox is the QuickJS-WASM runtime that the
 * existing `@ifc-lite/sandbox` package already wraps. This module
 * adapts that surface into the runtime contract defined by
 * `@ifc-lite/extensions`:
 *
 *   - `RuntimeSandboxHandle.setGlobal(name, value)` is implemented by
 *     wrapping the value as a JSON literal and pre-defining it on the
 *     QuickJS realm before each `run`.
 *   - `RuntimeSandboxHandle.run(source)` evaluates the wrapped source
 *     via `Sandbox.eval`, maps the returned log entries into the
 *     runtime's `RuntimeLogEntry` shape.
 *   - `RuntimeSandboxHandle.dispose()` calls `Sandbox.dispose()`.
 *
 * The factory accepts a `BimContext` at construction; that SDK is
 * passed to every Sandbox created. The capability layer (in
 * `@ifc-lite/extensions/host`) enforces granular access; the sandbox's
 * coarse permission flags act as the outer ring.
 */

import type {
  RuntimeRunOptions,
  RuntimeRunResult,
  RuntimeSandboxCreateOptions,
  RuntimeSandboxFactory,
  RuntimeSandboxHandle,
} from '@ifc-lite/extensions';
import { createSandbox, type Sandbox } from '@ifc-lite/sandbox';
import type { BimContext } from '@ifc-lite/sdk';

export interface SandboxFactoryOptions {
  sdk: BimContext;
}

export function createBimSandboxFactory(opts: SandboxFactoryOptions): RuntimeSandboxFactory {
  return {
    async create(createOpts: RuntimeSandboxCreateOptions): Promise<RuntimeSandboxHandle> {
      const sandbox = await createSandbox(opts.sdk, {
        permissions: createOpts.permissions,
        limits: createOpts.limits,
      });
      return new BimSandboxHandle(sandbox);
    },
  };
}

class BimSandboxHandle implements RuntimeSandboxHandle {
  /** Globals pre-defined for the next `run`. Re-applied per call so the realm always sees the latest value. */
  private globalsScript = '';
  private disposed = false;

  constructor(private sandbox: Sandbox) {}

  setGlobal(name: string, value: unknown): void {
    if (this.disposed) throw new Error('Sandbox disposed.');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`Invalid global name: ${name}`);
    }
    // Serialise to JSON; cycle / function values are rejected here.
    let serialised: string;
    try {
      serialised = JSON.stringify(value ?? null);
    } catch (err) {
      throw new Error(
        `setGlobal("${name}"): value is not JSON-serialisable (${err instanceof Error ? err.message : err}).`,
      );
    }
    // Each call appends a fresh assignment; later setGlobal calls win.
    this.globalsScript += `globalThis.${name} = ${serialised};\n`;
  }

  async run(source: string, _opts?: RuntimeRunOptions): Promise<RuntimeRunResult> {
    if (this.disposed) throw new Error('Sandbox disposed.');
    const wrapped = this.globalsScript
      ? `${this.globalsScript}${source}`
      : source;
    const result = await this.sandbox.eval(wrapped, { typescript: false });
    return {
      value: result.value,
      logs: result.logs.map((log) => ({
        level: log.level === 'log' ? 'log' : log.level,
        message: log.args.map(stringifyArg).join(' '),
        timestamp: log.timestamp,
      })),
      durationMs: result.durationMs,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sandbox.dispose();
  }
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
