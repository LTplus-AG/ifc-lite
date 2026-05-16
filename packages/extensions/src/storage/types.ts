/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storage types — installed extension records and bundle blobs.
 *
 * The `ExtensionStorage` interface is host-agnostic. The viewer wraps
 * IndexedDB behind it; tests use the in-memory implementation in
 * `./memory.ts`; the desktop app will eventually plug in a filesystem
 * adapter.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md
 * §1 (FlavorExtension shape), and the implicit per-extension record
 * shape used by the loader.
 */

/** Per-install metadata for an extension. */
export interface InstalledExtensionRecord {
  /** Manifest id. Primary key for the `extensions` store. */
  id: string;
  /** SemVer of the installed bundle. */
  version: string;
  /** sha256 hex of the bundle bytes. Used for integrity verification. */
  bundleHash: string;
  /** Raw capability strings the user granted at install time. */
  grantedCapabilities: string[];
  /** Whether the extension is currently enabled. */
  enabled: boolean;
  /** ISO timestamp of install. */
  installedAt: string;
  /** ISO timestamp of last activation. Updated by the activation dispatcher. */
  lastActivatedAt?: string;
  /** Provenance. Local means user / AI / hand-installed; registry is reserved for Phase 4+. */
  source: 'local' | 'registry' | 'url';
  /** User config the extension persisted (form values etc.). */
  config?: Record<string, unknown>;
}

/** Storage abstraction. */
export interface ExtensionStorage {
  // ----- extension records
  putExtension(record: InstalledExtensionRecord): Promise<void>;
  getExtension(id: string): Promise<InstalledExtensionRecord | undefined>;
  listExtensions(): Promise<InstalledExtensionRecord[]>;
  deleteExtension(id: string): Promise<void>;

  // ----- bundle bytes (one bundle per id+version)
  putBundle(id: string, version: string, bytes: Uint8Array): Promise<void>;
  getBundle(id: string, version: string): Promise<Uint8Array | undefined>;
  deleteBundle(id: string, version: string): Promise<void>;

  // ----- lifecycle
  /** Best-effort transactional reset. Tests use this; production never should. */
  clear(): Promise<void>;
}
