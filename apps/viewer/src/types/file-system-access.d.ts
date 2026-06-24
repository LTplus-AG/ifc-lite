/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File System Access API surface that TypeScript's bundled `lib.dom` (TS 6.0.3)
 * does not yet declare. `FileSystemHandle` / `FileSystemFileHandle.getFile()`
 * already ship in lib.dom, but `Window.showOpenFilePicker`, its options, and the
 * Chromium permission probes (`queryPermission` / `requestPermission`) are
 * missing. These are global augmentations (no imports/exports → ambient scope),
 * so they merge with the existing lib.dom interfaces.
 *
 * Used by `services/file-system-access.ts` to capture a live file handle on open
 * and re-read it on demand (the "Refresh" action).
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  /** Chromium-only: current permission state without prompting. */
  queryPermission?(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  /** Chromium-only: prompt for permission (must run in a user gesture). */
  requestPermission?(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string | string[]>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
  id?: string;
  startIn?:
    | FileSystemHandle
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'music'
    | 'pictures'
    | 'videos';
}

interface Window {
  showOpenFilePicker?(
    options?: OpenFilePickerOptions,
  ): Promise<FileSystemFileHandle[]>;
}

interface DataTransferItem {
  /** Chromium-only: live handle for a dropped file (call synchronously in `drop`). */
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}
