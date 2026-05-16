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

import type { Capability } from '../types.js';
import type { SandboxPermissionsLike } from './permissions.js';
import { capabilitiesToPermissions } from './permissions.js';

/**
 * A live sandbox handle the runtime hands back to callers. The exact
 * implementation lives in the host (browser viewer wraps QuickJS;
 * tests use the in-memory stub).
 */
export interface RuntimeSandboxHandle {
  /** Dispose the underlying sandbox and free its resources. */
  dispose(): Promise<void> | void;
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
}

export interface ExtensionRuntimeOptions {
  factory: RuntimeSandboxFactory;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
  /**
   * Default resource limits applied to every extension. The host may
   * tighten per-extension via settings; the spec calls out a default of
   * 64 MiB memory, 5s sync CPU, 30s async window.
   */
  defaultLimits?: RuntimeSandboxCreateOptions['limits'];
}

export class ExtensionRuntime {
  private active = new Map<string, ActivationRecord>();
  private readonly factory: RuntimeSandboxFactory;
  private readonly now: () => Date;
  private readonly defaultLimits: RuntimeSandboxCreateOptions['limits'];

  constructor(opts: ExtensionRuntimeOptions) {
    this.factory = opts.factory;
    this.now = opts.now ?? (() => new Date());
    this.defaultLimits = opts.defaultLimits;
  }

  /**
   * Activate an extension. Creates a sandbox with permissions derived
   * from the granted capabilities. Idempotent — if the extension is
   * already active, returns the existing record.
   *
   * Note: this does NOT yet evaluate the extension's `entry.activate`
   * script. That requires a calling-convention design that is its own
   * piece of work; this runtime exposes the sandbox handle so callers
   * can drive script evaluation when ready.
   */
  async activate(
    extensionId: string,
    grants: readonly Capability[],
  ): Promise<ActivationRecord> {
    const existing = this.active.get(extensionId);
    if (existing) return existing;

    const permissions = capabilitiesToPermissions(grants);
    const sandbox = await this.factory.create({
      extensionId,
      permissions,
      limits: this.defaultLimits,
    });

    const record: ActivationRecord = {
      extensionId,
      activatedAt: this.now().toISOString(),
      permissions,
      grants,
      sandbox,
    };
    this.active.set(extensionId, record);
    return record;
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
