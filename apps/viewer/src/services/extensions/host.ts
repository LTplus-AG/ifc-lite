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
    this.initialized = true;
    const statuses = await this.loader.loadAll();
    await this.dispatcher.fire('onStartup');
    this.emit();
    return statuses;
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

    const previous = await this.storage.getExtension(id);
    if (previous && previous.version !== version) {
      // Update path: deactivate the previous bundle before swapping.
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
    if (!status) {
      throw new ExtensionInstallError('Loader returned no status for newly-installed extension', []);
    }
    if (!status.ok) {
      // Roll back if the loader rejected our freshly-written record.
      await this.storage.deleteExtension(id);
      await this.storage.deleteBundle(id, version);
      throw new ExtensionInstallError('Loader rejected the new bundle', status.errors);
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
    // Use the bundle from the install summary to ensure the in-memory
    // structure is the one the caller can reference for a review pane.
    void bundle;
    return status;
  }

  /** Uninstall an extension and remove its bundle. */
  async uninstall(id: string): Promise<void> {
    const record = await this.storage.getExtension(id);
    if (!record) return;
    await this.runtime.deactivate(id);
    await this.loader.unload(id);
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
    await this.storage.putExtension({ ...record, enabled });
    if (enabled) {
      await this.loader.load(id);
    } else {
      await this.runtime.deactivate(id);
      await this.loader.unload(id);
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
