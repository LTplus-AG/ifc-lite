/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Install / uninstall / enable-disable lifecycle for the extension
 * host, extracted from `host.ts`. The class methods delegate here so
 * the lifecycle logic — including rollback on failed updates — can be
 * read and tested as a unit.
 *
 * All functions take the host's primitives as a `deps` object and an
 * optional `notify` callback for emitting changes back to the host.
 */

import {
  sha256Hex,
  unpackBundle,
  type ActionIntent,
  type ActionParams,
  type ActivationDispatcher,
  type AuditLog,
  type Bundle,
  type ExtensionLoader,
  type ExtensionRuntime,
  type InstalledExtensionRecord,
  type LoadedExtensionStatus,
  type ValidationError,
  type ValidationResult,
} from '@ifc-lite/extensions';
import type { IdbExtensionStorage } from './idb-storage.js';

export interface ExtensionInstallSummary {
  id: string;
  version: string;
  bundleHash: string;
  capabilities: string[];
  bundle: Bundle;
}

export interface InstallerDeps {
  storage: IdbExtensionStorage;
  runtime: ExtensionRuntime;
  loader: ExtensionLoader;
  dispatcher: ActivationDispatcher;
  audit: AuditLog;
  emitAction: <K extends ActionIntent>(intent: K, params: ActionParams[K]) => void;
  emit: () => void;
}

export class ExtensionInstallError extends Error {
  readonly validationErrors: readonly ValidationError[];
  constructor(message: string, errors: readonly ValidationError[]) {
    super(message);
    this.name = 'ExtensionInstallError';
    this.validationErrors = errors;
  }
}

/** Inspect a `.iflx` byte string without installing it. */
export async function previewBundleBytes(
  bytes: Uint8Array,
): Promise<ValidationResult<ExtensionInstallSummary>> {
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
 * Install a previewed bundle. On failure, restore the previous install
 * (if any) so a bad update doesn't wipe a working extension.
 */
export async function installFromBytes(
  deps: InstallerDeps,
  bytes: Uint8Array,
  grantedCapabilities: string[],
): Promise<LoadedExtensionStatus> {
  const preview = await previewBundleBytes(bytes);
  if (!preview.ok) {
    throw new ExtensionInstallError('Bundle did not unpack', preview.errors);
  }
  const { bundle, bundleHash, id, version } = preview.value;

  // Callers can only grant capabilities the manifest declares. Drops
  // accidental grant escalation if the review screen pre-filled state
  // from an earlier version of the bundle.
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
  const previous = await deps.storage.getExtension(id);
  let previousBundleBytes: Uint8Array | undefined;
  if (previous && previous.version !== version) {
    previousBundleBytes = await deps.storage.getBundle(id, previous.version);
    await teardownExtension(deps, id);
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
  await deps.storage.putBundle(id, version, bytes);
  await deps.storage.putExtension(record);

  const status = await deps.loader.load(id);
  if (!status || !status.ok) {
    // Roll back. Delete the new bundle + record we just wrote.
    await deps.storage.deleteBundle(id, version);
    await deps.storage.deleteExtension(id);

    // Restore the previous install if we had one — re-write its
    // record and bundle bytes, then re-load. Best effort: log if
    // restore itself fails, don't mask the original error.
    if (previous && previousBundleBytes) {
      try {
        await deps.storage.putBundle(id, previous.version, previousBundleBytes);
        await deps.storage.putExtension(previous);
        await deps.loader.load(id);
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

  deps.audit.append({
    kind: previous ? 'update' : 'install',
    extensionId: id,
    version,
    previousVersion: previous?.version,
    grantedCapabilities,
  });
  deps.emitAction('extension.install', { id });

  // Re-fire onStartup so the freshly-loaded extension activates if it
  // declared the event. Other startup-subscribed extensions are
  // unaffected (the dispatcher dedupes activations per session).
  await deps.dispatcher.fire('onStartup');
  deps.emit();
  return status;
}

/** Uninstall an extension and remove its bundle. */
export async function uninstall(deps: InstallerDeps, id: string): Promise<void> {
  const record = await deps.storage.getExtension(id);
  if (!record) return;
  await teardownExtension(deps, id);
  // Delete bundle bytes too — the storage's cascade already handles
  // this on deleteExtension, but call it explicitly so the contract
  // is clear at this layer and a future storage impl can't drift.
  await deps.storage.deleteBundle(id, record.version);
  await deps.storage.deleteExtension(id);
  deps.audit.append({
    kind: 'uninstall',
    extensionId: id,
    version: record.version,
  });
  deps.emitAction('extension.uninstall', { id });
  deps.emit();
}

/** Enable/disable without uninstalling. */
export async function setEnabled(
  deps: InstallerDeps,
  id: string,
  enabled: boolean,
): Promise<void> {
  const record = await deps.storage.getExtension(id);
  if (!record) return;
  if (record.enabled === enabled) return;

  if (enabled) {
    // Persist enabled=true only after the loader confirms it can
    // bring the extension up. Without this, a failed load leaves the
    // persisted state lying about runtime reality.
    const tentative = { ...record, enabled: true };
    await deps.storage.putExtension(tentative);
    const status = await deps.loader.load(id);
    if (!status?.ok) {
      await deps.storage.putExtension(record);
      throw new ExtensionInstallError(
        `Failed to enable extension ${id}`,
        status?.errors ?? [],
      );
    }
  } else {
    await teardownExtension(deps, id);
    await deps.storage.putExtension({ ...record, enabled: false });
  }
  deps.audit.append({
    kind: enabled ? 'enable' : 'disable',
    extensionId: id,
    version: record.version,
  });
  deps.emitAction(enabled ? 'extension.enable' : 'extension.disable', { id });
  deps.emit();
}

/**
 * Tear an extension down: run its `entry.deactivate` hook (via the
 * loaded bundle), unload it, and clear the dispatcher's
 * "already activated" flag so a later enable / event re-fire genuinely
 * re-activates it. Used by update / uninstall / disable.
 */
async function teardownExtension(deps: InstallerDeps, id: string): Promise<void> {
  const bundle = deps.loader.getBundle(id);
  if (bundle) {
    await deps.runtime.deactivateWithBundle(id, bundle);
  } else {
    await deps.runtime.deactivate(id);
  }
  await deps.loader.unload(id);
  deps.dispatcher.resetActivation(id);
}
