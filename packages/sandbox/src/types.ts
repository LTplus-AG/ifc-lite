/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for @ifc-lite/sandbox
 */

/** Permission configuration — controls which SDK APIs are accessible */
export interface SandboxPermissions {
  /** Allow bim.model.* (model loading/management) */
  model?: boolean;
  /** Allow bim.query.* (entity queries) */
  query?: boolean;
  /** Allow bim.viewer.* (renderer control, colors, visibility) */
  viewer?: boolean;
  /** Allow bim.mutate.* (property editing) */
  mutate?: boolean;
  /** Allow bim.store.* (document-level edits — addEntity / removeEntity / positional attrs) */
  store?: boolean;
  /** Allow bim.lens.* (lens definitions) */
  lens?: boolean;
  /** Allow bim.export.* (data export) */
  export?: boolean;
  /** Allow bim.files.* (uploaded file access) */
  files?: boolean;
}

/** Resource limits for sandbox execution */
export interface SandboxLimits {
  /** Maximum heap memory in bytes (default: 64MB) */
  memoryBytes?: number;
  /** Maximum execution time in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Maximum stack size in bytes (default: 512KB) */
  maxStackBytes?: number;
}

/** Configuration for creating a sandbox */
export interface SandboxConfig {
  /** Permission configuration */
  permissions?: SandboxPermissions;
  /** Resource limits */
  limits?: SandboxLimits;
}

/** Result of script execution */
export interface ScriptResult {
  /** Return value (JSON-serializable) */
  value: unknown;
  /** Console output captured during execution */
  logs: LogEntry[];
  /** Execution time in milliseconds */
  durationMs: number;
}

/** A captured console log entry */
export interface LogEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  args: unknown[];
  timestamp: number;
}

/** Default permissions — read-only access */
export const DEFAULT_PERMISSIONS: Required<SandboxPermissions> = {
  model: true,
  query: true,
  viewer: true,
  mutate: false,    // Read-only by default
  store: false,     // Read-only by default — gates document-level edits
  lens: true,
  export: true,
  files: true,
};

/** Default resource limits */
export const DEFAULT_LIMITS: Required<SandboxLimits> = {
  memoryBytes: 64 * 1024 * 1024,     // 64 MB
  timeoutMs: 30_000,                   // 30 seconds
  maxStackBytes: 512 * 1024,           // 512 KB
};
