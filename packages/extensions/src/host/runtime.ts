/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ExtensionRuntime — manages activation lifecycle and resource budgets
 * for installed extensions.
 *
 * Per extension, the runtime owns:
 *   - a `SandboxPermissionsLike` derived from the granted capabilities
 *   - a tracked "active" state (boolean + activation timestamp)
 *   - a dispose handle so the host can free resources on unload / unin-
 *     stall / flavor switch
 *
 * The runtime does NOT create QuickJS contexts itself. The viewer-side
 * host wires the runtime to `@ifc-lite/sandbox` via the
 * `RuntimeSandboxFactory` interface, and a headless test can supply a
 * stub factory. This keeps `@ifc-lite/extensions` decoupled from the
 * QuickJS-WASM runtime — the same code drives the desktop and the CLI.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §8
 * (lifecycle) and `02-security.md §5` (sandbox enforcement).
 */

import type { Bundle, Capability } from '../types.js';
import type { SandboxPermissionsLike } from './permissions.js';
import { capabilitiesToPermissions } from './permissions.js';
import { wrapEntrySource } from './source-wrap.js';

/**
 * A live sandbox handle the runtime hands back to callers. The exact
 * implementation lives in the host (browser viewer wraps QuickJS;
 * tests use the in-memory stub).
 */
export interface RuntimeSandboxHandle {
  /**
   * Evaluate the given source inside the sandbox. The runtime expects
   * sources that have already been wrapped by `wrapEntrySource`; the
   * `__ifclite_ctx__` global must be available inside the realm.
   */
  run(source: string, options?: RuntimeRunOptions): Promise<RuntimeRunResult>;

  /**
   * Install a value as a global inside the sandbox. Called by the
   * runtime to install `__ifclite_ctx__` before each `run`. The host
   * implementation marshals the value across the realm boundary.
   */
  setGlobal(name: string, value: unknown): Promise<void> | void;

  /** Dispose the underlying sandbox and free its resources. */
  dispose(): Promise<void> | void;

  /**
   * Optional liveness flag. When the host's sandbox implementation can
   * detect that its underlying realm was torn down (QuickJS context
   * disposed, WASM aborted), it exposes `true` here so the runtime can
   * drop a stale activation record and rebuild instead of handing back
   * a dead handle. Implementations that can't tell may omit it — the
   * runtime treats `undefined` as "assume alive".
   */
  readonly isDisposed?: boolean;
}

export interface RuntimeRunOptions {
  /** Source identifier shown in stack traces. */
  filename?: string;
}

export interface RuntimeRunResult {
  /** Whatever the IIFE returned. May be a Promise if `activate` is async. */
  value: unknown;
  /** Console output captured during the run. */
  logs: RuntimeLogEntry[];
  /** Wall-clock duration of the run. */
  durationMs: number;
}

export interface RuntimeLogEntry {
  level: 'info' | 'warn' | 'error' | 'log';
  message: string;
  timestamp: number;
}

/**
 * Factory the host plugs in. The viewer's implementation calls
 * `createSandbox` from `@ifc-lite/sandbox`; tests supply a stub.
 */
export interface RuntimeSandboxFactory {
  create(opts: RuntimeSandboxCreateOptions): Promise<RuntimeSandboxHandle>;
}

export interface RuntimeSandboxCreateOptions {
  extensionId: string;
  permissions: SandboxPermissionsLike;
  /**
   * Granted capabilities for the extension. Factories use these to
   * wrap the SDK with a per-method capability gate (the inner ring of
   * the security model — namespace-level gating sits on `permissions`).
   */
  grants?: readonly Capability[];
  /** Resource limits — passed verbatim to the underlying sandbox. */
  limits?: {
    memoryBytes?: number;
    timeoutMs?: number;
    maxStackBytes?: number;
  };
}

export interface ActivationRecord {
  extensionId: string;
  /** ISO timestamp of when activation finished. */
  activatedAt: string;
  /** Resolved permissions used to construct the sandbox. */
  permissions: SandboxPermissionsLike;
  /** Granted capabilities at activation time. */
  grants: readonly Capability[];
  /** Sandbox handle for later disposal. */
  sandbox: RuntimeSandboxHandle;
  /**
   * Result of evaluating the `entry.activate` script. Absent when the
   * bundle declares no `entry.activate`.
   */
  activateResult?: RuntimeRunResult;
}

export interface ExtensionRuntimeOptions {
  factory: RuntimeSandboxFactory;
  /**
   * Optional shared SDK reference. Future ctx fields (storage, fetch,
   * notify) hang off this; today only `bim` is plumbed through.
   */
  sdk?: unknown;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
  /**
   * Default resource limits applied to every extension. The host may
   * tighten per-extension via settings; the spec calls out a default of
   * 64 MiB memory, 5s sync CPU, 30s async window.
   */
  defaultLimits?: RuntimeSandboxCreateOptions['limits'];
}

/**
 * Minimal v1 `ctx` shape exposed to extension entry functions. Each
 * field is the OCAP capability handle the extension is permitted to
 * use; in v1 only `bim` is plumbed. Future ctx fields (fetch, storage,
 * notify, onDispose, t, meta) land in subsequent phases.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §9.
 */
export interface ExtensionContextV1 {
  bim: unknown;
}

/**
 * Thrown when an entry script fails to parse or contains constructs
 * the wrapper does not support. Distinct from CapabilityDeniedError
 * (runtime-time capability violations) and ScriptError (sandbox eval
 * runtime errors).
 */
export class EntrySourceError extends Error {
  readonly extensionId: string;
  readonly entryPath: string;
  readonly validationErrors: readonly import('../types.js').ValidationError[];

  constructor(
    extensionId: string,
    entryPath: string,
    errors: readonly import('../types.js').ValidationError[],
  ) {
    const summary = errors.map((e) => `${e.path || '<root>'}: ${e.message}`).join('; ');
    super(`Entry script ${entryPath} for ${extensionId} did not wrap: ${summary}`);
    this.name = 'EntrySourceError';
    this.extensionId = extensionId;
    this.entryPath = entryPath;
    this.validationErrors = errors;
  }
}

export class ExtensionRuntime {
  private active = new Map<string, ActivationRecord>();
  /** In-flight activations keyed by id. Coalesces concurrent activate() calls. */
  private inFlight = new Map<string, Promise<ActivationRecord>>();
  private readonly factory: RuntimeSandboxFactory;
  private readonly sdk: unknown;
  private readonly now: () => Date;
  private readonly defaultLimits: RuntimeSandboxCreateOptions['limits'];

  constructor(opts: ExtensionRuntimeOptions) {
    this.factory = opts.factory;
    this.sdk = opts.sdk;
    this.now = opts.now ?? (() => new Date());
    this.defaultLimits = opts.defaultLimits;
  }

  /**
   * Activate an extension. Creates a sandbox, derives permissions from
   * the granted capabilities, installs the `__ifclite_ctx__` global,
   * and runs `entry.activate` if the bundle declares one. Idempotent —
   * if the extension is already active, returns the existing record.
   *
   * The activate call is fire-and-forget for async returns: the
   * activation record's `activateResult.value` may be a Promise the
   * sandbox is still resolving. The runtime never awaits async user
   * work because long-running activation would block the host.
   */
  async activate(
    extensionId: string,
    grants: readonly Capability[],
    bundle?: Bundle,
  ): Promise<ActivationRecord> {
    const existing = this.active.get(extensionId);
    // Return the cached activation only if its sandbox is still alive.
    // A stale record — sandbox disposed by a flavor switch, a prior
    // run's QuickJS crash, or self-heal teardown — would otherwise be
    // handed back and the next setGlobal/run would fail with
    // "Lifetime not alive". Drop it so doActivate rebuilds fresh.
    if (existing && !existing.sandbox.isDisposed) return existing;
    if (existing) this.active.delete(extensionId);
    // Coalesce concurrent activate() calls for the same id. Without
    // this, two overlapping callers both miss `active`, both build a
    // sandbox, and the second leaks because only one wins the put.
    const pending = this.inFlight.get(extensionId);
    if (pending) return pending;
    const promise = this.doActivate(extensionId, grants, bundle).finally(() => {
      this.inFlight.delete(extensionId);
    });
    this.inFlight.set(extensionId, promise);
    return promise;
  }

  private async doActivate(
    extensionId: string,
    grants: readonly Capability[],
    bundle?: Bundle,
  ): Promise<ActivationRecord> {
    const permissions = capabilitiesToPermissions(grants);
    const sandbox = await this.factory.create({
      extensionId,
      permissions,
      grants,
      limits: this.defaultLimits,
    });

    let activateResult: RuntimeRunResult | undefined;
    if (bundle?.manifest.entry.activate) {
      const entryPath = bundle.manifest.entry.activate;
      const file = bundle.files.get(entryPath);
      if (!file) {
        await sandbox.dispose();
        throw new Error(
          `Extension ${extensionId}: entry.activate "${entryPath}" not found in bundle.`,
        );
      }
      const source = file.text ?? new TextDecoder().decode(file.bytes);
      const wrapped = wrapEntrySource(source, { entryFnName: 'activate', filename: entryPath });
      if (!wrapped.ok) {
        await sandbox.dispose();
        throw new EntrySourceError(extensionId, entryPath, wrapped.errors);
      }
      // Sandbox factories that JSON-serialise globals (production
      // QuickJS factory) MUST special-case `__ifclite_ctx__` to
      // synthesize the ctx from the bridge-installed `globalThis.bim`
      // — the host SDK contains cyclic Proxies that can't survive
      // JSON.stringify. Factories without that cap (memory factory)
      // store the value directly; wrap reads it via __ifclite_ctx__.
      // The source wrap also falls back to `{ bim: globalThis.bim }`
      // when __ifclite_ctx__ isn't set, so either channel works.
      const ctx: ExtensionContextV1 = { bim: this.sdk };
      await sandbox.setGlobal('__ifclite_ctx__', ctx);
      try {
        activateResult = await sandbox.run(wrapped.value, { filename: entryPath });
      } catch (err) {
        await sandbox.dispose();
        throw err;
      }
    }

    const record: ActivationRecord = {
      extensionId,
      activatedAt: this.now().toISOString(),
      permissions,
      grants,
      sandbox,
      activateResult,
    };
    this.active.set(extensionId, record);
    return record;
  }

  /**
   * Run the extension's `entry.deactivate` script (if any) and dispose
   * the sandbox. No-op for unknown ids.
   */
  async deactivateWithBundle(extensionId: string, bundle: Bundle): Promise<void> {
    const record = this.active.get(extensionId);
    if (!record) return;

    const entryPath = bundle.manifest.entry.deactivate;
    if (entryPath) {
      const file = bundle.files.get(entryPath);
      if (file) {
        const source = file.text ?? new TextDecoder().decode(file.bytes);
        const wrapped = wrapEntrySource(source, { entryFnName: 'deactivate', filename: entryPath });
        if (wrapped.ok) {
          const ctx: ExtensionContextV1 = { bim: this.sdk };
          await record.sandbox.setGlobal('__ifclite_ctx__', ctx);
          try {
            await record.sandbox.run(wrapped.value, { filename: entryPath });
          } catch {
            // We swallow deactivate errors so a misbehaving deactivate
            // cannot block unload. The sandbox dispose still runs.
          }
        }
      }
    }
    await this.deactivate(extensionId);
  }

  /**
   * Deactivate an extension. Disposes the underlying sandbox. No-op
   * for unknown ids.
   */
  async deactivate(extensionId: string): Promise<void> {
    const record = this.active.get(extensionId);
    if (!record) return;
    this.active.delete(extensionId);
    await record.sandbox.dispose();
  }

  /** True iff the extension has an active sandbox. */
  isActive(extensionId: string): boolean {
    return this.active.has(extensionId);
  }

  /** Snapshot of the current activation record, if any. */
  get(extensionId: string): ActivationRecord | undefined {
    return this.active.get(extensionId);
  }

  /** All active extension ids. */
  list(): string[] {
    return Array.from(this.active.keys());
  }

  /** Dispose every active extension. Used on flavor switch / shutdown. */
  async disposeAll(): Promise<void> {
    const ids = Array.from(this.active.keys());
    for (const id of ids) {
      await this.deactivate(id);
    }
  }
}
