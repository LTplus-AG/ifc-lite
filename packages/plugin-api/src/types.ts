/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// File-source plugin API — the stable contract between host and provider.
//
// This package is dependency-free. Plugins import only from here; they never
// touch the DOM, the store, or any app-internal module.
// ============================================================================

// ---------------------------------------------------------------------------
// Plugin manifest (Raycast-style)
// ---------------------------------------------------------------------------

export interface PluginManifest {
  /** Kebab-case slug, unique across all providers. */
  readonly name: string;
  /** Human-readable display title. */
  readonly title: string;
  /** Optional icon shown by the host when listing providers. */
  readonly iconUrl?: string;
  /** Semver range the host must satisfy (e.g. `"^1.0.0"`). */
  readonly api: string;
  /** Allowed outbound domains. The host's fetch wrapper enforces this. */
  readonly permissions: PluginPermissions;
  /** Declarative preferences — the host auto-generates the settings UI. */
  readonly preferences: PluginPreference[];
  /** Contribution points. */
  readonly contributes: PluginContributions;
}

export interface PluginPermissions {
  /** Domains the provider may contact (e.g. `["field.dalux.com"]`). */
  readonly network: readonly string[];
}

export interface PluginContributions {
  /** Relative paths to the provider entry modules. */
  readonly fileSources: readonly string[];
}

// ---------------------------------------------------------------------------
// Preferences schema (host-rendered settings modal)
// ---------------------------------------------------------------------------

export type PluginPreferenceType = 'textfield' | 'password' | 'checkbox' | 'dropdown';

export interface PluginPreference {
  /** Machine key stored in the host's secret/config storage. */
  readonly name: string;
  /** Human-readable label for the settings UI. */
  readonly title: string;
  /** Optional longer description shown below the field. */
  readonly description?: string;
  readonly type: PluginPreferenceType;
  readonly required: boolean;
  /** Default value (for checkbox: `"true"` / `"false"`). */
  readonly default?: string;
  /** For `dropdown` type only — the available choices. */
  readonly options?: readonly DropdownOption[];
}

export interface DropdownOption {
  readonly label: string;
  readonly value: string;
}

// ---------------------------------------------------------------------------
// Plugin context — injected by the host at runtime
// ---------------------------------------------------------------------------

export interface PluginContext {
  /**
   * Host-injected fetch. For hosts whose API lacks CORS headers, the host may
   * rewrite the request to a same-origin path that its own server forwards
   * upstream (see the app's proxy config), and may add auth headers depending
   * on the provider's manifest and user configuration. Plugins must use this
   * instead of global `fetch`.
   */
  readonly fetch: typeof fetch;
  /** Retrieve a preference value (secret or plain). */
  getPreference(name: string): Promise<string | undefined>;
  /** Namespaced key-value store (backed by localStorage in the reference host; treat values as user-revocable, not securely encrypted). */
  readonly storage: KeyValueStore;
  readonly log: Logger;
}

export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Domain model — projects, containers, files, revisions
// ---------------------------------------------------------------------------

export interface SourceProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Provider-specific metadata the host passes through opaquely. */
  readonly meta?: Record<string, unknown>;
}

export interface SourceContainer {
  readonly id: string;
  readonly name: string;
  /** Parent container id, or `undefined` for root-level containers. */
  readonly parentId?: string;
  readonly meta?: Record<string, unknown>;
}

export interface SourceFile {
  readonly id: string;
  readonly name: string;
  readonly containerId: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly currentRevisionId: string;
  readonly revisions: readonly SourceRevision[];
  readonly meta?: Record<string, unknown>;
}

export interface SourceRevision {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly sizeBytes?: number;
}

export interface RevisionEvent {
  readonly fileId: string;
  readonly latestRevisionId: string;
  readonly previousRevisionId?: string;
}

// ---------------------------------------------------------------------------
// File-source filter
// ---------------------------------------------------------------------------

export interface FileFilter {
  /** Glob patterns for file names (e.g. `["*.ifc"]`). */
  readonly namePatterns?: readonly string[];
  /** MIME types to include. */
  readonly mimeTypes?: readonly string[];
}

// ---------------------------------------------------------------------------
// FileSourceProvider — the core interface plugins implement
// ---------------------------------------------------------------------------

export interface FileSourceProvider {
  readonly manifest: PluginManifest;

  /** List projects visible to the authenticated identity. */
  listProjects(ctx: PluginContext): Promise<SourceProject[]>;

  /**
   * List containers (file areas, folders) within a project.
   * @param parentId - Optional. When provided, scope results to the direct
   * descendants of this container (e.g. pass a file area's id to fetch just
   * its folders). When omitted, return only the top-level containers (e.g.
   * file areas) — cheap, so hosts can show that list before walking deeper.
   */
  listContainers(ctx: PluginContext, projectId: string, parentId?: string): Promise<SourceContainer[]>;

  /** List files in a container, optionally filtered. */
  listFiles(ctx: PluginContext, containerId: string, filter?: FileFilter): Promise<SourceFile[]>;

  /** Download file content. If `revisionId` is omitted, downloads the latest. */
  download(ctx: PluginContext, fileId: string, revisionId?: string): Promise<ArrayBuffer>;

  /** Optional: check for new revisions of tracked files (cheap polling). */
  checkRevisions?(ctx: PluginContext, fileIds: string[]): Promise<RevisionEvent[]>;

  /** Optional: test the connection and return a diagnostic message. */
  testConnection?(ctx: PluginContext): Promise<ConnectionTestResult>;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
  /** Number of accessible projects (sanity check). */
  readonly projectCount?: number;
}

// ---------------------------------------------------------------------------
// Source tag — metadata attached to federated models loaded from a provider
// ---------------------------------------------------------------------------

export interface SourceTag {
  readonly provider: string;
  readonly projectId: string;
  readonly containerId: string;
  readonly fileId: string;
  readonly revisionId: string;
  readonly loadedAt: number;
}
