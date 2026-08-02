/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider-agnostic cloud storage abstraction. Each provider (Dropbox today;
 * Google Drive / OneDrive next) implements `CloudProvider`, and the importer UI
 * + loader work against this interface only. A provider's job ends at producing
 * a `File`; the existing `addModel()`/`loadFile()` pipeline takes over from
 * there, so adding a provider never touches the parser.
 */

export interface CloudFileEntry {
  /** Stable provider id for the item. */
  id: string;
  /** Display name (e.g. `Tower.ifc`). */
  name: string;
  /** Provider path used for subsequent list/download calls. */
  path: string;
  /** Size in bytes (0 for folders / unknown). */
  size: number;
  isFolder: boolean;
  /** Last-modified epoch ms, or null when unknown. */
  modifiedMs: number | null;
  /**
   * Informational, non-navigable row (e.g. "SharePoint needs a work or
   * school account"). Rendered inert by the dialog — no click handler, no
   * folder/file affordance. Providers use this to explain a degraded
   * capability instead of silently omitting it or throwing.
   */
  disabled?: boolean;
}

export type CloudDownloadProgress = (loaded: number, total: number | null) => void;

export interface CloudProvider {
  /** Stable id, e.g. `'dropbox'`. */
  readonly id: string;
  /** Human label for buttons/menus. */
  readonly label: string;

  /** Best-effort hint (from local storage) of whether a connection exists. */
  isConnected(): boolean;

  /** Run the OAuth consent flow. Resolves once the connection is established. */
  connect(): Promise<void>;

  /** Revoke the local connection. */
  disconnect(): Promise<void>;

  /** List a folder (root when `path === ''`). Folders sort before files. */
  listFolder(path: string): Promise<CloudFileEntry[]>;

  /** Download a file's bytes and wrap them in a `File` for the loader. */
  download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File>;
}

/** Raised when the user has no live connection to a provider (re-connect required). */
export class CloudNotConnectedError extends Error {
  constructor(readonly providerId: string) {
    super(`Not connected to ${providerId}`);
    this.name = 'CloudNotConnectedError';
  }
}

/** Extensions the cloud importer surfaces. Mirrors the IFC subset of the toolbar. */
export const CLOUD_IMPORT_EXTENSIONS = ['.ifc', '.ifcx'] as const;

export function isSupportedCloudFile(name: string): boolean {
  const lower = name.toLowerCase();
  return CLOUD_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
