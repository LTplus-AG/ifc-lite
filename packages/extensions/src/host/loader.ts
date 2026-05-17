/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ExtensionLoader — composes storage, validation, slot registry, and
 * the activation dispatcher into a single host-side façade.
 *
 *   const loader = new ExtensionLoader({ storage, registry, dispatcher });
 *   await loader.loadAll();
 *   // ... user invokes a command
 *   await loader.dispatcher.fire('onCommand:ext.foo.bar');
 *
 * Responsibilities:
 *   1. Read installed records from storage.
 *   2. For each, fetch the bundle bytes, verify integrity, unpack,
 *      re-validate the manifest.
 *   3. Translate manifest contributions into slot registrations.
 *   4. Register activation events with the dispatcher.
 *
 * Failures per extension are captured in `LoadedExtensionStatus`,
 * never thrown. One broken extension does not prevent others from
 * loading.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §8
 * (lifecycle).
 */

import { unpackBundle } from '../bundle/iflx.js';
import { parseCapabilities } from '../capability/parse.js';
import { SlotRegistry } from '../slot-registry.js';
import { hexEqual, sha256Hex } from '../storage/hash.js';
import type {
  ExtensionStorage,
  InstalledExtensionRecord,
} from '../storage/types.js';
import type {
  Bundle,
  Capability,
  ManifestContributions,
  SlotContribution,
  ValidationError,
} from '../types.js';
import { ActivationDispatcher } from './activation.js';

export interface ExtensionLoaderOptions {
  storage: ExtensionStorage;
  registry: SlotRegistry;
  dispatcher: ActivationDispatcher;
}

export interface LoadedExtensionStatus {
  id: string;
  version: string;
  /** True iff the extension's bundle loaded, validated, and registered. */
  ok: boolean;
  /** The bundle, if `ok`. Otherwise undefined. */
  bundle?: Bundle;
  /** The installed-record snapshot used during load. */
  record: InstalledExtensionRecord;
  /** Parsed capability grants — only present on success. */
  grantedCapabilities?: Capability[];
  /** Per-load errors that prevented activation. Empty on success. */
  errors: ValidationError[];
}

export class ExtensionLoader {
  readonly storage: ExtensionStorage;
  readonly registry: SlotRegistry;
  readonly dispatcher: ActivationDispatcher;

  /** Bundles cached by id for the lifetime of the loader. */
  private bundleCache = new Map<string, Bundle>();

  constructor(opts: ExtensionLoaderOptions) {
    this.storage = opts.storage;
    this.registry = opts.registry;
    this.dispatcher = opts.dispatcher;
  }

  /** Load every installed extension. Returns a status per extension. */
  async loadAll(): Promise<LoadedExtensionStatus[]> {
    const records = await this.storage.listExtensions();
    const out: LoadedExtensionStatus[] = [];
    for (const record of records) {
      out.push(await this.loadRecord(record));
    }
    return out;
  }

  /** Load a single extension by id. Returns the status. */
  async load(id: string): Promise<LoadedExtensionStatus | undefined> {
    const record = await this.storage.getExtension(id);
    if (!record) return undefined;
    return this.loadRecord(record);
  }

  /**
   * Unload an extension: unregister contributions, unregister activation
   * events, drop the cached bundle. Does not delete from storage.
   */
  async unload(id: string): Promise<void> {
    this.registry.unregister(id);
    this.dispatcher.unregister(id);
    this.bundleCache.delete(id);
  }

  /** Retrieve a cached bundle. Returns undefined if not loaded. */
  getBundle(id: string): Bundle | undefined {
    return this.bundleCache.get(id);
  }

  private async loadRecord(
    record: InstalledExtensionRecord,
  ): Promise<LoadedExtensionStatus> {
    if (!record.enabled) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: [{
          path: '',
          code: 'invalid_value',
          message: `Extension ${record.id} is disabled.`,
        }],
      };
    }

    const bytes = await this.storage.getBundle(record.id, record.version);
    if (!bytes) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: [{
          path: '',
          code: 'invalid_reference',
          message: `Bundle for ${record.id}@${record.version} not found in storage.`,
        }],
      };
    }

    const actualHash = await sha256Hex(bytes);
    if (!hexEqual(actualHash, record.bundleHash)) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: [{
          path: '',
          code: 'invalid_format',
          message: `Bundle hash mismatch for ${record.id}@${record.version}. Expected ${record.bundleHash}, got ${actualHash}.`,
          hint: 'The stored bundle has been tampered with or was written with a different hash. Reinstall the extension.',
        }],
      };
    }

    const unpacked = unpackBundle(bytes);
    if (!unpacked.ok) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: unpacked.errors,
      };
    }
    const bundle = unpacked.value;

    if (bundle.manifest.id !== record.id) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: [{
          path: 'manifest.id',
          code: 'invalid_value',
          message: `Bundle manifest id "${bundle.manifest.id}" does not match record id "${record.id}".`,
        }],
      };
    }
    if (bundle.manifest.version !== record.version) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: [{
          path: 'manifest.version',
          code: 'invalid_value',
          message: `Bundle manifest version "${bundle.manifest.version}" does not match record version "${record.version}".`,
        }],
      };
    }

    // Parse granted capabilities; reject if any are malformed.
    const grants = parseCapabilities(record.grantedCapabilities);
    if (!grants.ok) {
      return {
        id: record.id,
        version: record.version,
        ok: false,
        record,
        errors: grants.errors,
      };
    }

    // Register contributions + activation events.
    this.registry.unregister(record.id);
    this.dispatcher.unregister(record.id);
    const contributions = manifestToContributions(record.id, bundle.manifest.contributes);
    if (contributions.length > 0) {
      this.registry.register(record.id, contributions);
    }
    this.dispatcher.register(record.id, bundle.manifest.activation);

    this.bundleCache.set(record.id, bundle);

    return {
      id: record.id,
      version: record.version,
      ok: true,
      bundle,
      record,
      grantedCapabilities: grants.value,
      errors: [],
    };
  }
}

/**
 * Translate a manifest's `contributes` block into a flat list of
 * `SlotContribution` values keyed by canonical slot id.
 *
 * Exported for tests; usually called by the loader.
 */
export function manifestToContributions(
  extensionId: string,
  contributes: ManifestContributions | undefined,
): SlotContribution[] {
  if (!contributes) return [];
  const out: SlotContribution[] = [];

  // Index commands by id so toolbar / contextMenu / keybinding payloads
  // can inherit the linked command's icon + title. Without this the
  // toolbar renderer never sees the icon the user picked — it lives on
  // CommandContribution, not on ToolbarContribution, and the slot
  // registry only ships the latter.
  const commandIndex = new Map(
    (contributes.commands ?? []).map((c) => [c.id, c]),
  );

  for (const c of contributes.commands ?? []) {
    out.push({ extensionId, slot: 'commandPalette', payload: c });
  }
  for (const t of contributes.toolbar ?? []) {
    const cmd = commandIndex.get(t.command);
    out.push({
      extensionId,
      slot: t.slot,
      payload: { ...t, icon: cmd?.icon, title: cmd?.title },
    });
  }
  for (const d of contributes.dock ?? []) {
    out.push({ extensionId, slot: d.slot, payload: d });
  }
  for (const m of contributes.contextMenu ?? []) {
    const cmd = commandIndex.get(m.command);
    out.push({
      extensionId,
      slot: m.slot,
      payload: { ...m, icon: cmd?.icon, title: cmd?.title },
    });
  }
  for (const k of contributes.keybindings ?? []) {
    out.push({ extensionId, slot: 'keybindings', payload: k });
  }
  for (const l of contributes.lenses ?? []) {
    out.push({ extensionId, slot: 'lensLibrary', payload: l });
  }
  for (const e of contributes.exporters ?? []) {
    out.push({ extensionId, slot: 'exportMenu', payload: e });
  }
  for (const v of contributes.idsValidators ?? []) {
    out.push({ extensionId, slot: 'idsRules.custom', payload: v });
  }
  for (const s of contributes.statusBar ?? []) {
    out.push({ extensionId, slot: s.slot, payload: s });
  }

  return out;
}
