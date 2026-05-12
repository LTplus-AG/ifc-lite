/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient type declarations for Tauri-only modules.
 * These packages are only available at runtime in desktop (Tauri) builds
 * and are not installed in the web viewer's node_modules.
 */

declare module '@tauri-apps/plugin-fs' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
  export function writeTextFile(path: string, data: string): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readTextFile(path: string): Promise<string>;
  export function exists(path: string): Promise<boolean>;
  export function remove(path: string): Promise<void>;
  export function readDir(path: string): Promise<Array<{ name: string | null }>>;
  export function stat(path: string): Promise<{ size: number; mtime?: number | null }>;
}

declare module '@tauri-apps/api/path' {
  export function appDataDir(): Promise<string>;
  export function join(...paths: string[]): Promise<string>;
}

declare module '@tauri-apps/api/core' {
  /**
   * Tauri's IPC entry point. Generic by command name.
   */
  export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare module '@tauri-apps/plugin-dialog' {
  export interface OpenDialogOptions {
    title?: string;
    multiple?: boolean;
    directory?: boolean;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }
  export interface SaveDialogOptions {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }
  export function open(options?: OpenDialogOptions): Promise<string | string[] | null>;
  export function save(options?: SaveDialogOptions): Promise<string | null>;
}
