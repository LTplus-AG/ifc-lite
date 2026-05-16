/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-memory `ExtensionStorage` implementation.
 *
 * Used by tests, by the headless eval harness, and by the CLI's
 * `ext` subcommands when no persistent storage is needed. Production
 * (browser) uses an IndexedDB-backed adapter in the viewer; desktop
 * uses a filesystem adapter; both implement the same interface.
 *
 * Concurrency: each method is synchronous internally but returns a
 * Promise to match the async contract. There is no real concurrency
 * here — the in-memory store is safe to share between awaited callers.
 */

import type { ExtensionStorage, InstalledExtensionRecord } from './types.js';

export class InMemoryExtensionStorage implements ExtensionStorage {
  private records = new Map<string, InstalledExtensionRecord>();
  private bundles = new Map<string, Uint8Array>();

  async putExtension(record: InstalledExtensionRecord): Promise<void> {
    // Defensive copy — callers must not be able to mutate stored data.
    this.records.set(record.id, deepClone(record));
  }

  async getExtension(id: string): Promise<InstalledExtensionRecord | undefined> {
    const r = this.records.get(id);
    return r ? deepClone(r) : undefined;
  }

  async listExtensions(): Promise<InstalledExtensionRecord[]> {
    return Array.from(this.records.values()).map(deepClone);
  }

  async deleteExtension(id: string): Promise<void> {
    this.records.delete(id);
    // Cascade: drop bundles tied to this extension.
    for (const key of Array.from(this.bundles.keys())) {
      if (key.startsWith(`${id}@`)) this.bundles.delete(key);
    }
  }

  async putBundle(id: string, version: string, bytes: Uint8Array): Promise<void> {
    this.bundles.set(bundleKey(id, version), new Uint8Array(bytes));
  }

  async getBundle(id: string, version: string): Promise<Uint8Array | undefined> {
    const bytes = this.bundles.get(bundleKey(id, version));
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  async deleteBundle(id: string, version: string): Promise<void> {
    this.bundles.delete(bundleKey(id, version));
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.bundles.clear();
  }
}

function bundleKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function deepClone<T>(value: T): T {
  // Records are plain JSON-shaped; structuredClone is fine. We intentionally
  // do not use JSON parse/stringify to preserve Uint8Array if ever embedded.
  return structuredClone(value);
}
