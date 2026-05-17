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

import {
  assertMethodCall,
  CapabilityDeniedError,
  type Capability,
  type RuntimeRunOptions,
  type RuntimeRunResult,
  type RuntimeSandboxCreateOptions,
  type RuntimeSandboxFactory,
  type RuntimeSandboxHandle,
} from '@ifc-lite/extensions';
import { createSandbox, type Sandbox } from '@ifc-lite/sandbox';
import type { BimContext } from '@ifc-lite/sdk';

export interface SandboxFactoryOptions {
  sdk: BimContext;
}

export function createBimSandboxFactory(opts: SandboxFactoryOptions): RuntimeSandboxFactory {
  return {
    async create(createOpts: RuntimeSandboxCreateOptions): Promise<RuntimeSandboxHandle> {
      // Wrap the SDK with a per-method capability gate using the
      // create-time grants. The outer-ring permission flags already
      // gate at namespace level (model/viewer/etc.); this Proxy is
      // the inner ring that flags fine-grained denials like
      // "granted viewer.colorize but called viewer.fly".
      const gatedSdk = createOpts.grants
        ? wrapWithCapabilityGate(opts.sdk, createOpts.grants, createOpts.extensionId)
        : opts.sdk;
      const sandbox = await createSandbox(gatedSdk, {
        permissions: createOpts.permissions,
        limits: createOpts.limits,
      });
      return new BimSandboxHandle(sandbox);
    },
  };
}

/**
 * Wrap each namespace of the BimContext with a Proxy that runs
 * `assertMethodCall(grants, namespace, method)` before forwarding.
 * Denied calls throw `CapabilityDeniedError` which surfaces inside
 * the sandbox as a regular exception the extension can catch (or
 * propagate to fail the activation cleanly).
 *
 * Only namespace-level wrapping is needed — methods themselves don't
 * have sub-namespaces. We Proxy at depth-2 so any callable on
 * `bim.<namespace>.<method>` is intercepted.
 */
function wrapWithCapabilityGate(
  sdk: BimContext,
  grants: readonly Capability[],
  extensionId: string,
): BimContext {
  const wrappedNamespaces: Record<string, unknown> = {};
  for (const namespace of Object.keys(sdk) as (keyof BimContext)[]) {
    const ns = sdk[namespace];
    if (ns === null || typeof ns !== 'object') {
      wrappedNamespaces[namespace as string] = ns;
      continue;
    }
    wrappedNamespaces[namespace as string] = new Proxy(ns as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string') {
          return value;
        }
        // Intercept the method call — assert capability, then forward.
        return function gated(this: unknown, ...args: unknown[]) {
          try {
            assertMethodCall(namespace as string, prop, grants);
          } catch (err) {
            if (err instanceof CapabilityDeniedError) {
              console.warn(`[ext:${extensionId}] denied ${namespace as string}.${prop}: ${err.message}`);
            }
            throw err;
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
  return wrappedNamespaces as unknown as BimContext;
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
    // Special-case `__ifclite_ctx__` — the runtime calls
    // `setGlobal('__ifclite_ctx__', { bim: <host SDK> })` for every
    // activate / command-run. The host SDK is the wrapped BimContext
    // (cyclic Proxies for the inner-ring capability gate) so JSON
    // serialisation crashes. The bridge has already installed `bim`
    // inside the QuickJS realm — synthesize ctx from that instead.
    if (name === '__ifclite_ctx__') {
      this.globalsScript += `globalThis.__ifclite_ctx__ = { bim: globalThis.bim };\n`;
      return;
    }
    // Other globals (test args, synthetic-spec data) are JSON-safe;
    // serialise so the value crosses the realm boundary intact.
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
  } catch (err) {
    // JSON.stringify throws on cycles / BigInt — fall back to String()
    // but log so we can spot pathological logging in dev.
    console.warn('[sandbox-factory] non-stringifiable log arg:', err);
    return String(arg);
  }
}
