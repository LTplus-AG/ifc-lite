/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionHostService` — viewer-side façade that composes the
 * `@ifc-lite/extensions` building blocks into a single coordinated
 * service.
 *
 *   storage       IDB-backed persistence
 *   slotRegistry  In-memory pub/sub for UI contributions
 *   dispatcher    Activation event dispatcher
 *   runtime       Per-extension sandbox lifecycle
 *   audit         Append-only audit log
 *   loader        Glue that reads storage + registers contributions
 *
 * The host service is the single object the React layer consumes via
 * `<ExtensionHostProvider>`. It exposes high-level operations
 * (install, uninstall, enable/disable, listExtensions, importBundle,
 * exportBundle, subscribeSlot) so UI code never reaches into the
 * underlying primitives directly.
 *
 * Lifecycle:
 *   1. Construct with a `BimContext`.
 *   2. Call `init()` once at app startup. It loads installed bundles,
 *      validates them, registers contributions, and fires `onStartup`.
 *   3. Call `installFromBytes(bytes, grants)` when the user imports a
 *      `.iflx` file. The capability review screen calls this after
 *      the user approves.
 *   4. Call `uninstall(id)` to remove.
 */

import {
  ActivationDispatcher,
  AuditLog,
  ExtensionLoader,
  ExtensionRuntime,
  SlotRegistry,
  parseCapabilities,
  sha256Hex,
  unpackBundle,
  type Bundle,
  type InstalledExtensionRecord,
  type LoadedExtensionStatus,
  type SlotContribution,
  type SlotListener,
  type ValidationError,
  type ValidationResult,
} from '@ifc-lite/extensions';
import type { BimContext } from '@ifc-lite/sdk';
import { IdbExtensionStorage } from './idb-storage.js';
import { createBimSandboxFactory } from './sandbox-factory.js';

export interface ExtensionHostServiceOptions {
  sdk: BimContext;
}

export interface ExtensionInstallSummary {
  id: string;
  version: string;
  bundleHash: string;
  capabilities: string[];
  bundle: Bundle;
}

export class ExtensionHostService {
  readonly storage = new IdbExtensionStorage();
  readonly slotRegistry = new SlotRegistry();
  readonly dispatcher = new ActivationDispatcher();
  readonly audit = new AuditLog();
  readonly runtime: ExtensionRuntime;
  readonly loader: ExtensionLoader;
  readonly sdk: BimContext;

  private initialized = false;
  private listeners = new Set<() => void>();

  constructor(opts: ExtensionHostServiceOptions) {
    this.sdk = opts.sdk;
    this.runtime = new ExtensionRuntime({
      factory: createBimSandboxFactory({ sdk: opts.sdk }),
      sdk: opts.sdk,
    });
    this.loader = new ExtensionLoader({
      storage: this.storage,
      registry: this.slotRegistry,
      dispatcher: this.dispatcher,
    });

    this.dispatcher.onActivate(async (id) => {
      const record = await this.storage.getExtension(id);
      if (!record) return;
      const grants = parseCapabilities(record.grantedCapabilities);
      if (!grants.ok) {
        console.warn(`[ext-host] Skipping activation of ${id}: invalid stored capabilities.`);
        return;
      }
      const bundle = this.loader.getBundle(id);
      try {
        await this.runtime.activate(id, grants.value, bundle);
        this.audit.append({
          kind: 'activate',
          extensionId: id,
          version: record.version,
        });
      } catch (err) {
        console.error(`[ext-host] Activation of ${id} failed:`, err);
        this.audit.append({
          kind: 'unhealthy',
          extensionId: id,
          version: record.version,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  async init(): Promise<LoadedExtensionStatus[]> {
    if (this.initialized) return [];
    // Only set initialized after startup succeeds — otherwise a failed
    // loadAll() / fire() leaves the service stuck and later init()
    // calls return [] without actually loading anything.
    try {
      const statuses = await this.loader.loadAll();
      await this.dispatcher.fire('onStartup');
      this.initialized = true;
      this.emit();
      return statuses;
    } catch (err) {
      this.initialized = false;
      throw err;
    }
  }

  /** Inspect a `.iflx` byte string without installing it. */
  async previewBundle(bytes: Uint8Array): Promise<ValidationResult<ExtensionInstallSummary>> {
    const unpacked = unpackBundle(bytes);
    if (!unpacked.ok) return unpacked;
    const hash = await sha256Hex(bytes);
    return {
      ok: true,
      value: {
        id: unpacked.value.manifest.id,
        version: unpacked.value.manifest.version,
        bundleHash: hash,
        capabilities: unpacked.value.manifest.capabilities,
        bundle: unpacked.value,
      },
    };
  }

  /**
   * Install a previewed bundle. `grantedCapabilities` is the user-
   * approved subset of `bundle.manifest.capabilities` from the review
   * screen.
   */
  async installFromBytes(
    bytes: Uint8Array,
    grantedCapabilities: string[],
  ): Promise<LoadedExtensionStatus> {
    const preview = await this.previewBundle(bytes);
    if (!preview.ok) {
      throw new ExtensionInstallError('Bundle did not unpack', preview.errors);
    }
    const { bundle, bundleHash, id, version } = preview.value;

    // Validate: callers can only grant capabilities the manifest
    // actually declares. Drops accidental grant escalation if the
    // review screen pre-filled state from an earlier version of the
    // bundle.
    const declaredCaps = new Set(bundle.manifest.capabilities);
    const unexpected = grantedCapabilities.filter((cap) => !declaredCaps.has(cap));
    if (unexpected.length > 0) {
      throw new ExtensionInstallError(
        `Unexpected capability grants not declared by manifest: ${unexpected.join(', ')}`,
        unexpected.map((cap) => ({
          path: 'grantedCapabilities',
          code: 'invalid_capability' as const,
          message: `Capability "${cap}" was not requested by the bundle manifest.`,
        })),
      );
    }

    // Snapshot the previous install so we can restore it if the new
    // bundle fails to load. Without this, a bad update wipes the
    // user's previously-working install entirely.
    const previous = await this.storage.getExtension(id);
    let previousBundleBytes: Uint8Array | undefined;
    if (previous && previous.version !== version) {
      previousBundleBytes = await this.storage.getBundle(id, previous.version);
      await this.runtime.deactivate(id);
      await this.loader.unload(id);
    }

    const record: InstalledExtensionRecord = {
      id,
      version,
      bundleHash,
      grantedCapabilities,
      enabled: true,
      installedAt: new Date().toISOString(),
      source: 'local',
    };
    await this.storage.putBundle(id, version, bytes);
    await this.storage.putExtension(record);

    const status = await this.loader.load(id);
    if (!status || !status.ok) {
      // Roll back. Delete the new bundle + record we just wrote.
      await this.storage.deleteBundle(id, version);
      await this.storage.deleteExtension(id);

      // Restore the previous install if we had one — re-write its
      // record and bundle bytes, then re-load. Best effort: log if
      // restore itself fails, don't mask the original error.
      if (previous && previousBundleBytes) {
        try {
          await this.storage.putBundle(id, previous.version, previousBundleBytes);
          await this.storage.putExtension(previous);
          await this.loader.load(id);
        } catch (restoreErr) {
          console.error(
            `[ext-host] Failed to restore previous install of ${id}:`,
            restoreErr,
          );
        }
      }
      throw new ExtensionInstallError(
        'Loader rejected the new bundle',
        status?.errors ?? [],
      );
    }

    this.audit.append({
      kind: previous ? 'update' : 'install',
      extensionId: id,
      version,
      previousVersion: previous?.version,
      grantedCapabilities,
    });

    // Re-fire onStartup so the freshly-loaded extension activates if it
    // declared the event. Other startup-subscribed extensions are
    // unaffected (the dispatcher dedupes activations per session).
    await this.dispatcher.fire('onStartup');
    this.emit();
    return status;
  }

  /** Uninstall an extension and remove its bundle. */
  async uninstall(id: string): Promise<void> {
    const record = await this.storage.getExtension(id);
    if (!record) return;
    await this.runtime.deactivate(id);
    await this.loader.unload(id);
    // Delete bundle bytes too — the storage's cascade already handles
    // this on deleteExtension, but call it explicitly so the contract
    // is clear at this layer and a future storage impl can't drift.
    await this.storage.deleteBundle(id, record.version);
    await this.storage.deleteExtension(id);
    this.audit.append({
      kind: 'uninstall',
      extensionId: id,
      version: record.version,
    });
    this.emit();
  }

  /** Enable/disable without uninstalling. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = await this.storage.getExtension(id);
    if (!record) return;
    if (record.enabled === enabled) return;

    if (enabled) {
      // Persist enabled=true only after the loader confirms it can
      // bring the extension up. Without this, a failed load leaves the
      // persisted state lying about runtime reality.
      const tentative = { ...record, enabled: true };
      await this.storage.putExtension(tentative);
      const status = await this.loader.load(id);
      if (!status?.ok) {
        await this.storage.putExtension(record);
        throw new ExtensionInstallError(
          `Failed to enable extension ${id}`,
          status?.errors ?? [],
        );
      }
    } else {
      await this.runtime.deactivate(id);
      await this.loader.unload(id);
      await this.storage.putExtension({ ...record, enabled: false });
    }
    this.audit.append({
      kind: enabled ? 'enable' : 'disable',
      extensionId: id,
      version: record.version,
    });
    this.emit();
  }

  /** Read the current install state (storage snapshot). */
  async listInstalled(): Promise<InstalledExtensionRecord[]> {
    return this.storage.listExtensions();
  }

  /** Subscribe to a slot. Forwards to the underlying registry. */
  subscribeSlot<T = unknown>(slot: string, listener: SlotListener<T>): () => void {
    return this.slotRegistry.subscribe(slot, listener);
  }

  getSlotContributions<T = unknown>(slot: string): SlotContribution<T>[] {
    return this.slotRegistry.getAll<T>(slot);
  }

  /** Subscribe to "anything changed" pulses for UI state. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tear down everything. Called on flavor switch / sign-out. */
  async dispose(): Promise<void> {
    await this.runtime.disposeAll();
    for (const id of this.dispatcher.listExtensions()) {
      this.dispatcher.unregister(id);
    }
    this.slotRegistry.clear();
    this.listeners.clear();
    this.initialized = false;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export class ExtensionInstallError extends Error {
  readonly validationErrors: readonly ValidationError[];
  constructor(message: string, errors: readonly ValidationError[]) {
    super(message);
    this.name = 'ExtensionInstallError';
    this.validationErrors = errors;
  }
}
