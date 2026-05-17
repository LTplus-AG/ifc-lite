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
  ActionLog,
  ActivationDispatcher,
  AuditLog,
  CANONICAL_FIXTURES,
  ExtensionLoader,
  ExtensionRuntime,
  IdleMineScheduler,
  SlotRegistry,
  filterAgainstInstalled,
  parseCapabilities,
  planFromPattern,
  revalidateAgainstSdk,
  runBundleTests,
  syntheticFixtureLoader,
  type ActionIntent,
  type ActionParams,
  type AuthoringPlan,
  type InstalledExtensionRecord,
  type LoadedExtensionStatus,
  type MinedPattern,
  type MineEvent,
  type RevalidationSummary,
  type RuntimeRunResult,
  type SlotContribution,
  type SlotListener,
  type TestRunSummary,
  type ValidationResult,
} from '@ifc-lite/extensions';
import type { BimContext } from '@ifc-lite/sdk';
import { IdbExtensionStorage } from './idb-storage.js';
import { IdbLogStorage } from './idb-log-storage.js';
import { createBimSandboxFactory } from './sandbox-factory.js';
import { FlavorService } from './flavor-service.js';
import { runExtensionCommand } from './host-commands.js';
import {
  ExtensionInstallError,
  installFromBytes,
  previewBundleBytes,
  setEnabled,
  uninstall,
  type ExtensionInstallSummary,
} from './host-installer.js';

export { ExtensionInstallError } from './host-installer.js';
export type { ExtensionInstallSummary } from './host-installer.js';

export interface ExtensionHostServiceOptions {
  sdk: BimContext;
}

export class ExtensionHostService {
  readonly storage = new IdbExtensionStorage();
  readonly slotRegistry = new SlotRegistry();
  readonly dispatcher = new ActivationDispatcher();
  readonly audit = new AuditLog();
  readonly flavors = new FlavorService({
    // Mirror flavor lifecycle into the action log so the miner sees
    // activate/export/import patterns. Content-free — only the id.
    onLifecycle: (event, id) => {
      if (event === 'activate') this.emitAction('flavor.activate', { id: id ?? '' });
      else if (event === 'export') this.emitAction('flavor.export', {});
      else if (event === 'import') this.emitAction('flavor.import', {});
    },
  });
  readonly actionLog = new ActionLog();
  private readonly logStorage = new IdbLogStorage();
  readonly miner: IdleMineScheduler;
  readonly runtime: ExtensionRuntime;
  readonly loader: ExtensionLoader;
  private suggestions: MineEvent | undefined;
  private suggestionListeners = new Set<(event: MineEvent) => void>();
  readonly sdk: BimContext;

  private initialized = false;
  private listeners = new Set<() => void>();

  constructor(opts: ExtensionHostServiceOptions) {
    this.sdk = opts.sdk;
    this.runtime = new ExtensionRuntime({
      factory: createBimSandboxFactory({ sdk: opts.sdk }),
      sdk: opts.sdk,
      // Spec defaults per RFC §02.5: 64 MiB heap, 5 s sync CPU, 1 MiB
      // stack. The sandbox enforces these via QuickJS setMemoryLimit /
      // setMaxStackSize / setInterruptHandler. Tighter dry-run budgets
      // come from `buildDryRunBudget` when the authoring loop spins up
      // a transient runtime.
      defaultLimits: {
        memoryBytes: 64 * 1024 * 1024,
        timeoutMs: 5_000,
        maxStackBytes: 1 * 1024 * 1024,
      },
    });
    this.loader = new ExtensionLoader({
      storage: this.storage,
      registry: this.slotRegistry,
      dispatcher: this.dispatcher,
    });

    this.miner = new IdleMineScheduler();
    // Pipe every logged action into the miner so the idle timer
    // re-arms as the user works. Also queue for IDB persistence so
    // the log survives reload.
    this.actionLog.subscribe((event) => {
      this.miner.push(event);
      this.logStorage.appendAction(event);
    });
    // Mirror audit events to IDB so the audit history survives a
    // reload too — otherwise "Audit log" misleads users.
    this.audit.subscribe((event) => {
      this.logStorage.appendAudit(event);
    });
    // When the miner fires, filter against currently-installed tools
    // and notify listeners. The filter call is async (it reads
    // storage); store the most recent event so late subscribers can
    // still see the latest suggestions.
    this.miner.subscribe((event) => {
      void this.handleMineEvent(event);
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
      // Hydrate logs from IDB before any new events fire so the
      // resumed seq counters start where we left off. Errors here are
      // non-fatal — we just continue with empty in-memory logs.
      try {
        const [priorActions, priorAudit] = await Promise.all([
          this.logStorage.loadActions(),
          this.logStorage.loadAudit(),
        ]);
        this.actionLog.hydrate(priorActions);
        this.audit.hydrate(priorAudit);
      } catch (err) {
        console.warn('[ext-host] log hydration failed; starting empty:', err);
      }

      const statuses = await this.loader.loadAll();
      // Seed a baseline flavor on first run so the Flavors dialog
      // never opens to an empty state. Existing users keep whatever
      // they had — we only create the Default if the library is empty.
      try {
        const existing = await this.flavors.list();
        if (existing.length === 0) {
          await this.flavors.resetToDefaults();
        } else {
          // Make sure SOMETHING is active so Capture / activate UI has
          // a target. Falls back to the first flavor if no pointer.
          const active = await this.flavors.getActive();
          if (!active) await this.flavors.activate(existing[0].id);
        }
      } catch (err) {
        console.warn('[ext-host] baseline flavor seed failed:', err);
      }
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
  /** Inspect a `.iflx` byte string without installing it. */
  previewBundle(bytes: Uint8Array): Promise<ValidationResult<ExtensionInstallSummary>> {
    return previewBundleBytes(bytes);
  }

  /**
   * Install a previewed bundle. Delegates to the lifecycle helpers in
   * `host-installer.ts`. `grantedCapabilities` is the user-approved
   * subset of `bundle.manifest.capabilities` from the review screen.
   */
  installFromBytes(
    bytes: Uint8Array,
    grantedCapabilities: string[],
  ): Promise<LoadedExtensionStatus> {
    return installFromBytes(this.installerDeps(), bytes, grantedCapabilities);
  }

  /** Uninstall an extension and remove its bundle. */
  uninstall(id: string): Promise<void> {
    return uninstall(this.installerDeps(), id);
  }

  /** Enable/disable without uninstalling. */
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return setEnabled(this.installerDeps(), id, enabled);
  }

  /** Bundle the host primitives the installer needs. */
  private installerDeps() {
    return {
      storage: this.storage,
      runtime: this.runtime,
      loader: this.loader,
      dispatcher: this.dispatcher,
      audit: this.audit,
      emitAction: <K extends ActionIntent>(intent: K, params: ActionParams[K]) => this.emitAction(intent, params),
      emit: () => this.emit(),
    };
  }

  /**
   * Dispatch an extension command. Finds the owning extension,
   * activates it if needed, loads the handler source from the bundle,
   * wraps it, injects `__ifclite_ctx__`, and runs.
   *
   * Implementation lives in `host-commands.ts` — this method is a
   * thin delegator that injects the host's primitives.
   */
  runCommand(commandId: string): Promise<RuntimeRunResult | undefined> {
    return runExtensionCommand(
      {
        storage: this.storage,
        loader: this.loader,
        runtime: this.runtime,
        dispatcher: this.dispatcher,
        sdk: this.sdk,
      },
      commandId,
    );
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

  /**
   * Log a user-level action. Viewer slices call this from their
   * reducers / sagas so the action log mirrors the user's intents
   * for the pattern miner.
   *
   * Content-free metadata only — see `ActionParams` for the schema.
   */
  emitAction<K extends ActionIntent>(intent: K, params: ActionParams[K]): void {
    this.actionLog.append({ intent, params });
  }

  /** Subscribe to mine results (already filtered against installs). */
  onSuggestions(listener: (event: MineEvent) => void): () => void {
    this.suggestionListeners.add(listener);
    // Surface the most recent event immediately so late subscribers
    // (panels that mount after a mine fired) don't miss it.
    if (this.suggestions) {
      try {
        listener(this.suggestions);
      } catch (err) {
        console.error('[ext-host] Suggestion listener threw on replay:', err);
      }
    }
    return () => {
      this.suggestionListeners.delete(listener);
    };
  }

  /** Read the last mine result, if any. */
  getSuggestions(): MineEvent | undefined {
    return this.suggestions;
  }

  /** Wipe the IDB-persisted action log. Pairs with `actionLog.clear()`. */
  async clearPersistedActionLog(): Promise<void> {
    await this.logStorage.clearActions();
  }

  /** Wipe the IDB-persisted audit log. Pairs with `audit.clear()`. */
  async clearPersistedAuditLog(): Promise<void> {
    await this.logStorage.clearAudit();
  }

  /**
   * Build an `AuthoringPlan` stub from a mined pattern. The UI hands
   * the stub off to the chat panel as the seed for an authoring turn.
   */
  acceptSuggestion(pattern: MinedPattern): AuthoringPlan {
    return planFromPattern(pattern);
  }

  /**
   * Run an installed extension's declared tests against its bundle.
   * Throws if the extension is not installed or its bundle is missing.
   */
  async runTests(id: string): Promise<TestRunSummary> {
    const record = await this.storage.getExtension(id);
    if (!record) throw new Error(`No installed extension with id "${id}".`);
    const bundle = this.loader.getBundle(id);
    if (!bundle) throw new Error(`Bundle for ${id} not loaded.`);
    const grants = parseCapabilities(record.grantedCapabilities);
    if (!grants.ok) {
      throw new Error(`Stored capabilities for ${id} are invalid.`);
    }
    return runBundleTests({
      runtime: this.runtime,
      bundle,
      grants: grants.value,
      // Plug the canonical synthetic fixtures so tests declaring
      // `fixture: "residential-small"` get a working ctx.bim. Hosts
      // that ship their own fixture loader can override via a
      // custom factory.
      loadFixture: syntheticFixtureLoader(CANONICAL_FIXTURES),
    });
  }

  /**
   * Switch to the named flavor, enabling its declared extensions and
   * disabling anything the previous flavor had that this one doesn't.
   * Returns the structured switch result so the UI can surface
   * failures inline.
   */
  async switchFlavor(targetId: string): Promise<void> {
    const flavors = await this.flavors.list();
    const target = flavors.find((f) => f.id === targetId);
    if (!target) throw new Error(`Unknown flavor: ${targetId}`);
    const records = await this.storage.listExtensions();
    const installed = records.map((r) => ({ id: r.id, enabled: r.enabled }));

    const result = await this.flavors.switchTo(target, installed, {
      setEnabled: async (id, enabled) => {
        await this.setEnabled(id, enabled);
      },
      deactivate: async (id) => {
        await this.runtime.deactivate(id);
        await this.loader.unload(id);
      },
      reload: async (id) => {
        const status = await this.loader.load(id);
        return !!status?.ok;
      },
      setActiveFlavor: async (id) => {
        await this.flavors.activate(id);
      },
    });

    if (!result.ok) {
      throw new Error(
        `Flavor switch failed for: ${result.failures.join(', ')}`,
      );
    }
    this.emit();
  }

  /**
   * Re-run every installed extension's tests against the supplied SDK
   * version. The result feeds the repair queue UI: outdated or
   * permissive ranges with failing tests land in `needsRepair`.
   */
  async revalidateForSdk(sdkVersion: string): Promise<RevalidationSummary> {
    const records = await this.storage.listExtensions();
    const installed = records.map((rec) => {
      const grants = parseCapabilities(rec.grantedCapabilities);
      const bundle = this.loader.getBundle(rec.id);
      return {
        id: rec.id,
        engines: { ifcLiteSdk: bundle?.manifest.engines.ifcLiteSdk ?? '*' },
        grants: grants.ok ? grants.value : [],
      };
    });
    return revalidateAgainstSdk({
      sdk: sdkVersion,
      installed,
      resolveBundle: (id) => this.loader.getBundle(id),
      runtime: this.runtime,
    });
  }

  /** Tear down everything. Called on flavor switch / sign-out. */
  async dispose(): Promise<void> {
    this.miner.dispose();
    this.suggestionListeners.clear();
    this.suggestions = undefined;
    await this.runtime.disposeAll();
    for (const id of this.dispatcher.listExtensions()) {
      this.dispatcher.unregister(id);
    }
    this.slotRegistry.clear();
    this.listeners.clear();
    this.initialized = false;
  }

  private async handleMineEvent(event: MineEvent): Promise<void> {
    let filtered = event.patterns;
    try {
      const installed = await this.storage.listExtensions();
      filtered = filterAgainstInstalled(
        event.patterns,
        installed.map((ext) => ({
          id: ext.id,
          grantedCapabilities: ext.grantedCapabilities,
        })),
      );
    } catch (err) {
      // If storage fails we still surface the unfiltered patterns —
      // worst case the user sees a "you already have this" duplicate.
      console.warn('[ext-host] filterAgainstInstalled failed; surfacing raw patterns:', err);
    }
    const next: MineEvent = { ...event, patterns: filtered };
    this.suggestions = next;
    for (const listener of this.suggestionListeners) {
      try {
        listener(next);
      } catch (err) {
        console.error('[ext-host] Suggestion listener threw:', err);
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

