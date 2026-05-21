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
      console.log(`[ext-diag] factory.create — building sandbox for "${createOpts.extensionId}"`, {
        permissions: createOpts.permissions,
        grants: createOpts.grants,
      });
      const sandbox = await createSandbox(gatedSdk, {
        permissions: createOpts.permissions,
        limits: createOpts.limits,
      });
      const handle = new BimSandboxHandle(sandbox, createOpts.extensionId);
      console.log(`[ext-diag] factory.create — sandbox ${handle.diagId} ready for "${createOpts.extensionId}"`);
      return handle;
    },
  };
}

/**
 * Wrap the BimContext so each object-namespace method runs
 * `assertMethodCall(namespace, method, grants)` before forwarding.
 *
 * Implemented as a Proxy on the SDK ROOT — not by enumerating
 * `Object.keys(sdk)`. The BimContext is a class instance: its
 * namespaces and top-level methods (`query`, `entity`, `viewer`, …)
 * live on the prototype, so `Object.keys` returns none of them and a
 * key-enumerated copy comes out empty — every `bim.*` call then fails
 * with "<x> is not a function". The root Proxy resolves members via
 * the prototype chain, so nothing is dropped.
 *
 * Top-level functions (e.g. `sdk.query()`, `sdk.entity()`) pass
 * through ungated — the coarse permission ring already gates whole
 * namespaces; this inner ring only wraps object-namespace methods
 * (`sdk.viewer.colorize`, etc.).
 */
function wrapWithCapabilityGate(
  sdk: BimContext,
  grants: readonly Capability[],
  extensionId: string,
): BimContext {
  const nsCache = new Map<string, unknown>();
  return new Proxy(sdk as object, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof prop !== 'string') return value;
      // Functions / primitives pass through; only object namespaces
      // get the per-method capability gate.
      if (value === null || typeof value !== 'object') return value;
      let wrapped = nsCache.get(prop);
      if (!wrapped) {
        wrapped = new Proxy(value as object, {
          get(nsTarget, method) {
            const m = (nsTarget as Record<string | symbol, unknown>)[method];
            if (typeof m !== 'function' || typeof method !== 'string') return m;
            return function gated(this: unknown, ...args: unknown[]) {
              try {
                assertMethodCall(prop, method, grants);
              } catch (err) {
                if (err instanceof CapabilityDeniedError) {
                  console.warn(`[ext:${extensionId}] denied ${prop}.${method}: ${err.message}`);
                }
                throw err;
              }
              return (m as (...a: unknown[]) => unknown).apply(nsTarget, args);
            };
          },
        });
        nsCache.set(prop, wrapped);
      }
      return wrapped;
    },
  }) as unknown as BimContext;
}

let nextDiagId = 1;

class BimSandboxHandle implements RuntimeSandboxHandle {
  /**
   * Globals pre-defined for the next `run`, keyed by name so re-setting
   * a global REPLACES its assignment instead of appending a duplicate.
   * (A plain accumulating string grew the wrapped source ~54 chars on
   * every run as `__ifclite_ctx__` was re-set.)
   */
  private globals = new Map<string, string>();
  private disposed = false;
  /** Stable id for cross-call diagnostics — correlates create/run/dispose log lines. */
  readonly diagId: string;
  private runCount = 0;

  constructor(private sandbox: Sandbox, private extensionId = '<unknown>') {
    this.diagId = `sbx#${nextDiagId++}`;
  }

  setGlobal(name: string, value: unknown): void {
    if (this.disposed) {
      console.warn(`[ext-diag] ${this.diagId} setGlobal("${name}") on a DISPOSED sandbox (ext=${this.extensionId})`);
      throw new Error('Sandbox disposed.');
    }
    console.log(`[ext-diag] ${this.diagId} setGlobal("${name}") ext=${this.extensionId}`);
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
      this.globals.set(name, `globalThis.__ifclite_ctx__ = { bim: globalThis.bim };`);
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
    this.globals.set(name, `globalThis.${name} = ${serialised};`);
  }

  async run(source: string, _opts?: RuntimeRunOptions): Promise<RuntimeRunResult> {
    this.runCount += 1;
    const runN = this.runCount;
    if (this.disposed) {
      console.warn(`[ext-diag] ${this.diagId} run #${runN} on a DISPOSED sandbox (ext=${this.extensionId})`);
      throw new Error('Sandbox disposed.');
    }
    const prelude = [...this.globals.values()].join('\n');
    const wrapped = prelude ? `${prelude}\n${source}` : source;
    console.log(`[ext-diag] ${this.diagId} run #${runN} START ext=${this.extensionId} — wrapped ${wrapped.length} chars`);
    let result;
    try {
      result = await this.sandbox.eval(wrapped, { typescript: false });
    } catch (err) {
      // QuickJS throws "Lifetime not alive" (QuickJSUseAfterFree) when
      // a handle is touched after its underlying realm was disposed —
      // typically because a prior run / flavor switch tore down this
      // sandbox while the host still held the activation record. Mark
      // ourselves disposed so the runtime knows to reactivate on the
      // next call, and surface a clear retry-friendly message.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ext-diag] ${this.diagId} run #${runN} FAILED ext=${this.extensionId} — ${msg}`, err);
      if (/Lifetime not alive|QuickJSUseAfterFree/i.test(msg)) {
        this.disposed = true;
        try { this.sandbox.dispose(); } catch { /* already torn down */ }
        throw new Error(
          'Sandbox was torn down between activate and run. Click Run again — the runtime will reactivate.',
        );
      }
      throw err;
    }
    console.log(`[ext-diag] ${this.diagId} run #${runN} OK ext=${this.extensionId} — ${result.durationMs}ms, ${result.logs.length} log lines`);
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

  /** True iff the sandbox has been torn down (host-disposed or auto-disposed on a Lifetime crash). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) {
      console.log(`[ext-diag] ${this.diagId} dispose() — already disposed (ext=${this.extensionId})`);
      return;
    }
    // Stack trace is the whole point: it names WHO disposed the
    // sandbox. If a dispose lands between an activate and the next
    // run, this trace is the smoking gun.
    console.warn(
      `[ext-diag] ${this.diagId} dispose() ext=${this.extensionId} — caller:\n${new Error().stack}`,
    );
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
